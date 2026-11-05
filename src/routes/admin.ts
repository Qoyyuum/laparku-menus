import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/client";
import {
  food_items,
  item_flags,
  product_lookup_cache,
  SUBMISSION_STATUSES,
  submissions,
  submitters,
  user_badges,
  venues,
} from "../db/schema";
import type { Env } from "../env";
import { BADGES } from "../lib/badges";
import { listStaleVenues } from "../lib/freshness";
import { notifyUnpublished } from "../lib/notify";
import { normalizeBarcode } from "../lib/product-lookup";
import { PublishError, publishSubmission, rejectSubmission, type PublishEdits } from "../lib/publish";
import { reindexAll, unindex } from "../lib/search-index";
import { requireAuth, type AuthVariables } from "../middleware/auth";

const REVIEW_ROLES = ["reviewer", "admin"];
// Review queue page size — reviewers work small batches.
const LIMIT = 100;
const FLAG_STATUSES = ["open", "resolved"] as const;

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

// GET /api/admin/flags?status=open — post-publish item reports. Joined with
// the item + venue so reviewers see what was flagged without a second hop.
// Oldest first, same FIFO discipline as the review queue.
adminApi.get("/flags", async (c) => {
  const status = c.req.query("status") ?? "open";
  if (!(FLAG_STATUSES as readonly string[]).includes(status)) {
    return c.json({ error: "invalid status", allowed: FLAG_STATUSES }, 400);
  }
  const rows = await getDb(c.env)
    .select({
      flag: item_flags,
      item_name: food_items.name,
      venue_id: food_items.venue_id,
      venue_name: venues.name,
    })
    .from(item_flags)
    .innerJoin(food_items, eq(item_flags.item_id, food_items.id))
    .innerJoin(venues, eq(food_items.venue_id, venues.id))
    .where(eq(item_flags.status, status as (typeof FLAG_STATUSES)[number]))
    .orderBy(asc(item_flags.created_at))
    .limit(LIMIT);
  return c.json({
    flags: rows.map((r) => ({
      ...r.flag,
      item_name: r.item_name,
      venue_id: r.venue_id,
      venue_name: r.venue_name,
    })),
  });
});

// POST /api/admin/flags/:id/resolve — mark an open flag resolved. The
// conditional update claims the flag (like the submission decisions) so a
// double-resolve is a 409, not a silent no-op.
adminApi.post("/flags/:id/resolve", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const claimed = await db
    .update(item_flags)
    .set({ status: "resolved" })
    .where(and(eq(item_flags.id, id), eq(item_flags.status, "open")))
    .returning({ id: item_flags.id });
  if (claimed.length === 0) {
    const [flag] = await db
      .select({ status: item_flags.status })
      .from(item_flags)
      .where(eq(item_flags.id, id))
      .limit(1);
    if (!flag) return c.json({ error: "flag not found" }, 404);
    return c.json({ error: `flag is already ${flag.status}` }, 409);
  }
  return c.json({ ok: true });
});

// Cache codes a stored barcode could be filed under — the canonical code
// plus its UPC-E expansion candidate (the same keys the lookup chain and
// the trusted-publish gate resolve through). Non-digit codes (Code 128 /
// QR payloads) pass through as-is.
function lookupKeys(barcode: string | null): string[] {
  if (!barcode) return [];
  return normalizeBarcode(barcode)?.candidates ?? [barcode];
}

// GET /api/admin/pending-verification — the reviewer double-check queue
// (spec §6): trusted-published items still carrying the badge, newest
// first. Each row carries the venue, the source submission (with the
// submitter's trust tier), the lookup-chain payload that prefilled the
// item (product_lookup_cache.merged_payload + per-provider sources), and
// the fields the submitter changed relative to that payload (overrides) —
// the lookup-vs-submitted delta is exactly what the reviewer is checking.
adminApi.get("/pending-verification", async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({
      item: food_items,
      venue_name: venues.name,
      submission: submissions,
      submitter_trust_tier: submitters.trust_tier,
    })
    .from(food_items)
    .innerJoin(venues, eq(food_items.venue_id, venues.id))
    .leftJoin(submissions, eq(food_items.source_submission_id, submissions.id))
    .leftJoin(submitters, eq(submissions.submitter_id, submitters.id))
    .where(and(eq(food_items.pending_verification, true), eq(food_items.is_current, true)))
    .orderBy(desc(food_items.created_at))
    .limit(LIMIT);

  // Provenance join can't go through SQL — cache codes are the barcode's
  // normalized candidates, computed in JS — so the cache rows are fetched
  // in one chunked IN query and mapped back per item.
  const keys = [...new Set(rows.flatMap((r) => lookupKeys(r.item.barcode)))];
  const cache = new Map<string, typeof product_lookup_cache.$inferSelect>();
  for (let off = 0; off < keys.length; off += 90) {
    const hits = await db
      .select()
      .from(product_lookup_cache)
      .where(inArray(product_lookup_cache.code, keys.slice(off, off + 90)));
    for (const h of hits) cache.set(h.code, h);
  }

  return c.json({
    items: rows.map((r) => {
      const lookup = lookupKeys(r.item.barcode)
        .map((k) => cache.get(k))
        .filter((h): h is NonNullable<typeof h> => h !== undefined)
        .map((h) => ({
          code: h.code,
          merged_payload: h.merged_payload,
          sources: h.sources,
          found: h.found,
          fetched_at: h.fetched_at,
        }));
      // The first cache row's merged payload is the answer the lookup
      // chain produced; any live field differing from it is a submitter
      // override the reviewer should see highlighted.
      const merged = lookup[0]?.merged_payload;
      const overrides: Record<string, { lookup: unknown; submitted: unknown }> = {};
      if (merged) {
        for (const field of ["name", "brand", "package_size"] as const) {
          const submitted = r.item[field];
          if (submitted != null && submitted !== merged[field]) {
            overrides[field] = { lookup: merged[field] ?? null, submitted };
          }
        }
      }
      return {
        ...r.item,
        venue_name: r.venue_name,
        submission: r.submission
          ? { ...r.submission, submitter_trust_tier: r.submitter_trust_tier }
          : null,
        lookup,
        overrides,
      };
    }),
  });
});

// POST /api/admin/items/:id/verify — the reviewer checked the item against
// its lookup payload: clear the badge. Optional body { verify_nutrition:
// true } also flips nutrition_estimate.status to "verified" — the estimate
// only graduates when a human asked for it. Idempotent: an item whose badge
// is already cleared returns 200, so a double-tap or a second reviewer is
// never an error.
adminApi.post("/items/:id/verify", async (c) => {
  let body: { verify_nutrition?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    // Bodyless POSTs are fine — everything about verify has a default.
  }
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [item] = await db.select().from(food_items).where(eq(food_items.id, id)).limit(1);
  if (!item) return c.json({ error: "item not found" }, 404);
  if (!item.pending_verification) return c.json({ ok: true, already_verified: true });

  const patch: { pending_verification: boolean; nutrition_estimate?: typeof item.nutrition_estimate } = {
    pending_verification: false,
  };
  if (body.verify_nutrition === true && item.nutrition_estimate) {
    patch.nutrition_estimate = { ...item.nutrition_estimate, status: "verified" };
  }
  // Conditional claim — a second reviewer racing the same item no-ops.
  await db
    .update(food_items)
    .set(patch)
    .where(and(eq(food_items.id, id), eq(food_items.pending_verification, true)));
  return c.json({ ok: true });
});

// POST /api/admin/items/:id/unpublish — the item didn't hold up: hide it
// (is_current=false, status="hidden" — superseded stays for explicit
// merges only, "hidden" is the removal state) and reject its source
// submission, which dents the submitter's reputation exactly like a normal
// rejection and emails them through the existing notify path. Optional
// body { reason } becomes the submission's rejection_reason.
//
// Both updates are conditional claims: a second unpublish 409s, and the
// submitter is only penalized when this call actually flipped the
// submission — unpublishing a second item of an already-rejected batch
// hides the item without double-counting the rejection.
adminApi.post("/items/:id/unpublish", async (c) => {
  let body: { reason?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    // reason is optional — a bodyless unpublish is valid.
  }
  const db = getDb(c.env);
  const id = c.req.param("id");
  const claimed = await db
    .update(food_items)
    .set({ is_current: false, status: "hidden", pending_verification: false })
    .where(and(eq(food_items.id, id), eq(food_items.is_current, true), eq(food_items.status, "published")))
    .returning();
  const item = claimed[0];
  if (!item) {
    const [existing] = await db
      .select({ status: food_items.status })
      .from(food_items)
      .where(eq(food_items.id, id))
      .limit(1);
    if (!existing) return c.json({ error: "item not found" }, 404);
    return c.json({ error: `item is already ${existing.status}` }, 409);
  }

  if (item.source_submission_id) {
    const reviewer = c.get("user");
    const reason =
      typeof body?.reason === "string" && body.reason.trim() !== ""
        ? body.reason.trim()
        : "unpublished by reviewer";
    const [sub] = await db
      .update(submissions)
      .set({ status: "rejected", rejection_reason: reason, reviewer_id: reviewer.id })
      .where(and(eq(submissions.id, item.source_submission_id), eq(submissions.status, "trusted_published")))
      .returning();
    if (sub) {
      if (sub.submitter_id) {
        // A rejected trusted publish never earned its approval credit: the
        // intake path granted approved_count +1 when the items went live,
        // so the rejection claws it back (floored at 0 — a submitter whose
        // count was already corrected elsewhere can't go negative). Net
        // effect matches a plain rejection: 0 approved, +1 rejected.
        await db
          .update(submitters)
          .set({
            rejected_count: sql`${submitters.rejected_count} + 1`,
            approved_count: sql`max(${submitters.approved_count} - 1, 0)`,
          })
          .where(eq(submitters.id, sub.submitter_id));
      }
      const [venue] = await db
        .select({ name: venues.name })
        .from(venues)
        .where(eq(venues.id, item.venue_id))
        .limit(1);
      // Awaited like the publish email — never races a post-response freeze.
      await notifyUnpublished(c.env, sub, item.name, venue?.name ?? null);
    }
  }
  // Hidden items leave the search index — best-effort; reindex repairs.
  try {
    await unindex(c.env, [id]);
  } catch (e) {
    console.error("search index hook failed", e);
  }
  return c.json({ ok: true });
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

// POST /api/admin/search/reindex — rebuild the semantic-search index from
// D1 (src/lib/search-index.ts): the one-time backfill after the Vectorize
// index is created and the repair path when vectors stale-date. No-ops to
// {items:0, venues:0} when the provider isn't vectorize.
adminApi.post("/search/reindex", async (c) => {
  const counts = await reindexAll(c.env, getDb(c.env));
  return c.json({ ok: true, ...counts });
});

// GET /api/admin/stale — venues whose freshness needs a reviewer's eye:
// never verified, verified longer than STALE_MONTHS ago, carrying
// STALE_NO_VOTES+ distinct "not accurate" votes since the last positive
// verification, or possibly_closed — no check-in within STALE_MONTHS
// (venues.last_checkin_at NULL or older). List-only: surfacing here never
// changes a venue's status — reviewers decide what to do with the flag.
adminApi.get("/stale", async (c) => {
  const rows = await listStaleVenues(getDb(c.env), c.env);
  return c.json({ venues: rows });
});

// GET /api/admin/venues/:id/items — the venue's CURRENT menu (is_current),
// for the merge picker's keep/drop toggles on the review screen.
adminApi.get("/venues/:id/items", async (c) => {
  const db = getDb(c.env);
  const [venue] = await db
    .select({ id: venues.id })
    .from(venues)
    .where(eq(venues.id, c.req.param("id")))
    .limit(1);
  if (!venue) return c.json({ error: "venue not found" }, 404);
  // Cap the picker page at 500 rows. A larger current menu would be
  // silently truncated — and in merge mode unpicked items get superseded —
  // so `truncated`/`total` let the review screen warn instead of the
  // reviewer unknowingly dropping the tail of a giant menu.
  const items = await db
    .select()
    .from(food_items)
    .where(and(eq(food_items.venue_id, venue.id), eq(food_items.is_current, true)))
    .orderBy(asc(food_items.name))
    .limit(500);
  const [countRow] = await db
    .select({ total: sql<number>`count(*)` })
    .from(food_items)
    .where(and(eq(food_items.venue_id, venue.id), eq(food_items.is_current, true)));
  return c.json({ items, total: countRow?.total ?? items.length, truncated: items.length < (countRow?.total ?? 0) });
});

// POST /api/admin/submissions/:id/approve — publish the reviewer-edited
// draft. Body: { venue_id?; venue?; mode?: "replace"|"merge"; items: (
// {source:"draft", draft_index, ...DraftItem} | {source:"existing", item_id}
// )[] } — plain DraftItem entries (v1 shape) count as selected drafts.
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
    const result = await publishSubmission(getDb(c.env), c.req.param("id"), reviewer.id, body, c.env);
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

// POST /api/admin/users/:id/badges — grant a manual/honorary badge. The
// file-level guard admits reviewers too, but awards are admin-only, so the
// handler re-checks the session roles itself. Body: { badge_key } — must
// be a registry key (BADGES), which is what makes community_star-style
// honorary badges awardable while computed badges could be granted too
// (pointless but harmless). Rejects unknown keys (400), unknown users
// (404), and badges the user already holds (409). Inserts a user_badges
// row; computed badges still never write rows.
adminApi.post("/users/:id/badges", async (c) => {
  const roles = (c.get("user").role ?? "submitter").split(",");
  if (!roles.includes("admin")) return c.json({ error: "forbidden" }, 403);

  let body: { badge_key?: unknown };
  try {
    body = (await c.req.json()) as { badge_key?: unknown };
  } catch {
    return c.json({ error: "expected JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null || typeof body.badge_key !== "string") {
    return c.json({ error: "badge_key must be a string" }, 400);
  }
  if (!BADGES[body.badge_key]) {
    return c.json({ error: "unknown badge_key", allowed: Object.keys(BADGES) }, 400);
  }

  const db = getDb(c.env);
  const userId = c.req.param("id");
  const [target] = (await db.all(sql`SELECT id FROM "user" WHERE id = ${userId}`)) as { id: string }[];
  if (!target) return c.json({ error: "user not found" }, 404);

  const held = await db
    .select({ id: user_badges.id })
    .from(user_badges)
    .where(and(eq(user_badges.user_id, userId), eq(user_badges.badge_key, body.badge_key)))
    .limit(1);
  if (held.length > 0) return c.json({ error: "badge already held" }, 409);

  const [row] = await db
    .insert(user_badges)
    .values({ user_id: userId, badge_key: body.badge_key, awarded_by: c.get("user").id })
    .returning();
  return c.json({ badge: row }, 201);
});

export default adminApi;
