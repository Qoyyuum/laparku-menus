import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/client";
import { AREAS, venues, VENUE_TYPES } from "../db/schema";
import type { Env } from "../env";
import { staleMonths, withFreshness } from "../lib/freshness";
import { reverseNominatim, searchNominatim } from "../lib/osm";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";

const venuesApi = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Same role set as every other write intake.
const WRITE_ROLES = ["submitter", "reviewer", "admin"];

// Soft-dedup radius for POST /api/venues — two same-named points this
// close are the same shop, not two branches.
const DEDUP_M = 50;
const M_PER_DEG_LAT = 111_320;
const EARTH_R_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.sqrt(a));
}

// Loose name match for the proximity dedup: case/whitespace-insensitive
// equality, or one name containing the other ("Kaizen" vs "Kaizen Sushi").
function similarName(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const na = norm(a);
  const nb = norm(b);
  return na === nb || na.includes(nb) || nb.includes(na);
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

  // Hard dedup: the same OSM object can only ever be one venue.
  if (osm_ref) {
    const [existing] = await db.select().from(venues).where(eq(venues.osm_ref, osm_ref)).limit(1);
    if (existing) return c.json({ venue: withFreshness(existing, months) }, 200);
  }

  // Soft dedup: a published venue within ~50 m with a similar name is the
  // same place — return it instead of creating a twin. Same bounding-box
  // prefilter + haversine pattern as /venues/nearby.
  const dLat = DEDUP_M / M_PER_DEG_LAT;
  const dLng = Math.min(
    180,
    DEDUP_M / (M_PER_DEG_LAT * Math.max(Math.abs(Math.cos(toRad(lat))), 1e-6)),
  );
  const nearRows = await db
    .select()
    .from(venues)
    .where(
      and(
        eq(venues.status, "published"),
        isNotNull(venues.geo),
        sql`json_valid(${venues.geo})`,
        sql`CAST(json_extract(${venues.geo}, '$.lat') AS REAL) BETWEEN ${lat - dLat} AND ${lat + dLat}`,
        sql`CAST(json_extract(${venues.geo}, '$.lng') AS REAL) BETWEEN ${lng - dLng} AND ${lng + dLng}`,
      ),
    );
  const match = nearRows.find(
    (v) =>
      haversineM(lat, lng, Number(v.geo!.lat), Number(v.geo!.lng)) <= DEDUP_M &&
      similarName(v.name, name),
  );
  if (match) return c.json({ venue: withFreshness(match, months) }, 200);

  const [venue] = await db
    .insert(venues)
    .values({
      name,
      type: type ?? "restaurant",
      area: area ?? "Brunei-Muara",
      address: address ?? null,
      geo: { lat, lng },
      halal_status: "unknown",
      verification: "unverified",
      status: "published",
      // Trusted-create is itself a verification event — same signal as a
      // reviewer approve or a positive verify vote, so the freshness
      // clock starts now rather than reading as never-verified.
      last_verified_at: new Date(),
      is_stub: false,
      osm_ref: osm_ref ?? null,
    })
    .returning();
  return c.json({ venue: withFreshness(venue!, months) }, 201);
});

export default venuesApi;
