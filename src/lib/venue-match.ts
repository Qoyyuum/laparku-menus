// Geo+name venue matching shared by POST /api/venues (create dedup) and the
// gmaps_link import (which venue does this Google place correspond to).
// Lifted verbatim out of src/routes/venues.ts so both callers compare
// identity the same way.

import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { venues, type Venue } from "../db/schema";

const M_PER_DEG_LAT = 111_320;
const EARTH_R_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.sqrt(a));
}

// Loose name match: case/whitespace-insensitive equality, or one name
// containing the other ("Kaizen" vs "Kaizen Sushi"). The containment arm
// only runs when the shorter name is ≥4 chars — otherwise a one-word
// shared token ("Sushi", "A") would merge every same-street shop into its
// neighbour.
export function similarName(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  return shorter.length >= 4 && longer.includes(shorter);
}

export interface VenueCandidate {
  venue: Venue;
  distance_m: number;
}

// Published venues within `radius_m` of a point, nearest first. Same
// bounding-box prefilter + haversine pattern as /venues/nearby.
export async function venuesNear(
  db: Db,
  { lat, lng, radius_m }: { lat: number; lng: number; radius_m: number },
): Promise<VenueCandidate[]> {
  const dLat = radius_m / M_PER_DEG_LAT;
  const dLng = Math.min(180, radius_m / (M_PER_DEG_LAT * Math.max(Math.abs(Math.cos(toRad(lat))), 1e-6)));
  const rows = await db
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
  return rows
    .map((venue) => ({
      venue,
      distance_m: haversineM(lat, lng, Number(venue.geo!.lat), Number(venue.geo!.lng)),
    }))
    .filter((c) => c.distance_m <= radius_m)
    .sort((a, b) => a.distance_m - b.distance_m);
}
