import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { food_items, venues } from "../src/db/schema";
import { seed } from "./helpers/seed";

interface ItemRow {
  id: string;
  venue_id: string;
  name: string;
  price_bnd: number | null;
  superseded_by: string | null;
  status: string;
}
interface VenueRow {
  id: string;
  name: string;
  type: string;
  area: string;
  halal_status: string;
}
interface SearchBody {
  venues: VenueRow[];
  items: ItemRow[];
}

it("search q=katok returns the live item", async () => {
  await seed(env);
  const res = await SELF.fetch("https://x/api/search?q=katok");
  expect(res.status).toBe(200);
  const body = (await res.json()) as SearchBody;
  const names = body.items.map((i) => i.name);
  expect(names).toContain("Nasi Katok");
  expect(names).not.toContain("Old Menu Item");
});

it("halal=muslim-owned filters venues and their items", async () => {
  const { venue } = await seed(env);
  const db = getDb(env);
  const [porky] = await db
    .insert(venues)
    .values({ name: "Non Halal Place", type: "restaurant", area: "Belait", halal_status: "non-halal" })
    .returning();
  await db.insert(food_items).values({ venue_id: porky!.id, item_type: "dish", name: "Pork Bun", price_bnd: 3.0 });

  const res = await SELF.fetch("https://x/api/search?halal=muslim-owned");
  expect(res.status).toBe(200);
  const body = (await res.json()) as SearchBody;
  expect(body.venues.length).toBeGreaterThan(0);
  for (const v of body.venues) expect(v.halal_status).toBe("muslim-owned");
  expect(body.venues.map((v) => v.id)).toContain(venue.id);
  expect(body.venues.map((v) => v.id)).not.toContain(porky!.id);
  // items come only from matching venues
  const venueIds = new Set(body.venues.map((v) => v.id));
  for (const i of body.items) expect(venueIds.has(i.venue_id)).toBe(true);
  expect(body.items.map((i) => i.name)).not.toContain("Pork Bun");
});

it("max_price=1.0 excludes the 1.5-priced item", async () => {
  const { venue } = await seed(env);
  const db = getDb(env);
  await db.insert(food_items).values({ venue_id: venue.id, item_type: "dish", name: "Roti Kosong", price_bnd: 1.0 });

  const res = await SELF.fetch("https://x/api/search?max_price=1.0");
  expect(res.status).toBe(200);
  const body = (await res.json()) as SearchBody;
  expect(body.items.map((i) => i.name)).toContain("Roti Kosong");
  expect(body.items.map((i) => i.name)).not.toContain("Nasi Katok");
  for (const i of body.items) expect(i.price_bnd ?? 0).toBeLessThanOrEqual(1.0);
});

it("superseded items are absent from venue items and search", async () => {
  const { venue } = await seed(env);

  const res = await SELF.fetch(`https://x/api/venues/${venue.id}/items`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: ItemRow[] };
  const names = body.items.map((i) => i.name);
  expect(names).toContain("Nasi Katok");
  expect(names).not.toContain("Old Menu Item");
  for (const i of body.items) {
    expect(i.superseded_by).toBeNull();
    expect(i.status).toBe("published");
  }

  const res2 = await SELF.fetch("https://x/api/search?q=old");
  expect(res2.status).toBe(200);
  const body2 = (await res2.json()) as SearchBody;
  expect(body2.items.map((i) => i.name)).not.toContain("Old Menu Item");
});

it("Review Focus #6: injection string in q returns 200 and tables stay intact", async () => {
  await seed(env);
  const res = await SELF.fetch(`https://x/api/search?q=${encodeURIComponent("';DROP TABLE venues;--")}`);
  expect(res.status).toBe(200);
  // venues table is still queryable via Drizzle
  const rows = await getDb(env).select().from(venues);
  expect(rows.length).toBeGreaterThan(0);
  // and the API still serves venues
  const res2 = await SELF.fetch("https://x/api/venues");
  expect(res2.status).toBe(200);
});

it("GET /api/venues filters by type, area, q and only returns published", async () => {
  const { venue } = await seed(env);
  const db = getDb(env);
  await db.insert(venues).values({ name: "Draft Shop", type: "convenience", area: "Tutong", status: "draft" });
  await db.insert(venues).values({ name: "Belait Stall", type: "stall", area: "Belait" });

  const res = await SELF.fetch(`https://x/api/venues?type=restaurant&area=${encodeURIComponent("Brunei-Muara")}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { venues: VenueRow[] };
  expect(body.venues.length).toBeGreaterThan(0);
  for (const v of body.venues) {
    expect(v.type).toBe("restaurant");
    expect(v.area).toBe("Brunei-Muara");
  }
  expect(body.venues.map((v) => v.id)).toContain(venue.id);
  expect(body.venues.map((v) => v.name)).not.toContain("Draft Shop");
  expect(body.venues.map((v) => v.name)).not.toContain("Belait Stall");

  const resQ = await SELF.fetch(`https://x/api/venues?q=${encodeURIComponent("test rest")}`);
  expect(resQ.status).toBe(200);
  const bodyQ = (await resQ.json()) as { venues: VenueRow[] };
  expect(bodyQ.venues.map((v) => v.id)).toContain(venue.id);
  expect(bodyQ.venues.map((v) => v.name)).not.toContain("Belait Stall");
});

it("item_type and tag filters narrow search items", async () => {
  const { venue } = await seed(env);
  const db = getDb(env);
  await db.insert(food_items).values({
    venue_id: venue.id,
    item_type: "product",
    name: "Protein Bar",
    price_bnd: 2.5,
    tags: ["high-protein"],
  });

  const res = await SELF.fetch("https://x/api/search?item_type=product&tag=high-protein");
  expect(res.status).toBe(200);
  const body = (await res.json()) as SearchBody;
  expect(body.items.map((i) => i.name)).toContain("Protein Bar");
  expect(body.items.map((i) => i.name)).not.toContain("Nasi Katok");
});

it("rejects invalid enum and max_price params with 400", async () => {
  for (const url of [
    "https://x/api/venues?type=cafe",
    "https://x/api/venues?area=Kyoto",
    "https://x/api/venues?halal=haram",
    "https://x/api/search?venue_type=cafe",
    "https://x/api/search?item_type=entree",
    "https://x/api/search?area=Kyoto",
    "https://x/api/search?halal=haram",
    "https://x/api/search?max_price=lots",
    "https://x/api/search?max_price=-5",
  ]) {
    const res = await SELF.fetch(url);
    expect(res.status, url).toBe(400);
  }
});

it("GET /api/venues/:id/items returns 404 for unknown or unpublished venue", async () => {
  const res = await SELF.fetch("https://x/api/venues/does-not-exist/items");
  expect(res.status).toBe(404);

  const db = getDb(env);
  const [draft] = await db
    .insert(venues)
    .values({ name: "Hidden Draft", type: "stall", area: "Temburong", status: "draft" })
    .returning();
  const res2 = await SELF.fetch(`https://x/api/venues/${draft!.id}/items`);
  expect(res2.status).toBe(404);
});
