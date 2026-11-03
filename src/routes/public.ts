import { and, eq, isNull, lte, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/client";
import { AREAS, food_items, HALAL_STATUSES, ITEM_TYPES, venues, VENUE_TYPES } from "../db/schema";
import type { Env } from "../env";

// Cap rows returned by a single public request.
const LIMIT = 100;

// Escape LIKE wildcards + the escape char itself so `q` is always a literal
// substring match. Values are still bound parameters — this only changes the
// pattern text. ESCAPE '\' is declared in each LIKE clause below.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function venueNameMatch(q: string): SQL {
  const p = `%${escapeLike(q)}%`;
  return sql`(${venues.name} LIKE ${p} ESCAPE '\\' OR ${venues.name_ms} LIKE ${p} ESCAPE '\\')`;
}

function itemTextMatch(q: string): SQL {
  const p = `%${escapeLike(q)}%`;
  return sql`(${food_items.name} LIKE ${p} ESCAPE '\\' OR ${food_items.name_ms} LIKE ${p} ESCAPE '\\' OR ${food_items.description} LIKE ${p} ESCAPE '\\')`;
}

// Parse an optional enum query param. Returns undefined when absent/empty,
// null when present but not one of the allowed values.
function oneOf<const T extends readonly string[]>(raw: string | undefined, allowed: T): T[number] | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  return (allowed as readonly string[]).includes(raw) ? (raw as T[number]) : null;
}

interface VenueFilters {
  type?: (typeof VENUE_TYPES)[number];
  area?: (typeof AREAS)[number];
  halal?: (typeof HALAL_STATUSES)[number];
}

// Conditions applied to the venues side: always published-only plus any
// attribute filters. Shared by /venues and by the venues half of /search.
function venueConds(f: VenueFilters): SQL[] {
  const conds: SQL[] = [eq(venues.status, "published")];
  if (f.type) conds.push(eq(venues.type, f.type));
  if (f.area) conds.push(eq(venues.area, f.area));
  if (f.halal) conds.push(eq(venues.halal_status, f.halal));
  return conds;
}

const publicApi = new Hono<{ Bindings: Env }>();

publicApi.get("/venues", async (c) => {
  const type = oneOf(c.req.query("type"), VENUE_TYPES);
  if (type === null) return c.json({ error: "invalid type", allowed: VENUE_TYPES }, 400);
  const area = oneOf(c.req.query("area"), AREAS);
  if (area === null) return c.json({ error: "invalid area", allowed: AREAS }, 400);
  const halal = oneOf(c.req.query("halal"), HALAL_STATUSES);
  if (halal === null) return c.json({ error: "invalid halal", allowed: HALAL_STATUSES }, 400);
  const q = c.req.query("q");

  const conds = venueConds({ type, area, halal });
  if (q) conds.push(venueNameMatch(q));

  const rows = await getDb(c.env)
    .select()
    .from(venues)
    .where(and(...conds))
    .limit(LIMIT);
  return c.json({ venues: rows });
});

publicApi.get("/venues/:id/items", async (c) => {
  const db = getDb(c.env);
  const venueId = c.req.param("id");
  const [venue] = await db
    .select({ id: venues.id })
    .from(venues)
    .where(and(eq(venues.id, venueId), eq(venues.status, "published")))
    .limit(1);
  if (!venue) return c.json({ error: "venue not found" }, 404);

  const rows = await db
    .select()
    .from(food_items)
    .where(and(eq(food_items.venue_id, venueId), eq(food_items.status, "published"), isNull(food_items.superseded_by)))
    .limit(LIMIT);
  return c.json({ items: rows });
});

publicApi.get("/search", async (c) => {
  const db = getDb(c.env);

  const venueType = oneOf(c.req.query("venue_type"), VENUE_TYPES);
  if (venueType === null) return c.json({ error: "invalid venue_type", allowed: VENUE_TYPES }, 400);
  const itemType = oneOf(c.req.query("item_type"), ITEM_TYPES);
  if (itemType === null) return c.json({ error: "invalid item_type", allowed: ITEM_TYPES }, 400);
  const area = oneOf(c.req.query("area"), AREAS);
  if (area === null) return c.json({ error: "invalid area", allowed: AREAS }, 400);
  const halal = oneOf(c.req.query("halal"), HALAL_STATUSES);
  if (halal === null) return c.json({ error: "invalid halal", allowed: HALAL_STATUSES }, 400);
  const tag = c.req.query("tag");
  const q = c.req.query("q");

  const maxPriceRaw = c.req.query("max_price");
  let maxPrice: number | undefined;
  if (maxPriceRaw !== undefined && maxPriceRaw !== "") {
    maxPrice = Number(maxPriceRaw);
    if (!Number.isFinite(maxPrice) || maxPrice < 0) {
      return c.json({ error: "invalid max_price: must be a non-negative number" }, 400);
    }
  }

  // Venues half: published venues matching venue-level filters + q on names.
  const vConds = venueConds({ type: venueType, area, halal });
  if (q) vConds.push(venueNameMatch(q));
  const venueRows = await db
    .select()
    .from(venues)
    .where(and(...vConds))
    .limit(LIMIT);

  // Items half: live items (published, not superseded) at published venues,
  // constrained by the same venue attribute filters plus item-level filters.
  const iConds: SQL[] = [
    eq(food_items.status, "published"),
    isNull(food_items.superseded_by),
    ...venueConds({ type: venueType, area, halal }),
  ];
  if (itemType) iConds.push(eq(food_items.item_type, itemType));
  if (tag) {
    // `tags` is a JSON array text column; match an exact array element via a
    // correlated json_each subquery (bound parameter, not string concat).
    iConds.push(sql`EXISTS (SELECT 1 FROM json_each(${food_items.tags}) AS je WHERE je.value = ${tag})`);
  }
  if (maxPrice !== undefined) iConds.push(lte(food_items.price_bnd, maxPrice));
  if (q) iConds.push(itemTextMatch(q));

  const itemRows = await db
    .select({ item: food_items })
    .from(food_items)
    .innerJoin(venues, eq(food_items.venue_id, venues.id))
    .where(and(...iConds))
    .limit(LIMIT);

  return c.json({ venues: venueRows, items: itemRows.map((r) => r.item) });
});

export default publicApi;
