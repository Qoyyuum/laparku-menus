import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { getDb } from "../db/client";
import { submissions, submitters, venues } from "../db/schema";
import type { Env } from "../env";
import { GmapsError, resolveGmapsUrl } from "../lib/gmaps";
import { trustedPublishGmaps } from "../lib/gmaps-publish";
import { PublishError } from "../lib/publish";
import { rateLimit } from "../middleware/rate-limit";
import { requireAuth, type AuthUser, type AuthVariables } from "../middleware/auth";
import { resolveSubmitter } from "./submissions";

const importApi = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Same role set as every other write intake.
const IMPORT_ROLES = ["submitter", "reviewer", "admin"];

const gmapsSchema = z.object({
  url: z.string().trim().min(8).max(2048),
});

const attachSchema = z
  .object({
    venue_id: z.string().min(1).optional(),
    new_venue: z.boolean().optional(),
  })
  .refine((v) => (v.venue_id !== undefined) !== (v.new_venue === true), {
    message: "provide exactly one of venue_id or new_venue",
  });

// POST /api/submissions/gmaps — file a Google Maps link import. Cheap work
// only: expand/parse the link, insert the pending row, enqueue. All
// provider calls happen in the queue consumer; the client polls
// GET /api/submissions/:id for the outcome.
importApi.post("/submissions/gmaps", rateLimit, requireAuth(IMPORT_ROLES), async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "expected JSON body" }, 400);
  }
  const parsed = gmapsSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
  }

  let resolved;
  try {
    resolved = await resolveGmapsUrl(parsed.data.url);
  } catch (e) {
    if (e instanceof GmapsError) return c.json({ error: e.code }, 400);
    throw e;
  }

  const db = getDb(c.env);
  const userId = c.get("user").id;
  const { submitter, error } = await resolveSubmitter(db, { authUserId: userId });
  if (error) return c.json(error.body, error.status as ContentfulStatusCode);

  const id = crypto.randomUUID();
  await db.insert(submissions).values({
    id,
    submitter_id: submitter?.id ?? null,
    user_id: userId,
    source_type: "gmaps_link",
    provenance: parsed.data.url,
    image_keys: [],
    raw_extraction: {
      gmaps: {
        resolved_url: resolved.resolved_url,
        place_id: resolved.place_id,
        data_id: resolved.data_id,
        place: {
          name: resolved.name,
          lat: resolved.lat,
          lng: resolved.lng,
        },
      },
    },
    auto_flags: [],
    status: "pending",
  });
  if (submitter) {
    await db
      .update(submitters)
      .set({ submissions_count: sql`${submitters.submissions_count} + 1` })
      .where(eq(submitters.id, submitter.id));
  }

  await c.env.SUBMISSION_QUEUE.send({ submissionId: id });
  return c.json({ submission_id: id, status: "processing" }, 201);
});

function isStaff(user: AuthUser): boolean {
  return (user.role ?? "submitter")
    .split(",")
    .some((r) => r === "reviewer" || r === "admin");
}

// Resolve the caller's submission row — scoped to their own user id
// (submitters/auth_user_id or the stamped submissions.user_id), or any
// row for reviewer/admin roles. Returns the row or null.
async function findOwnedSubmission(
  db: ReturnType<typeof getDb>,
  id: string,
  user: AuthUser,
) {
  const [row] = await db.select().from(submissions).where(eq(submissions.id, id)).limit(1);
  if (!row) return null;
  if (isStaff(user)) return row;
  if (row.user_id === user.id) return row;
  if (row.submitter_id) {
    const [own] = await db
      .select({ id: submitters.id })
      .from(submitters)
      .where(and(eq(submitters.id, row.submitter_id), eq(submitters.auth_user_id, user.id)))
      .limit(1);
    if (own) return row;
  }
  return null;
}

// GET /api/submissions/:id — status poll for the import UX. Mirrors the
// MCP get_submission_status select set, plus the gmaps summary the import
// screen needs to render outcome cards and the venue picker.
importApi.get("/submissions/:id", requireAuth(IMPORT_ROLES), async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  const row = await findOwnedSubmission(db, c.req.param("id"), user);
  if (!row) return c.json({ error: "submission not found" }, 404);

  const g = row.raw_extraction?.gmaps;
  return c.json({
    id: row.id,
    status: row.status,
    source_type: row.source_type,
    auto_flags: row.auto_flags,
    rejection_reason: row.rejection_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    items_count: Array.isArray(row.raw_extraction?.items) ? row.raw_extraction.items.length : 0,
    photo_count: row.image_keys.length,
    ...(g
      ? {
          gmaps: {
            place: g.place ?? null,
            provider: g.provider ?? null,
            venue_candidates: g.venue_candidates ?? [],
            venue_id: g.venue_id ?? null,
            published: g.published ?? null,
            matched: g.matched ?? null,
            photo_urls: g.photo_urls ?? [],
          },
        }
      : {}),
  });
});

// POST /api/submissions/gmaps/:id/venue — venue disambiguation confirm for
// a structured-menu import that couldn't auto-match. venue_id attaches an
// existing published venue and runs the trusted publish from the cached
// provider payload (zero extra provider calls); new_venue leaves the row
// in pending_review for the reviewer.
importApi.post("/submissions/gmaps/:id/venue", rateLimit, requireAuth(IMPORT_ROLES), async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "expected JSON body" }, 400);
  }
  const parsed = attachSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
  }

  const db = getDb(c.env);
  const user = c.get("user");
  const sub = await findOwnedSubmission(db, c.req.param("id"), user);
  if (!sub || sub.source_type !== "gmaps_link") {
    return c.json({ error: "submission not found" }, 404);
  }
  if (sub.status === "pending") {
    return c.json({ error: "import still processing" }, 409);
  }
  if (sub.status !== "pending_review") {
    return c.json({ error: `cannot attach venue to a ${sub.status} submission` }, 409);
  }
  const sections = sub.raw_extraction?.gmaps?.sections;
  if (!sections || sections.length === 0) {
    return c.json({ error: "no cached menu data on this submission" }, 409);
  }

  if (parsed.data.new_venue === true) {
    return c.json({ status: "pending_review", submission_id: sub.id });
  }

  const venueId = parsed.data.venue_id!;
  const [venue] = await db
    .select({ id: venues.id })
    .from(venues)
    .where(and(eq(venues.id, venueId), eq(venues.status, "published")))
    .limit(1);
  if (!venue) return c.json({ error: "venue not found" }, 404);

  try {
    const result = await trustedPublishGmaps(
      db,
      {
        userId: user.id,
        venueId: venue.id,
        submissionId: sub.id,
        sections,
        googlePlaceId: sub.raw_extraction?.gmaps?.place_id,
      },
      c.env,
    );
    // Record the attach on the cached payload for the poll response.
    await db
      .update(submissions)
      .set({
        raw_extraction: {
          ...sub.raw_extraction,
          gmaps: {
            ...sub.raw_extraction?.gmaps,
            venue_id: venue.id,
            published: result.published,
            matched: result.matched,
          },
        },
      })
      .where(eq(submissions.id, sub.id));
    return c.json({ status: "imported", submission_id: sub.id, ...result });
  } catch (e) {
    if (e instanceof PublishError) {
      return c.json({ error: e.message }, e.status as ContentfulStatusCode);
    }
    throw e;
  }
});

export default importApi;
