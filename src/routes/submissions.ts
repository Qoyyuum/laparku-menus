import { eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { getDb } from "../db/client";
import { SOURCE_TYPES, submissions, submitters, type Submitter } from "../db/schema";
import type { Env } from "../env";
import { MAX_FILE_BYTES, MAX_FILES, SNIFFED_MIME, sniffMagic, type SniffedFileType } from "../lib/files";
import { verifyTurnstile } from "../lib/turnstile";

type AppContext = Context<{ Bindings: Env }>;

// TODO(Task 8): replace this stub with the real better-auth session lookup.
// Returning null keeps `manual_entry` behind a 401 until auth lands — the
// spec requires an authenticated session for text-only submissions.
async function getSession(_c: AppContext): Promise<{ userId: string; email?: string } | null> {
  return null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const submissionsApi = new Hono<{ Bindings: Env }>();

// POST /api/submissions — public multipart intake. Fields: `files[]`/`files`
// (jpeg/png/webp/pdf), `source_type`, `provenance`, `turnstile_token` (web),
// optional `email`.
submissionsApi.post("/submissions", async (c) => {
  let form: FormData;
  try {
    // undici-types (via @types/bun) and workers-types disagree on the FormData
    // global; the runtime object is the same, so normalize through unknown.
    form = (await c.req.raw.formData()) as unknown as FormData;
  } catch {
    return c.json({ error: "expected multipart/form-data" }, 400);
  }

  // Honeypot: real users never fill `website`; bots do.
  if (str(form.get("website"))) return c.json({ error: "rejected" }, 400);

  // Turnstile (web only): skipped when the secret isn't configured (dev) and
  // for native app clients — they can't run the web widget, send
  // X-Laparku-Client: app instead, and get tighter edge rate limits.
  const isAppClient = c.req.header("X-Laparku-Client") === "app";
  if (c.env.TURNSTILE_SECRET_KEY && !isAppClient) {
    const token = str(form.get("turnstile_token"));
    const ok = token
      ? await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, token, c.req.header("CF-Connecting-IP"))
      : false;
    if (!ok) return c.json({ error: "turnstile verification failed" }, 403);
  }

  const sourceType = str(form.get("source_type"));
  if (!sourceType || !(SOURCE_TYPES as readonly string[]).includes(sourceType)) {
    return c.json({ error: "invalid source_type", allowed: SOURCE_TYPES }, 400);
  }
  if (sourceType === "manual_entry") {
    return c.json({ error: "manual_entry submissions go to POST /api/submissions/manual" }, 400);
  }
  const provenance = str(form.get("provenance"));
  if (!provenance) return c.json({ error: "provenance is required" }, 400);

  const files = [...form.getAll("files"), ...form.getAll("files[]")].filter(
    (v): v is File => typeof v === "object" && v !== null && typeof (v as File).arrayBuffer === "function",
  );
  if (files.length > MAX_FILES) return c.json({ error: `too many files (max ${MAX_FILES})` }, 400);
  // `url` submissions declare the link itself in `provenance`; every other
  // source type must carry at least one file.
  if (files.length === 0 && sourceType !== "url") {
    return c.json({ error: "at least one file is required" }, 400);
  }

  const email = str(form.get("email"));
  const db = getDb(c.env);

  // Size cap first (declared size, before reading into memory), then magic
  // bytes decide the real type. All validation finishes before any DB write.
  const id = crypto.randomUUID();
  const blobs: Uint8Array<ArrayBuffer>[] = [];
  const types: SniffedFileType[] = [];
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      return c.json({ error: `file too large (max ${MAX_FILE_BYTES} bytes)` }, 400);
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    const type = sniffMagic(bytes);
    if (!type) {
      return c.json({ error: "unsupported file type (jpeg/png/webp/pdf only)" }, 400);
    }
    blobs.push(bytes);
    types.push(type);
  }

  // Anonymous by default; `email` ties the submission to a submitter record
  // (created on first use) so reputation + blocking work for anonymous users.
  let submitter: Submitter | undefined;
  if (email) {
    const [existing] = await db.select().from(submitters).where(eq(submitters.identifier, email)).limit(1);
    submitter = existing ?? (await db.insert(submitters).values({ identifier: email, trust_tier: "anonymous" }).returning())[0];
    if (submitter?.blocked) return c.json({ error: "submitter is blocked" }, 403);
  }

  // Exact-byte dedup across the whole submission payload: a second identical
  // submission is flagged dup_sha256 (sorted last in review), not merged.
  const autoFlags: string[] = [];
  let sha256: string | null = null;
  if (blobs.length > 0) {
    const all = new Uint8Array(blobs.reduce((n, b) => n + b.length, 0));
    let offset = 0;
    for (const b of blobs) {
      all.set(b, offset);
      offset += b.length;
    }
    sha256 = await sha256Hex(all);
    const [dup] = await db.select({ id: submissions.id }).from(submissions).where(eq(submissions.sha256, sha256)).limit(1);
    if (dup) autoFlags.push("dup_sha256");
  }

  const imageKeys: string[] = [];
  for (let i = 0; i < blobs.length; i++) {
    const key = `submissions/${id}/${i}`;
    await c.env.SUBMISSIONS.put(key, blobs[i]!, { httpMetadata: { contentType: SNIFFED_MIME[types[i]!] } });
    imageKeys.push(key);
  }

  await db.insert(submissions).values({
    id,
    submitter_id: submitter?.id ?? null,
    contact: email ?? null,
    source_type: sourceType as (typeof SOURCE_TYPES)[number],
    provenance,
    image_keys: imageKeys,
    sha256,
    auto_flags: autoFlags,
    status: "pending",
  });
  if (submitter) {
    await db
      .update(submitters)
      .set({ submissions_count: sql`${submitters.submissions_count} + 1` })
      .where(eq(submitters.id, submitter.id));
  }

  await c.env.SUBMISSION_QUEUE.send({ submissionId: id });
  return c.json({ id }, 201);
});

// POST /api/submissions/manual — text-only entry. Requires an authenticated
// session (stubbed → always 401 until Task 8 wires better-auth).
submissionsApi.post("/submissions/manual", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "authentication required for manual_entry" }, 401);

  let body: { source_type?: unknown; provenance?: unknown; contact?: unknown; items?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "expected JSON body" }, 400);
  }
  if (body.source_type !== "manual_entry") {
    return c.json({ error: "source_type must be manual_entry" }, 400);
  }
  const provenance = typeof body.provenance === "string" ? body.provenance.trim() : "";
  if (!provenance) return c.json({ error: "provenance is required" }, 400);
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ error: "items must be a non-empty array" }, 400);
  }
  const contact = typeof body.contact === "string" && body.contact.trim() !== "" ? body.contact.trim() : null;

  const db = getDb(c.env);
  // Authed submitter keyed on auth_user_id — created on first submission.
  let [submitter] = await db.select().from(submitters).where(eq(submitters.auth_user_id, session.userId)).limit(1);
  submitter ??= (await db.insert(submitters).values({ auth_user_id: session.userId }).returning())[0];
  if (!submitter) return c.json({ error: "could not resolve submitter" }, 500);
  if (submitter.blocked) return c.json({ error: "submitter is blocked" }, 403);

  const id = crypto.randomUUID();
  await db.insert(submissions).values({
    id,
    submitter_id: submitter.id,
    contact,
    source_type: "manual_entry",
    provenance,
    image_keys: [],
    raw_extraction: { items: body.items },
    auto_flags: [],
    status: "pending",
  });
  await db
    .update(submitters)
    .set({ submissions_count: sql`${submitters.submissions_count} + 1` })
    .where(eq(submitters.id, submitter.id));

  await c.env.SUBMISSION_QUEUE.send({ submissionId: id });
  return c.json({ id }, 201);
});

export default submissionsApi;
