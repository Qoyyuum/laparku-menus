import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getDb, type Db } from "../db/client";
import { SOURCE_TYPES, submissions, submitters, type Submitter } from "../db/schema";
import type { Env } from "../env";
import { MAX_FILE_BYTES, MAX_FILES, SNIFFED_MIME, sniffMagic } from "../lib/files";
import { verifyTurnstile } from "../lib/turnstile";
import { requireAuth, type AuthVariables } from "../middleware/auth";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- shared intake internals ----------------------------------------------
// These are the Task-6 validation/processing paths. Both HTTP routes below
// and the MCP submit_menu tool (src/mcp.ts) call them — the surfaces only
// differ in how they authenticate and how bytes arrive.

export interface IntakeResult {
  status: number;
  body: Record<string, unknown>;
}

// File bytes without a storage copy: `size` is known up front (declared or
// actual), `bytes()` is called at most once per file so a legal multi-file
// request never holds every payload in memory at once.
export interface IntakeFile {
  size: number;
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
}

// Submitter resolution shared by all intake paths: `authUserId` (session or
// verified API key → submitters.auth_user_id) takes precedence; `email` is
// the anonymous path (submitters.identifier). Returns the row, or an
// IntakeResult early-exit (blocked submitter).
async function resolveSubmitter(
  db: Db,
  { authUserId, email }: { authUserId?: string; email?: string },
): Promise<{ submitter?: Submitter; error?: IntakeResult }> {
  let submitter: Submitter | undefined;
  if (authUserId) {
    const [existing] = await db.select().from(submitters).where(eq(submitters.auth_user_id, authUserId)).limit(1);
    submitter = existing ?? (await db.insert(submitters).values({ auth_user_id: authUserId }).returning())[0];
  } else if (email) {
    const [existing] = await db.select().from(submitters).where(eq(submitters.identifier, email)).limit(1);
    submitter = existing ?? (await db.insert(submitters).values({ identifier: email, trust_tier: "anonymous" }).returning())[0];
  }
  if (submitter?.blocked) {
    return { error: { status: 403, body: { error: "submitter is blocked" } } };
  }
  return { submitter };
}

async function bumpSubmitterCount(db: Db, submitter: Submitter): Promise<void> {
  await db
    .update(submitters)
    .set({ submissions_count: sql`${submitters.submissions_count} + 1` })
    .where(eq(submitters.id, submitter.id));
}

// File-bearing intake (menu_pdf/menu_photo/product_photo/barcode/url).
// Validation order matches the original POST /api/submissions handler:
// source_type → provenance → counts → sizes → submitter → sniff/store →
// dedup → insert → queue.
export async function intakeFileSubmission(
  env: Env,
  input: { sourceType: string; provenance: string; email?: string; authUserId?: string; files: IntakeFile[] },
): Promise<IntakeResult> {
  const { sourceType, provenance, email, authUserId, files } = input;
  if (!sourceType || !(SOURCE_TYPES as readonly string[]).includes(sourceType)) {
    return { status: 400, body: { error: "invalid source_type", allowed: SOURCE_TYPES } };
  }
  if (sourceType === "manual_entry") {
    return { status: 400, body: { error: "manual_entry submissions go to POST /api/submissions/manual" } };
  }
  if (!provenance) return { status: 400, body: { error: "provenance is required" } };

  if (files.length > MAX_FILES) return { status: 400, body: { error: `too many files (max ${MAX_FILES})` } };
  // `url` submissions declare the link itself in `provenance`; every other
  // source type must carry at least one file.
  if (files.length === 0 && sourceType !== "url") {
    return { status: 400, body: { error: "at least one file is required" } };
  }

  // Declared-size cap up front (no reads yet) so oversized uploads are
  // rejected before a submitter row or R2 object can be created.
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      return { status: 400, body: { error: `file too large (max ${MAX_FILE_BYTES} bytes)` } };
    }
  }

  const db = getDb(env);

  // Every caller is authenticated (session at the HTTP routes, API key at
  // MCP), so `authUserId` ties the submission to the better-auth user and is
  // always set in practice. `email` survives only as the optional `contact`
  // field; the v1 anonymous-submitter path remains for safety.
  const { submitter, error } = await resolveSubmitter(db, { authUserId, email });
  if (error) return error;

  // Process each file exactly once — read → magic-byte sniff → R2 → per-file
  // sha256 — then drop the reference. A legal 10×8MB request never holds more
  // than ~8MB of our copies at a time (formData() itself buffers the request
  // body, which is unavoidable at this layer). Note: a mid-list magic-byte
  // failure can leave earlier files in R2 without a DB row — harmless orphans,
  // same trade-off as any streamed upload.
  const id = crypto.randomUUID();
  const imageKeys: string[] = [];
  const fileDigests = new Uint8Array(files.length * 32);
  for (let i = 0; i < files.length; i++) {
    const bytes = await files[i]!.bytes();
    const type = sniffMagic(bytes);
    if (!type) {
      return { status: 400, body: { error: "unsupported file type (jpeg/png/webp/pdf only)" } };
    }
    const key = `submissions/${id}/${i}`;
    await env.SUBMISSIONS.put(key, bytes, { httpMetadata: { contentType: SNIFFED_MIME[type] } });
    imageKeys.push(key);
    fileDigests.set(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), i * 32);
  }

  // Exact-byte dedup: sha256 of the concatenated per-file digests — identical
  // "same bytes twice" semantics as hashing the payload, using ~320 bytes
  // instead of a second ~80MB concatenation. A second identical submission is
  // flagged dup_sha256 (sorted last in review), not merged.
  const autoFlags: string[] = [];
  let sha256: string | null = null;
  if (files.length > 0) {
    sha256 = await sha256Hex(fileDigests);
    const [dup] = await db.select({ id: submissions.id }).from(submissions).where(eq(submissions.sha256, sha256)).limit(1);
    if (dup) autoFlags.push("dup_sha256");
  }

  await db.insert(submissions).values({
    id,
    submitter_id: submitter?.id ?? null,
    // Phase 2: the authenticated identity (session user or API-key owner)
    // is recorded on every new row. v1 anonymous rows keep user_id NULL.
    user_id: authUserId ?? null,
    contact: email ?? null,
    source_type: sourceType as (typeof SOURCE_TYPES)[number],
    provenance,
    image_keys: imageKeys,
    sha256,
    auto_flags: autoFlags,
    status: "pending",
  });
  if (submitter) await bumpSubmitterCount(db, submitter);

  await env.SUBMISSION_QUEUE.send({ submissionId: id });
  return { status: 201, body: { id } };
}

// Text-only manual_entry intake. Validation mirrors POST
// /api/submissions/manual: provenance + non-empty items required, submitter
// resolved by auth_user_id, blocked submitters rejected.
export async function intakeManualSubmission(
  env: Env,
  input: { authUserId: string; provenance: string; contact: string | null; items: unknown },
): Promise<IntakeResult> {
  const provenance = typeof input.provenance === "string" ? input.provenance.trim() : "";
  if (!provenance) return { status: 400, body: { error: "provenance is required" } };
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return { status: 400, body: { error: "items must be a non-empty array" } };
  }

  const db = getDb(env);
  const { submitter, error } = await resolveSubmitter(db, { authUserId: input.authUserId });
  if (error) return error;
  if (!submitter) return { status: 500, body: { error: "could not resolve submitter" } };

  const id = crypto.randomUUID();
  await db.insert(submissions).values({
    id,
    submitter_id: submitter.id,
    user_id: input.authUserId,
    contact: input.contact,
    source_type: "manual_entry",
    provenance,
    image_keys: [],
    raw_extraction: { items: input.items },
    auto_flags: [],
    status: "pending",
  });
  await bumpSubmitterCount(db, submitter);

  await env.SUBMISSION_QUEUE.send({ submissionId: id });
  return { status: 201, body: { id } };
}

// --- routes ---------------------------------------------------------------

const submissionsApi = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Phase 2: both submission routes require a session — any authenticated
// role may submit. Anonymous uploads (allowed in v1) now get 401 before any
// validation runs; banned users get 403. The X-Laparku-Client header is
// still only a rate-limit signal, never an auth substitute.
const SUBMIT_ROLES = ["submitter", "reviewer", "admin"];

// POST /api/submissions — authenticated multipart intake. Fields:
// `files[]`/`files` (jpeg/png/webp/pdf), `source_type`, `provenance`,
// `turnstile_token` (web), optional `email`.
submissionsApi.post("/submissions", requireAuth(SUBMIT_ROLES), async (c) => {
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

  const files = [...form.getAll("files"), ...form.getAll("files[]")].filter(
    (v): v is File => typeof v === "object" && v !== null && typeof (v as File).arrayBuffer === "function",
  );

  const result = await intakeFileSubmission(c.env, {
    sourceType: str(form.get("source_type")) ?? "",
    provenance: str(form.get("provenance")) ?? "",
    email: str(form.get("email")),
    authUserId: c.get("user").id,
    files: files.map((f) => ({ size: f.size, bytes: async () => new Uint8Array(await f.arrayBuffer()) })),
  });
  return c.json(result.body, result.status as ContentfulStatusCode);
});

// POST /api/submissions/manual — text-only entry. Requires an authenticated
// session (requireAuth since phase 2 — was an inline getSession check in v1).
submissionsApi.post("/submissions/manual", requireAuth(SUBMIT_ROLES), async (c) => {
  let body: { source_type?: unknown; provenance?: unknown; contact?: unknown; items?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "expected JSON body" }, 400);
  }
  if (body.source_type !== "manual_entry") {
    return c.json({ error: "source_type must be manual_entry" }, 400);
  }
  const contact = typeof body.contact === "string" && body.contact.trim() !== "" ? body.contact.trim() : null;

  const result = await intakeManualSubmission(c.env, {
    authUserId: c.get("user").id,
    provenance: typeof body.provenance === "string" ? body.provenance : "",
    contact,
    items: body.items,
  });
  return c.json(result.body, result.status as ContentfulStatusCode);
});

export default submissionsApi;
