import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/client";
import { SUBMISSION_STATUSES, submissions, submitters } from "../db/schema";
import type { Env } from "../env";
import { PublishError, publishSubmission, rejectSubmission, type PublishEdits } from "../lib/publish";
import { requireAuth, type AuthVariables } from "../middleware/auth";

const REVIEW_ROLES = ["reviewer", "admin"];
// Review queue page size — reviewers work small batches.
const LIMIT = 100;

const adminApi = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Every route under /api/admin requires a reviewer-or-admin session.
adminApi.use("*", requireAuth(REVIEW_ROLES));

// Guarded-route smoke check (used by test/auth.test.ts to exercise the guard).
adminApi.get("/ping", (c) => c.json({ ok: true }));

// GET /api/admin/submissions?status=pending_review — the review queue.
// Ordered so the best leads surface first: trusted submitters before new
// before anonymous, then extractor confidence DESC (NULL confidence sinks),
// then oldest first inside a tier.
adminApi.get("/submissions", async (c) => {
  const status = c.req.query("status") ?? "pending_review";
  if (!(SUBMISSION_STATUSES as readonly string[]).includes(status)) {
    return c.json({ error: "invalid status", allowed: SUBMISSION_STATUSES }, 400);
  }
  const trustWeight = sql`CASE ${submitters.trust_tier} WHEN 'trusted' THEN 2 WHEN 'new' THEN 1 ELSE 0 END`;
  const rows = await getDb(c.env)
    .select({ submission: submissions, submitter_trust_tier: submitters.trust_tier })
    .from(submissions)
    .leftJoin(submitters, eq(submissions.submitter_id, submitters.id))
    .where(and(eq(submissions.status, status as (typeof SUBMISSION_STATUSES)[number])))
    .orderBy(desc(trustWeight), desc(submissions.confidence), asc(submissions.created_at))
    .limit(LIMIT);
  return c.json({
    submissions: rows.map((r) => ({ ...r.submission, submitter_trust_tier: r.submitter_trust_tier })),
  });
});

// GET /api/admin/submissions/:id — full detail for the side-by-side review
// screen: the raw extraction draft, provenance, flags, and R2 image keys.
adminApi.get("/submissions/:id", async (c) => {
  const db = getDb(c.env);
  const [row] = await db
    .select({ submission: submissions, submitter_trust_tier: submitters.trust_tier })
    .from(submissions)
    .leftJoin(submitters, eq(submissions.submitter_id, submitters.id))
    .where(eq(submissions.id, c.req.param("id")))
    .limit(1);
  if (!row) return c.json({ error: "submission not found" }, 404);
  return c.json({ submission: { ...row.submission, submitter_trust_tier: row.submitter_trust_tier } });
});

// GET /api/admin/images/* — the ONLY way source images leave R2 (they are
// never public). The key is the rest of the path after /images/ because R2
// keys like `submissions/<id>/<n>` contain slashes.
adminApi.get("/images/*", async (c) => {
  const marker = "/images/";
  const idx = c.req.path.indexOf(marker);
  let key = "";
  try {
    key = decodeURIComponent(idx === -1 ? "" : c.req.path.slice(idx + marker.length));
  } catch {
    // malformed percent-encoding — falls through to the 400 below
  }
  // Prefix-allowlist plus traversal/structure guards — a key that isn't a
  // submissions upload must never be fetchable through this route.
  if (
    !key.startsWith("submissions/") ||
    key.includes("..") ||
    key.includes("\\") ||
    key.includes("//") ||
    key.length > 512 ||
    !/^[\w./-]+$/.test(key)
  ) {
    return c.json({ error: "invalid image key" }, 400);
  }
  const object = await c.env.SUBMISSIONS.get(key);
  if (!object) return c.json({ error: "not found" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      // Reviewer-only material: keep it out of shared caches and off disk.
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

// POST /api/admin/submissions/:id/approve — publish the reviewer-edited
// draft. Body: { venue_id?: string; venue?: VenueDraft; items: DraftItem[] }.
adminApi.post("/submissions/:id/approve", async (c) => {
  let body: PublishEdits;
  try {
    body = (await c.req.json()) as PublishEdits;
  } catch {
    return c.json({ error: "expected JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null) {
    return c.json({ error: "expected JSON body" }, 400);
  }
  const reviewer = c.get("user");
  try {
    const result = await publishSubmission(getDb(c.env), c.req.param("id"), reviewer.id, body);
    return c.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof PublishError) return c.json({ error: e.message }, e.status as 400);
    throw e;
  }
});

// POST /api/admin/submissions/:id/reject — body { reason }.
adminApi.post("/submissions/:id/reject", async (c) => {
  let body: { reason?: unknown };
  try {
    body = (await c.req.json()) as { reason?: unknown };
  } catch {
    return c.json({ error: "expected JSON body" }, 400);
  }
  const reviewer = c.get("user");
  try {
    await rejectSubmission(
      getDb(c.env),
      c.req.param("id"),
      reviewer.id,
      typeof body?.reason === "string" ? body.reason : "",
    );
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof PublishError) return c.json({ error: e.message }, e.status as 400);
    throw e;
  }
});

export default adminApi;
