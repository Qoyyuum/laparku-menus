import { and, eq, inArray, lte, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { getDb, type Db } from "../db/client";
import { AREAS, food_items, HALAL_STATUSES, ITEM_TYPES, venues, VENUE_TYPES, type FoodItem } from "../db/schema";
import type { Env } from "../env";
import { staleMonths, withFreshness } from "../lib/freshness";

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

// --- shared query helpers -------------------------------------------------
// These are the Task-4 read internals. The Hono routes below are thin
// param-parsing shells over them; the MCP tools in src/mcp.ts call the same
// helpers so HTTP and MCP can never drift apart.

export interface PublicVenueFilters extends VenueFilters {
  q?: string;
  // `stub` narrows to "menu needed" placeholders (true) or venues with a
  // real menu (false); absent returns both. Used by the coverage page's
  // stub list via `GET /api/venues?stub=true`.
  stub?: boolean;
}

export async function listPublishedVenues(env: Env, f: PublicVenueFilters) {
  const conds = venueConds(f);
  if (f.stub !== undefined) conds.push(eq(venues.is_stub, f.stub));
  if (f.q) conds.push(venueNameMatch(f.q));
  const rows = await getDb(env)
    .select()
    .from(venues)
    .where(and(...conds))
    .limit(LIMIT);
  // Every venue row carries the derived freshness badge (fresh/aging/stale
  // from last_verified_at vs STALE_MONTHS — see src/lib/freshness.ts).
  const months = staleMonths(env);
  return rows.map((v) => withFreshness(v, months));
}

// Null when the venue doesn't exist or isn't published — callers decide the
// surface-level error (HTTP 404 vs MCP tool error).
export async function listVenueItems(env: Env, venueId: string) {
  const db = getDb(env);
  const [venue] = await db
    .select({ id: venues.id })
    .from(venues)
    .where(and(eq(venues.id, venueId), eq(venues.status, "published")))
    .limit(1);
  if (!venue) return null;

  const items = await db
    .select()
    .from(food_items)
    .where(and(eq(food_items.venue_id, venueId), eq(food_items.status, "published"), eq(food_items.is_current, true)))
    .limit(LIMIT);
  return withContribCredit(db, items);
}

// Task 7 (rewards): per-item contributor credit. Each item traces to the
// submission it was published from via source_submission_id; the
// submission's user can opt into public credit (user.show_credit) and their
// display_name then rides the item payload as `contributed_by`. The names
// resolve in ONE batch query for the whole result set — never a per-item
// N+1 — keyed by submission id so repeated sources look up once. `user` is
// the untracked better-auth table, so the join is raw SQL (same convention
// as leaderboards.ts). Opt-out users, opted-in-but-nameless rows, anonymous
// (user-less) submissions and items with no source all carry no
// contributed_by key — an opted-out display_name never leaves the DB.
async function withContribCredit(
  db: Db,
  items: FoodItem[],
): Promise<(FoodItem & { contributed_by?: string })[]> {
  const subIds = [
    ...new Set(items.map((i) => i.source_submission_id).filter((x): x is string => !!x)),
  ];
  const credit = new Map<string, string>();
  // ids ≤ LIMIT (100) today; chunk anyway so a raised LIMIT can't push the
  // IN clause past D1's ~100 bound-param cap.
  for (let off = 0; off < subIds.length; off += 90) {
    const rows = (await db.all(sql`
      SELECT s.id AS sid, u.display_name AS name
      FROM submissions AS s
      JOIN "user" AS u ON u.id = s.user_id
      WHERE ${inArray(sql`s.id`, subIds.slice(off, off + 90))}
        AND u.show_credit = 1
        AND u.display_name IS NOT NULL
        AND u.display_name <> ''
    `)) as { sid: string; name: string }[];
    for (const r of rows) credit.set(String(r.sid), String(r.name));
  }
  return items.map((i) => {
    const name = i.source_submission_id ? credit.get(i.source_submission_id) : undefined;
    return name ? { ...i, contributed_by: name } : { ...i };
  });
}

export interface PublicSearchFilters {
  venueType?: (typeof VENUE_TYPES)[number];
  itemType?: (typeof ITEM_TYPES)[number];
  area?: (typeof AREAS)[number];
  halal?: (typeof HALAL_STATUSES)[number];
  tag?: string;
  q?: string;
  maxPrice?: number;
}

export async function searchPublic(env: Env, f: PublicSearchFilters) {
  const db = getDb(env);

  // Venues half: published venues matching venue-level filters + q on names.
  const vConds = venueConds({ type: f.venueType, area: f.area, halal: f.halal });
  if (f.q) vConds.push(venueNameMatch(f.q));
  const venueRows = await db
    .select()
    .from(venues)
    .where(and(...vConds))
    .limit(LIMIT);

  // Items half: current items (published + is_current) at published venues,
  // constrained by the same venue attribute filters plus item-level filters.
  const iConds: SQL[] = [
    eq(food_items.status, "published"),
    eq(food_items.is_current, true),
    ...venueConds({ type: f.venueType, area: f.area, halal: f.halal }),
  ];
  if (f.itemType) iConds.push(eq(food_items.item_type, f.itemType));
  if (f.tag) {
    // `tags` is a JSON array text column; match an exact array element via a
    // correlated json_each subquery (bound parameter, not string concat).
    iConds.push(sql`EXISTS (SELECT 1 FROM json_each(${food_items.tags}) AS je WHERE je.value = ${f.tag})`);
  }
  if (f.maxPrice !== undefined) iConds.push(lte(food_items.price_bnd, f.maxPrice));
  if (f.q) iConds.push(itemTextMatch(f.q));

  const itemRows = await db
    .select({ item: food_items })
    .from(food_items)
    .innerJoin(venues, eq(food_items.venue_id, venues.id))
    .where(and(...iConds))
    .limit(LIMIT);

  const months = staleMonths(env);
  return {
    venues: venueRows.map((v) => withFreshness(v, months)),
    items: await withContribCredit(db, itemRows.map((r) => r.item)),
  };
}

// --- routes ---------------------------------------------------------------

const publicApi = new Hono<{ Bindings: Env }>();

publicApi.get("/venues", async (c) => {
  const type = oneOf(c.req.query("type"), VENUE_TYPES);
  if (type === null) return c.json({ error: "invalid type", allowed: VENUE_TYPES }, 400);
  const area = oneOf(c.req.query("area"), AREAS);
  if (area === null) return c.json({ error: "invalid area", allowed: AREAS }, 400);
  const halal = oneOf(c.req.query("halal"), HALAL_STATUSES);
  if (halal === null) return c.json({ error: "invalid halal", allowed: HALAL_STATUSES }, 400);

  // `stub` is the only non-enum filter — a strict boolean string.
  const stubRaw = c.req.query("stub");
  let stub: boolean | undefined;
  if (stubRaw !== undefined && stubRaw !== "") {
    if (stubRaw !== "true" && stubRaw !== "false") {
      return c.json({ error: "invalid stub", allowed: ["true", "false"] }, 400);
    }
    stub = stubRaw === "true";
  }

  const rows = await listPublishedVenues(c.env, { type, area, halal, stub, q: c.req.query("q") });
  return c.json({ venues: rows });
});

// GET /api/stats — public site-wide totals for the about/landing surfaces:
// published venues, current published items, distinct contributors (users
// who filed at least one submission) and total check-ins. One round-trip via
// scalar subselects.
publicApi.get("/stats", async (c) => {
  const [row] = (await getDb(c.env).all(sql`
    SELECT
      (SELECT count(*) FROM venues WHERE status = 'published') AS venues,
      (SELECT count(*) FROM food_items WHERE status = 'published' AND is_current = 1) AS items,
      (SELECT count(DISTINCT user_id) FROM submissions WHERE user_id IS NOT NULL) AS contributors,
      (SELECT count(*) FROM check_ins) AS checkins
  `)) as { venues: number; items: number; contributors: number; checkins: number }[];
  return c.json({
    venues: Number(row?.venues ?? 0),
    items: Number(row?.items ?? 0),
    contributors: Number(row?.contributors ?? 0),
    checkins: Number(row?.checkins ?? 0),
  });
});

publicApi.get("/venues/:id/items", async (c) => {
  const rows = await listVenueItems(c.env, c.req.param("id"));
  if (!rows) return c.json({ error: "venue not found" }, 404);
  return c.json({ items: rows });
});

publicApi.get("/search", async (c) => {
  const venueType = oneOf(c.req.query("venue_type"), VENUE_TYPES);
  if (venueType === null) return c.json({ error: "invalid venue_type", allowed: VENUE_TYPES }, 400);
  const itemType = oneOf(c.req.query("item_type"), ITEM_TYPES);
  if (itemType === null) return c.json({ error: "invalid item_type", allowed: ITEM_TYPES }, 400);
  const area = oneOf(c.req.query("area"), AREAS);
  if (area === null) return c.json({ error: "invalid area", allowed: AREAS }, 400);
  const halal = oneOf(c.req.query("halal"), HALAL_STATUSES);
  if (halal === null) return c.json({ error: "invalid halal", allowed: HALAL_STATUSES }, 400);

  const maxPriceRaw = c.req.query("max_price");
  let maxPrice: number | undefined;
  if (maxPriceRaw !== undefined && maxPriceRaw !== "") {
    maxPrice = Number(maxPriceRaw);
    if (!Number.isFinite(maxPrice) || maxPrice < 0) {
      return c.json({ error: "invalid max_price: must be a non-negative number" }, 400);
    }
  }

  const result = await searchPublic(c.env, {
    venueType,
    itemType,
    area,
    halal,
    tag: c.req.query("tag"),
    q: c.req.query("q"),
    maxPrice,
  });
  return c.json(result);
});

export default publicApi;
