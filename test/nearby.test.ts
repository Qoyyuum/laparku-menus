import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { venues, type Venue } from "../src/db/schema";
import type { Env } from "../src/env";

const db = () => getDb(env);

interface NearbyVenue {
  id: string;
  name: string;
  type: string;
  area: string;
  distance_m: number;
}

// ~0.0009° latitude ≈ 100 m at any longitude (1° lat ≈ 111.32 km).
const M100 = 0.0009;
const M200 = 0.0018;
const M300 = 0.0027;
const M2000 = 0.018;

async function seedVenue(name: string, geo?: { lat: number; lng: number }): Promise<Venue> {
  const [v] = await db()
    .insert(venues)
    .values({ name, type: "restaurant", area: "Brunei-Muara", ...(geo ? { geo } : {}) })
    .returning();
  return v!;
}

const nearby = (qs: string, headers?: Record<string, string>) =>
  SELF.fetch(`https://x/api/venues/nearby?${qs}`, { headers });

const json = async (res: Response) => (await res.json()) as { venues: NearbyVenue[] };

// D1 persists for the whole file — every test queries around its own base
// point so fixtures from other tests never fall inside the ~500 m box.

it("includes a venue ~100 m away with distance_m; excludes one at ~2 km and one with null geo", async () => {
  const near = await seedVenue("Near Spot", { lat: 4.9 + M100, lng: 114.9 });
  const far = await seedVenue("Far Spot", { lat: 4.9 + M2000, lng: 114.9 });
  const noGeo = await seedVenue("No Geo Spot");

  const res = await nearby("lat=4.9&lng=114.9");
  expect(res.status).toBe(200);
  const body = await json(res);

  const ids = body.venues.map((v) => v.id);
  expect(ids).toContain(near.id);
  expect(ids).not.toContain(far.id);
  expect(ids).not.toContain(noGeo.id);

  const hit = body.venues.find((v) => v.id === near.id)!;
  expect(hit.name).toBe("Near Spot");
  expect(hit.type).toBe("restaurant");
  expect(hit.area).toBe("Brunei-Muara");
  expect(Number.isInteger(hit.distance_m)).toBe(true);
  expect(hit.distance_m).toBeGreaterThan(80);
  expect(hit.distance_m).toBeLessThan(120);
});

it("sorts results nearest-first", async () => {
  const v300 = await seedVenue("Three Hundred", { lat: 4.8 + M300, lng: 114.8 });
  const v100 = await seedVenue("One Hundred", { lat: 4.8 + M100, lng: 114.8 });
  const v200 = await seedVenue("Two Hundred", { lat: 4.8 + M200, lng: 114.8 });

  const body = await json(await nearby("lat=4.8&lng=114.8"));
  expect(body.venues.map((v) => v.id)).toEqual([v100.id, v200.id, v300.id]);
  const dists = body.venues.map((v) => v.distance_m);
  expect(dists).toEqual([...dists].sort((a, b) => a - b));
});

it("honors limit, defaults to 5, and clamps to 1–20", async () => {
  // Seven venues inside the box around (4.7, 114.7).
  const ids: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const v = await seedVenue(`Limit ${i}`, { lat: 4.7 + i * 0.0004, lng: 114.7 });
    ids.push(v.id);
  }

  // Default limit = 5 — the five nearest.
  const def = await json(await nearby("lat=4.7&lng=114.7"));
  expect(def.venues).toHaveLength(5);
  expect(def.venues.map((v) => v.id)).toEqual(ids.slice(0, 5));

  const three = await json(await nearby("lat=4.7&lng=114.7&limit=3"));
  expect(three.venues).toHaveLength(3);
  expect(three.venues.map((v) => v.id)).toEqual(ids.slice(0, 3));

  // Clamps: 0 → 1, 99 → 20 (only 7 exist here).
  const one = await json(await nearby("lat=4.7&lng=114.7&limit=0"));
  expect(one.venues).toHaveLength(1);
  const big = await json(await nearby("lat=4.7&lng=114.7&limit=99"));
  expect(big.venues).toHaveLength(7);
});

it("400s on missing, non-numeric, or out-of-range coordinates", async () => {
  for (const qs of [
    "lng=114.9", // missing lat
    "lat=4.9", // missing lng
    "", // missing both
    "lat=abc&lng=114.9", // non-numeric lat
    "lat=4.9&lng=xyz", // non-numeric lng
    "lat=90.0001&lng=114.9", // lat > 90
    "lat=-90.0001&lng=114.9", // lat < -90
    "lat=4.9&lng=180.0001", // lng > 180
    "lat=4.9&lng=-180.0001", // lng < -180
  ]) {
    expect((await nearby(qs)).status).toBe(400);
  }
  // Boundary values are in range.
  expect((await nearby("lat=90&lng=180")).status).toBe(200);
  expect((await nearby("lat=-90&lng=-180")).status).toBe(200);
});

it("rate-limits by CF-Connecting-IP when the limiter is configured", async () => {
  const saved = env.RATE_LIMITER;
  try {
    env.RATE_LIMITER = { limit: async () => ({ success: false }) } as unknown as Env["RATE_LIMITER"];
    expect((await nearby("lat=4.9&lng=114.9", { "CF-Connecting-IP": "203.0.113.9" })).status).toBe(429);

    env.RATE_LIMITER = { limit: async () => ({ success: true }) } as unknown as Env["RATE_LIMITER"];
    expect((await nearby("lat=4.9&lng=114.9", { "CF-Connecting-IP": "203.0.113.9" })).status).toBe(200);
  } finally {
    env.RATE_LIMITER = saved;
  }
});
