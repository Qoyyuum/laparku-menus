import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/client";
import { AREAS, venues, VENUE_TYPES } from "../db/schema";
import type { Env } from "../env";
import { staleMonths, withFreshness } from "../lib/freshness";
import { reverseNominatim, searchNominatim } from "../lib/osm";
import { indexVenues } from "../lib/search-index";
import { similarName, venuesNear } from "../lib/venue-match";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";

const venuesApi = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Same role set as every other write intake.
const WRITE_ROLES = ["submitter", "reviewer", "admin"];

// Soft-dedup radius for POST /api/venues — two same-named points this
// close are the same shop, not two branches.
const DEDUP_M = 50;
// Trusted-create cap (same model as the 20/day check-in and 100/day scan
// caps): at most this many new venue rows per user per UTC day, enforced
// atomically inside the insert.
const MAX_VENUES_PER_USER_PER_DAY = 10;

// UTC day boundary — the same clock check-ins and verifications use for
// their per-day caps, so all three agree on what "today" means.
function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// A coordinate query param: missing/blank → undefined (optional) or the
// caller's null (required pair); non-numeric or out of range → null.
function coord(raw: string | undefined, min: number, max: number): number | null | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// GET /api/venues/osm-search?q=&lat=&lng= — public read proxied through
// Nominatim (src/lib/osm.ts). Rate-limited like the other reads that fan
// out to an upstream API. lat/lng are an optional pair that bounds the
// search to the user's area; without them the query is global.
venuesApi.get("/venues/osm-search", rateLimit, async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ error: "q is required" }, 400);
  const lat = coord(c.req.query("lat"), -90, 90);
  const lng = coord(c.req.query("lng"), -180, 180);
  // Both-or-neither, and each must parse in range.
  if (lat === null || lng === null || (lat === undefined) !== (lng === undefined)) {
    return c.json({ error: "lat and lng must both be valid numbers when given (lat ±90, lng ±180)" }, 400);
  }
  const places = await searchNominatim(q, lat === undefined ? undefined : { lat, lng: lng! });
  return c.json({ places });
});

// GET /api/venues/osm-reverse?lat=&lng= — pin-drop name suggestion for the
// web map (same proxy+rate-limit pattern; both coords required).
venuesApi.get("/venues/osm-reverse", rateLimit, async (c) => {
  const lat = coord(c.req.query("lat"), -90, 90);
  const lng = coord(c.req.query("lng"), -180, 180);
  if (lat === null || lng === null || lat === undefined || lng === undefined) {
    return c.json({ error: "lat and lng are required numbers (lat ±90, lng ±180)" }, 400);
  }
  return c.json(await reverseNominatim(lat, lng));
});

const createVenueSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(VENUE_TYPES).optional(),
  area: z.enum(AREAS).optional(),
  // OSM display_name the client can forward for human context.
  address: z.string().trim().min(1).max(500).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  // OSM provenance + dedup key — "node/123" / "way/456" style.
  osm_ref: z.string().regex(/^(node|way|relation)\/\d+$/).optional(),
});

// POST /api/venues — trusted venue creation from an OSM pick (or a pin
// drop). Mirrors the trusted-publish model: the OSM data is externally
// verified, the user is physically there, and the venue surfaces in admin
// for the reviewer double-check — so the row lands published, not queued.
venuesApi.post("/venues", rateLimit, requireAuth(WRITE_ROLES), async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "expected JSON body" }, 400);
  }
  const parsed = createVenueSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "invalid venue", issues: parsed.error.issues }, 400);
  }
  const { name, type, area, address, lat, lng, osm_ref } = parsed.data;
  const db = getDb(c.env);
  const months = staleMonths(c.env);
  const userId = c.get("user").id;

  // Hard dedup: the same OSM object can only ever be one venue. A
  // non-published row carrying the ref is the same real place held in a
  // dead record — revive it to published (rather than letting the unique
  // index force a confusing failure or a shadow twin) and treat it as a
  // dedup hit: revives mint no new row and don't consume the daily cap.
  if (osm_ref) {
    const [existing] = await db.select().from(venues).where(eq(venues.osm_ref, osm_ref)).limit(1);
    if (existing) {
      if (existing.status === "published") {
        return c.json({ venue: withFreshness(existing, months) }, 200);
      }
      const [revived] = await db
        .update(venues)
        .set({ status: "published", is_stub: false, last_verified_at: new Date() })
        .where(eq(venues.id, existing.id))
        .returning();
      // A revived row may have been dead while the index was built — upsert it.
      try {
        await indexVenues(c.env, db, [revived!.id]);
      } catch (e) {
        console.error("search index hook failed", e);
      }
      return c.json({ venue: withFreshness(revived!, months) }, 200);
    }
  }

  // Soft dedup: a published venue within ~50 m with a similar name is the
  // same place — return it instead of creating a twin.
  const nearRows = await venuesNear(db, { lat, lng, radius_m: DEDUP_M });
  const match = nearRows.find((c) => similarName(c.venue.name, name))?.venue;
  if (match) return c.json({ venue: withFreshness(match, months) }, 200);

  // The 10/user/day cap is enforced INSIDE the insert — a plain
  // count-then-insert lets concurrent requests both pass the check and
  // both write. `INSERT ... SELECT ... WHERE (count) < cap` evaluates the
  // cap atomically with the write (same pattern as check-ins); zero
  // RETURNING rows means the cap was hit. Bound values are raw SQLite
  // types — epoch-ms ints, JSON text for geo — D1 doesn't accept
  // Date/boolean bind params.
  const now = new Date();
  const dayStart = utcDayStart(now);
  const id = crypto.randomUUID();
  let inserted: Record<string, unknown> | undefined;
  try {
    inserted = (await db.get(sql`
      INSERT INTO venues (id, name, type, area, address, geo, halal_status, verification,
                          status, last_verified_at, is_stub, osm_ref, created_by, created_at, updated_at)
      SELECT ${id}, ${name}, ${type ?? "restaurant"}, ${area ?? "Brunei-Muara"},
             ${address ?? null}, ${JSON.stringify({ lat, lng })}, 'unknown', 'unverified',
             'published', ${now.getTime()}, 0, ${osm_ref ?? null}, ${userId},
             ${now.getTime()}, ${now.getTime()}
      WHERE (
        SELECT count(*) FROM venues
        WHERE created_by = ${userId} AND created_at >= ${dayStart.getTime()}
      ) < ${MAX_VENUES_PER_USER_PER_DAY}
      RETURNING id
    `)) as Record<string, unknown> | undefined;
  } catch (e) {
    // Race loser of a same-osm_ref create: the venues_osm_ref_idx UNIQUE
    // index fired, so the winner's row is the correct answer — return it
    // as the dedup hit it effectively is.
    if (e instanceof Error && /unique/i.test(e.message) && osm_ref) {
      const [winner] = await db.select().from(venues).where(eq(venues.osm_ref, osm_ref)).limit(1);
      if (winner) return c.json({ venue: withFreshness(winner, months) }, 200);
    }
    throw e;
  }
  if (!inserted) {
    return c.json({ error: "daily venue limit reached" }, 429);
  }
  const [venue] = await db.select().from(venues).where(eq(venues.id, id)).limit(1);
  // Search index — best-effort; the admin reindex endpoint repairs misses.
  try {
    await indexVenues(c.env, db, [id]);
  } catch (e) {
    console.error("search index hook failed", e);
  }
  return c.json({ venue: withFreshness(venue!, months) }, 201);
});

export default venuesApi;
