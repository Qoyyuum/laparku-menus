import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/client";
import { venues } from "../db/schema";
import type { Env } from "../env";
import { rateLimit } from "../middleware/rate-limit";

const nearbyApi = new Hono<{ Bindings: Env }>();

// Spec §4: venues inside a ~500 m bounding box of the query point, sorted by
// haversine distance (Brunei density makes a wide box cheap — the box is the
// prefilter, the haversine is for ordering + display only).
const BOX_M = 500;
const M_PER_DEG_LAT = 111_320;
const EARTH_R_M = 6_371_000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

const toRad = (deg: number) => (deg * Math.PI) / 180;

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.sqrt(a));
}

// A required coordinate query param: missing, non-numeric, or out of range
// → null (caller 400s).
function coord(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// GET /api/venues/nearby?lat&lng&limit — public read (GPS assist for the
// venue picker), rate-limited like the other /api reads that fan out work.
// Venues with null geo are simply never nearby (spec's known limitation —
// geo population is a separate concern).
nearbyApi.get("/venues/nearby", rateLimit, async (c) => {
  const lat = coord(c.req.query("lat"), -90, 90);
  const lng = coord(c.req.query("lng"), -180, 180);
  if (lat === null || lng === null) {
    return c.json({ error: "lat and lng are required numbers (lat ±90, lng ±180)" }, 400);
  }
  const limitRaw = c.req.query("limit")?.trim();
  const parsed = limitRaw ? Number(limitRaw) : NaN;
  const limit = Number.isFinite(parsed)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(parsed)))
    : DEFAULT_LIMIT;

  const dLat = BOX_M / M_PER_DEG_LAT;
  // Longitude degrees shrink toward the poles; cap the half-width at 180°.
  const dLng = Math.min(
    180,
    BOX_M / (M_PER_DEG_LAT * Math.max(Math.abs(Math.cos(toRad(lat))), 1e-6)),
  );

  const rows = await getDb(c.env)
    .select({ id: venues.id, name: venues.name, type: venues.type, area: venues.area, geo: venues.geo })
    .from(venues)
    .where(
      and(
        // Published-only, same convention as every other public venue read.
        eq(venues.status, "published"),
        isNotNull(venues.geo),
        // json_valid guards the extracts below against a malformed geo blob
        // (a non-drizzle write could hold anything) instead of 500ing.
        sql`json_valid(${venues.geo})`,
        sql`CAST(json_extract(${venues.geo}, '$.lat') AS REAL) BETWEEN ${lat - dLat} AND ${lat + dLat}`,
        sql`CAST(json_extract(${venues.geo}, '$.lng') AS REAL) BETWEEN ${lng - dLng} AND ${lng + dLng}`,
      ),
    );

  const nearby = rows
    .map((v) => ({
      id: v.id,
      name: v.name,
      type: v.type,
      area: v.area,
      distance_m: Math.round(haversineM(lat, lng, Number(v.geo!.lat), Number(v.geo!.lng))),
    }))
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, limit);

  return c.json({ venues: nearby });
});

export default nearbyApi;
