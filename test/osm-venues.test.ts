import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { getDb } from "../src/db/client";
import { venues } from "../src/db/schema";
import { forgeSession } from "./helpers/auth";

const db = () => getDb(env);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Stubs the one outbound channel the OSM proxy uses — globalThis.fetch —
// and captures (url, headers) so tests can assert the Nominatim request
// shape (query mapping, viewbox, identifying User-Agent).
function mockOsm(respond: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; ua: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // The route always passes a plain-object headers map.
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ url, ua: headers?.["User-Agent"] ?? headers?.["user-agent"] ?? null });
      return respond(url);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// A Nominatim jsonv2 search hit (category is the jsonv2 name for what the
// normalized shape exposes as `class`; lon → lng).
const HIT = {
  place_id: 111,
  osm_type: "node",
  osm_id: 987654,
  lat: "4.9031",
  lon: "114.9398",
  category: "amenity",
  type: "restaurant",
  name: "Kaizen Sushi",
  display_name: "Kaizen Sushi, Jalan Sultan, Bandar Seri Begawan",
  address: { amenity: "Kaizen Sushi", road: "Jalan Sultan" },
};

const osmSearch = (path: string) => SELF.fetch(`https://x/api/venues/osm-search${path}`);
const osmReverse = (path: string) => SELF.fetch(`https://x/api/venues/osm-reverse${path}`);

// --- GET /api/venues/osm-search ---------------------------------------------

it("osm-search 400s without q, and when only one of lat/lng is given", async () => {
  expect((await osmSearch("")).status).toBe(400);
  expect((await osmSearch("?lat=4.9")).status).toBe(400);
  expect((await osmSearch("?q=x&lat=4.9")).status).toBe(400);
  expect((await osmSearch("?q=x&lng=114.9")).status).toBe(400);
  expect((await osmSearch("?q=x&lat=999&lng=114.9")).status).toBe(400);
});

it("osm-search maps q into a Nominatim jsonv2 request and normalizes results", async () => {
  const calls = mockOsm(() => json([HIT]));
  const res = await osmSearch("?q=kaizen+sushi");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { places: Record<string, unknown>[] };

  expect(calls).toHaveLength(1);
  const url = new URL(calls[0]!.url);
  expect(url.origin + url.pathname).toBe("https://nominatim.openstreetmap.org/search");
  expect(url.searchParams.get("format")).toBe("jsonv2");
  expect(url.searchParams.get("addressdetails")).toBe("1");
  expect(url.searchParams.get("extratags")).toBe("1");
  expect(url.searchParams.get("limit")).toBe("8");
  expect(url.searchParams.get("q")).toBe("kaizen sushi");
  // No coords → no bounding box.
  expect(url.searchParams.get("viewbox")).toBeNull();
  expect(url.searchParams.get("bounded")).toBeNull();
  // Nominatim usage policy: an identifying UA on every request.
  expect(calls[0]!.ua).toContain("laparku-menus");

  expect(body.places).toHaveLength(1);
  const p = body.places[0]!;
  expect(p.osm_type).toBe("node");
  expect(p.osm_id).toBe(987654);
  expect(p.name).toBe("Kaizen Sushi");
  expect(p.class).toBe("amenity");
  expect(p.type).toBe("restaurant");
  expect(p.lat).toBeCloseTo(4.9031);
  expect(p.lng).toBeCloseTo(114.9398);
  expect(p.display_name).toBe(HIT.display_name);
  expect(p.address).toEqual(HIT.address);
});

it("osm-search adds an UNBOUNDED ~0.5° viewbox when lat/lng are given", async () => {
  const calls = mockOsm(() => json([HIT]));
  const res = await osmSearch("?q=kopitiam&lat=4.9&lng=114.9");
  expect(res.status).toBe(200);
  const url = new URL(calls[0]!.url);
  // viewbox biases ranking only — bounded=1 would *exclude* anything
  // outside the box (e.g. a Temburong hit from a BSB pin), so it must
  // stay off.
  expect(url.searchParams.get("bounded")).toBeNull();
  const box = url.searchParams.get("viewbox")!.split(",").map(Number);
  expect(box).toHaveLength(4);
  // viewbox = minLng,maxLat,maxLng,minLat — roughly ±0.25° around the point.
  expect(box[0]).toBeCloseTo(114.65, 1);
  expect(box[1]).toBeCloseTo(5.15, 1);
  expect(box[2]).toBeCloseTo(115.15, 1);
  expect(box[3]).toBeCloseTo(4.65, 1);
  // A far-flung hit Nominatim still returns comes through untouched.
  expect((await res.json()) as { places: unknown[] }).toEqual({
    places: [expect.objectContaining({ name: "Kaizen Sushi" })],
  });
});

it("osm-search fails gracefully: OSM 5xx, network error and garbage all → {places:[]}", async () => {
  for (const respond of [
    () => json({ error: "upstream" }, 503),
    () => new Response("not json", { status: 200 }),
    () => json({ not: "an array" }),
    () => Promise.reject(new Error("socket hangup")),
    () => Promise.reject(new DOMException("The operation was aborted", "AbortError")),
  ]) {
    mockOsm(respond);
    const res = await osmSearch("?q=anything");
    expect(res.status).toBe(200);
    expect((await res.json()) as { places: unknown[] }).toEqual({ places: [] });
    vi.unstubAllGlobals();
  }
});

it("osm-search drops nameless/unparseable rows instead of passing them through", async () => {
  mockOsm(() =>
    json([HIT, { ...HIT, osm_id: 1, name: "" }, { ...HIT, osm_id: 2, lat: "not-a-number" }]),
  );
  const res = await osmSearch("?q=kaizen");
  const body = (await res.json()) as { places: unknown[] };
  expect(body.places).toHaveLength(1);
});

// --- GET /api/venues/osm-reverse --------------------------------------------

it("osm-reverse 400s without both coords and answers {name,address} on a hit", async () => {
  expect((await osmReverse("")).status).toBe(400);
  expect((await osmReverse("?lat=4.9")).status).toBe(400);

  const calls = mockOsm(() => json(HIT));
  const res = await osmReverse("?lat=4.9031&lng=114.9398");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { name?: string; address?: string };
  expect(body.name).toBe("Kaizen Sushi");
  expect(body.address).toBe(HIT.display_name);

  const url = new URL(calls[0]!.url);
  expect(url.origin + url.pathname).toBe("https://nominatim.openstreetmap.org/reverse");
  expect(url.searchParams.get("lat")).toBe("4.9031");
  expect(url.searchParams.get("lon")).toBe("114.9398");
});

it("osm-reverse returns an empty object on geocode miss and upstream failure", async () => {
  for (const respond of [
    () => json({ error: "Unable to geocode" }, 404),
    () => Promise.reject(new Error("down")),
  ]) {
    mockOsm(respond);
    const res = await osmReverse("?lat=4.9&lng=114.9");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    vi.unstubAllGlobals();
  }
});

// --- POST /api/venues ---------------------------------------------------------

const CREATE = {
  name: "Kaizen Sushi",
  type: "restaurant",
  lat: 4.9031,
  lng: 114.9398,
  osm_ref: "node/987654",
};

async function createVenue(body: unknown, cookie?: string) {
  return SELF.fetch("https://x/api/venues", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

it("POST /api/venues requires a session", async () => {
  expect((await createVenue(CREATE)).status).toBe(401);
});

it("POST /api/venues 400s on missing/invalid fields", async () => {
  const { cookie } = await forgeSession("submitter");
  for (const bad of [
    {},
    { ...CREATE, name: "" },
    { lat: 4.9, lng: 114.9 }, // no name
    { name: "X", lng: 114.9 }, // no lat
    { name: "X", lat: 4.9 }, // no lng
    { ...CREATE, lat: 91 },
    { ...CREATE, type: "spaceship" },
    { ...CREATE, area: "Narnia" },
    { ...CREATE, osm_ref: "node-123" },
  ]) {
    expect((await createVenue(bad, cookie)).status).toBe(400);
  }
});

it("POST /api/venues creates a published, geo'd, non-stub venue (201)", async () => {
  const { cookie } = await forgeSession("submitter");
  const res = await createVenue(CREATE, cookie);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { venue: { id: string; name: string; freshness?: string } };
  expect(body.venue.name).toBe("Kaizen Sushi");

  const [row] = await db().select().from(venues).where(eq(venues.id, body.venue.id));
  expect(row).toBeDefined();
  expect(row!.status).toBe("published");
  expect(row!.is_stub).toBe(false);
  expect(row!.geo).toEqual({ lat: 4.9031, lng: 114.9398 });
  expect(row!.osm_ref).toBe("node/987654");
  expect(row!.last_verified_at).not.toBeNull();
});

it("POST /api/venues dedups on osm_ref — second create returns the same venue (200)", async () => {
  const { cookie } = await forgeSession("submitter");
  const first = (await (await createVenue(CREATE, cookie)).json()) as { venue: { id: string } };
  // Different name/coords, same OSM object → still the same venue.
  const res = await createVenue({ ...CREATE, name: "Other Name", lat: 5.0 }, cookie);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { venue: { id: string } };
  expect(body.venue.id).toBe(first.venue.id);
  const rows = await db().select().from(venues).where(eq(venues.osm_ref, "node/987654"));
  expect(rows).toHaveLength(1);
});

it("POST /api/venues dedups on same name within ~50m, but not further away or renamed", async () => {
  const { cookie } = await forgeSession("submitter");
  // Self-seeded: the test owns its fixture rather than depending on rows
  // earlier tests in this file happened to create.
  const SEED = { lat: 4.7, lng: 114.7 };
  await db()
    .insert(venues)
    .values({ name: "Dedup Corner", type: "grocer", area: "Tutong", geo: SEED })
    .returning();

  // ~30 m away, same name (case-folded), no osm_ref → same place.
  const near = await createVenue({ name: "dedup corner", lat: 4.70025, lng: 114.7001 }, cookie);
  expect(near.status).toBe(200);

  // ~500 m away, same name → a different branch, new venue.
  const far = await createVenue({ name: "Dedup Corner", lat: 4.7045, lng: 114.7 }, cookie);
  expect(far.status).toBe(201);

  // Same spot, different name → not the same place.
  const renamed = await createVenue({ name: "Other Grocer", lat: 4.70001, lng: 114.70001 }, cookie);
  expect(renamed.status).toBe(201);
});

it("proximity dedup: containment needs a ≥4-char shorter name — 'Ah' never swallows a venue", async () => {
  const { cookie } = await forgeSession("submitter");
  const SPOT = { lat: 4.6, lng: 114.6 };
  await db()
    .insert(venues)
    .values({ name: "Ah Meng Kopitiam", type: "restaurant", area: "Belait", geo: SPOT })
    .returning();

  // "ah" ⊂ "ah meng kopitiam" is only 2 chars — the containment arm must
  // not fire or every same-street shop merges into its neighbour.
  const short = await createVenue({ name: "Ah", lat: 4.60001, lng: 114.60001 }, cookie);
  expect(short.status).toBe(201);

  // A real containment still dedups ("Ah Meng" ⊂ "Ah Meng Kopitiam").
  const contained = await createVenue({ name: "Ah Meng", lat: 4.60001, lng: 114.60002 }, cookie);
  expect(contained.status).toBe(200);
  const body = (await contained.json()) as { venue: { name: string } };
  expect(body.venue.name).toBe("Ah Meng Kopitiam");
});

it("osm_ref dedup revives a non-published venue instead of twinning it", async () => {
  const { cookie } = await forgeSession("submitter");
  const [dead] = await db()
    .insert(venues)
    .values({
      name: "Closed Kopitiam",
      type: "restaurant",
      area: "Brunei-Muara",
      status: "closed",
      osm_ref: "node/555777",
    })
    .returning();

  const res = await createVenue({ name: "Kopitiam", lat: 4.9, lng: 114.9, osm_ref: "node/555777" }, cookie);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { venue: { id: string } };
  expect(body.venue.id).toBe(dead!.id);
  const [row] = await db().select().from(venues).where(eq(venues.id, dead!.id));
  // Revived, not shadowed — scans can attach to it again.
  expect(row!.status).toBe("published");
  const rows = await db().select().from(venues).where(eq(venues.osm_ref, "node/555777"));
  expect(rows).toHaveLength(1);
});

it("caps trusted venue creation at 10/user/day; dedup hits don't consume it", async () => {
  const { cookie } = await forgeSession("submitter");
  const base = { lat: 4.2, lng: 114.2 };
  // Unique uuid names keep the soft dedup out of the count.
  const firstName = `cap-${crypto.randomUUID()}`;
  expect((await createVenue({ ...base, name: firstName, osm_ref: "way/42" }, cookie)).status).toBe(201);
  for (let i = 1; i < 10; i++) {
    expect((await createVenue({ ...base, name: `cap-${crypto.randomUUID()}` }, cookie)).status).toBe(201);
  }

  // The 11th fresh create is refused.
  const over = await createVenue({ ...base, name: `cap-${crypto.randomUUID()}` }, cookie);
  expect(over.status).toBe(429);
  expect(((await over.json()) as { error: string }).error).toContain("daily venue limit");

  // Dedup hits return the existing row — they mint nothing, so they still
  // answer 200 at cap (osm_ref hit and name+proximity hit alike).
  expect(
    (await createVenue({ ...base, name: `cap-${crypto.randomUUID()}`, osm_ref: "way/42" }, cookie)).status,
  ).toBe(200);
  expect((await createVenue({ ...base, name: firstName }, cookie)).status).toBe(200);
});
