import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/client";
import { AREAS, food_items, VENUE_REQUEST_STATUSES, venue_requests, venues } from "../db/schema";
import type { Env } from "../env";
import { requireAuth, type AuthVariables } from "../middleware/auth";

// Any signed-in user can file a venue request — same role set as the other
// phase-2 write endpoints.
const REQUEST_ROLES = ["submitter", "reviewer", "admin"];
const LIMIT = 100;
const MAX_NOTE = 500;
// `?status=` accepts the row statuses plus "all" (no filter); absent means
// open — the missions list is the default surface.
const REQUEST_STATUS_FILTERS = [...VENUE_REQUEST_STATUSES, "all"] as const;

const coverageApi = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Same optional-enum parsing convention as src/routes/public.ts: undefined
// when absent/empty, null when present-but-unknown.
function oneOf<const T extends readonly string[]>(raw: string | undefined, allowed: T): T[number] | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  return (allowed as readonly string[]).includes(raw) ? (raw as T[number]) : null;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

// POST /api/requests — file a "we need a menu here" mission. Body:
// { venue_id } to attach to an existing (usually stub) published venue, or
// { free_text_name, area } for a venue not in the dataset yet — exactly one
// shape per request; `note` is an optional ≤500-char hint for whoever picks
// the mission up. The venue's area is copied onto the row so listing and
// the coverage rollup never join for it.
coverageApi.post("/requests", requireAuth(REQUEST_ROLES), async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "expected JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null) {
    return c.json({ error: "expected JSON body" }, 400);
  }
  if (body.venue_id !== undefined && nonEmpty(body.venue_id) === undefined) {
    return c.json({ error: "venue_id must be a non-empty string" }, 400);
  }
  if (body.free_text_name !== undefined && nonEmpty(body.free_text_name) === undefined) {
    return c.json({ error: "free_text_name must be a non-empty string" }, 400);
  }
  const venueId = nonEmpty(body.venue_id);
  const freeText = nonEmpty(body.free_text_name);
  if (venueId && freeText) {
    return c.json({ error: "provide venue_id or free_text_name + area, not both" }, 400);
  }
  if (!venueId && !freeText) {
    return c.json({ error: "provide venue_id (existing venue) or free_text_name + area" }, 400);
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
    return c.json({ error: "note must be a string" }, 400);
  }
  const note = typeof body.note === "string" ? body.note.trim() : undefined;
  if (note !== undefined && note.length > MAX_NOTE) {
    return c.json({ error: `note must be at most ${MAX_NOTE} characters` }, 400);
  }

  const db = getDb(c.env);
  let area: (typeof AREAS)[number];
  if (venueId) {
    // Missions attach to the public surface only — same published-venue
    // rule as check-ins and verify votes.
    const [venue] = await db
      .select({ id: venues.id, area: venues.area })
      .from(venues)
      .where(and(eq(venues.id, venueId), eq(venues.status, "published")))
      .limit(1);
    if (!venue) return c.json({ error: "venue not found" }, 404);
    area = venue.area;
  } else {
    const parsed = oneOf(body.area as string | undefined, AREAS);
    if (!parsed) return c.json({ error: "area is required and must be one of " + AREAS.join(", ") }, 400);
    area = parsed;
  }

  const [request] = await db
    .insert(venue_requests)
    .values({
      requester_id: c.get("user").id,
      venue_id: venueId ?? null,
      free_text_name: freeText ?? null,
      area,
      note: note ?? null,
    })
    .returning();
  return c.json({ request }, 201);
});

// GET /api/requests?status=open&area= — the public missions list. status:
// open (default) | fulfilled | all; area filters on the stored area (which
// for venue-linked rows is the venue's area). venue_name is joined so the
// surface can render stub missions without a second hop. requester_id is
// deliberately not returned — who asked is not part of the mission.
coverageApi.get("/requests", async (c) => {
  const status = oneOf(c.req.query("status"), REQUEST_STATUS_FILTERS);
  if (status === null) return c.json({ error: "invalid status", allowed: REQUEST_STATUS_FILTERS }, 400);
  const area = oneOf(c.req.query("area"), AREAS);
  if (area === null) return c.json({ error: "invalid area", allowed: AREAS }, 400);

  const conds: SQL[] = [];
  const effectiveStatus = status ?? "open";
  if (effectiveStatus !== "all") {
    conds.push(eq(venue_requests.status, effectiveStatus as (typeof VENUE_REQUEST_STATUSES)[number]));
  }
  if (area) conds.push(eq(venue_requests.area, area));

  const rows = await getDb(c.env)
    .select({ request: venue_requests, venue_name: venues.name })
    .from(venue_requests)
    .leftJoin(venues, eq(venue_requests.venue_id, venues.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(venue_requests.created_at))
    .limit(LIMIT);

  return c.json({
    requests: rows.map((r) => ({
      id: r.request.id,
      venue_id: r.request.venue_id,
      venue_name: r.venue_name ?? null,
      free_text_name: r.request.free_text_name,
      area: r.request.area,
      note: r.request.note,
      status: r.request.status,
      fulfilled_submission_id: r.request.fulfilled_submission_id,
      created_at: r.request.created_at,
    })),
  });
});

// GET /api/coverage — the per-area coverage rollup powering the coverage
// page: published venue count, how many of those are "menu needed" stubs,
// open missions, and live menu items. Every area is returned (zeros
// included) so the surface always renders the full district list.
coverageApi.get("/coverage", async (c) => {
  const db = getDb(c.env);

  const venueRows = await db
    .select({
      area: venues.area,
      venues: sql<number>`count(*)`,
      stubs: sql<number>`coalesce(sum(${venues.is_stub}), 0)`,
    })
    .from(venues)
    .where(eq(venues.status, "published"))
    .groupBy(venues.area);

  const requestRows = await db
    .select({ area: venue_requests.area, open_requests: sql<number>`count(*)` })
    .from(venue_requests)
    .where(eq(venue_requests.status, "open"))
    .groupBy(venue_requests.area);

  const itemRows = await db
    .select({ area: venues.area, items: sql<number>`count(*)` })
    .from(food_items)
    .innerJoin(venues, eq(food_items.venue_id, venues.id))
    .where(
      and(
        eq(venues.status, "published"),
        eq(food_items.status, "published"),
        eq(food_items.is_current, true),
      ),
    )
    .groupBy(venues.area);

  const venueMap = new Map(venueRows.map((r) => [r.area, r]));
  const requestMap = new Map(requestRows.map((r) => [r.area, Number(r.open_requests)]));
  const itemMap = new Map(itemRows.map((r) => [r.area, Number(r.items)]));

  return c.json({
    areas: AREAS.map((area) => ({
      area,
      venues: Number(venueMap.get(area)?.venues ?? 0),
      stubs: Number(venueMap.get(area)?.stubs ?? 0),
      open_requests: requestMap.get(area) ?? 0,
      items: itemMap.get(area) ?? 0,
    })),
  });
});

export default coverageApi;
