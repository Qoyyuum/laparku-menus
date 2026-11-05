import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { food_items, venues } from "../db/schema";
import type { Env } from "../env";
import type { FoodItem, Venue } from "../db/schema";

// Semantic search: bge-m3 embeddings (1024-dim, multilingual — covers the
// Malay/English query mixing this dataset sees) upserted into the
// SEARCH_INDEX Vectorize binding. D1 stays the source of truth — the index
// is a rebuildable cache; every public filter is re-applied at hydration.
export const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const DEFAULT_MIN_SCORE = 0.5;

// Recall-time filters — the subset of PublicSearchFilters the index can
// pre-narrow on. public.ts maps its filters into this shape.
export interface SemanticFilters {
  area?: string;
  halal?: string;
  itemType?: string;
  venueType?: string;
  maxPrice?: number;
}

// "vectorize" + a bound SEARCH_INDEX switches /api/search onto the semantic
// path; anything else keeps the LIKE substring path (tests, offline dev,
// and the production kill switch).
export function searchEnabled(env: Env): boolean {
  return env.SEARCH_PROVIDER === "vectorize" && !!env.SEARCH_INDEX;
}

export function minScore(env: Env): number {
  const n = Number(env.SEARCH_MIN_SCORE);
  return Number.isFinite(n) ? n : DEFAULT_MIN_SCORE;
}

// The text an item's vector is embedded from. Venue context rides along so
// "kedai X nasi lemak" recalls the dish — the tradeoff is a venue rename
// stale-dates its items' docs until reindex (admin endpoint).
export function itemDoc(item: FoodItem, venue: Venue): string {
  let doc = item.name_ms ? `${item.name} / ${item.name_ms}` : item.name;
  if (item.description) doc += ` — ${item.description}`;
  const cat = [item.category, ...(item.tags ?? [])].filter(Boolean).join(" ");
  if (cat) doc += ` | ${cat}`;
  doc += ` | ${item.item_type} at ${venue.name} (${venue.type}, ${venue.area})`;
  return doc;
}

export function venueDoc(venue: Venue): string {
  const parts: string[] = [venue.name_ms ? `${venue.name} / ${venue.name_ms}` : venue.name];
  parts.push(`${venue.type} in ${venue.area}`);
  if (venue.address) parts.push(venue.address);
  parts.push(`halal ${venue.halal_status}`);
  return parts.join(" — ");
}

// Pre-recall narrowing only — hydration re-checks everything. Metadata
// values must be string|number|boolean: absent filters are omitted, never
// null. Item-only keys (item_type, price_bnd) don't apply to venue queries.
export function metadataFilter(
  kind: "item" | "venue",
  f: SemanticFilters,
): VectorizeVectorMetadataFilter {
  const filter: Record<string, unknown> = { kind };
  if (f.area) filter.area = f.area;
  if (f.halal) filter.halal = f.halal;
  if (f.venueType) filter.venue_type = f.venueType;
  if (kind === "item") {
    if (f.itemType) filter.item_type = f.itemType;
    if (f.maxPrice !== undefined) filter.price_bnd = { $lte: f.maxPrice };
  }
  return filter as VectorizeVectorMetadataFilter;
}

// bge-m3 accepts a text array per call; 50 keeps payloads comfortably small.
const EMBED_CHUNK = 50;

export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  const model = env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  const vectors: number[][] = [];
  for (let off = 0; off < texts.length; off += EMBED_CHUNK) {
    const res = (await env.AI.run(model, { text: texts.slice(off, off + EMBED_CHUNK) })) as {
      data: number[][];
    };
    vectors.push(...res.data);
  }
  return vectors;
}

// Index the live rows among `itemIds`. The status/is_current filter inside
// the load means callers can pass ids blindly — rows that aren't public
// simply don't produce vectors (unindex is the removal path).
export async function indexItems(env: Env, db: Db, itemIds: string[]): Promise<void> {
  if (!searchEnabled(env) || itemIds.length === 0) return;
  const rows: { item: FoodItem; venue: Venue }[] = [];
  for (let off = 0; off < itemIds.length; off += 90) {
    rows.push(
      ...(await db
        .select({ item: food_items, venue: venues })
        .from(food_items)
        .innerJoin(venues, eq(food_items.venue_id, venues.id))
        .where(
          and(
            inArray(food_items.id, itemIds.slice(off, off + 90)),
            eq(food_items.status, "published"),
            eq(food_items.is_current, true),
            eq(venues.status, "published"),
          ),
        )),
    );
  }
  if (rows.length === 0) return;
  const vectors = await embedTexts(env, rows.map((r) => itemDoc(r.item, r.venue)));
  await env.SEARCH_INDEX!.upsert(
    rows.map((r, i) => ({
      id: r.item.id,
      values: vectors[i]!,
      metadata: {
        kind: "item",
        venue_id: r.venue.id,
        venue_type: r.venue.type,
        item_type: r.item.item_type,
        area: r.venue.area,
        halal: r.venue.halal_status,
        ...(r.item.price_bnd !== null ? { price_bnd: r.item.price_bnd } : {}),
      },
    })),
  );
}

export async function indexVenues(env: Env, db: Db, venueIds: string[]): Promise<void> {
  if (!searchEnabled(env) || venueIds.length === 0) return;
  const rows: Venue[] = [];
  for (let off = 0; off < venueIds.length; off += 90) {
    rows.push(
      ...(await db
        .select()
        .from(venues)
        .where(and(inArray(venues.id, venueIds.slice(off, off + 90)), eq(venues.status, "published")))),
    );
  }
  if (rows.length === 0) return;
  const vectors = await embedTexts(env, rows.map(venueDoc));
  await env.SEARCH_INDEX!.upsert(
    rows.map((v, i) => ({
      id: v.id,
      values: vectors[i]!,
      metadata: { kind: "venue", venue_type: v.type, area: v.area, halal: v.halal_status },
    })),
  );
}

export async function unindex(env: Env, ids: string[]): Promise<void> {
  if (!searchEnabled(env) || ids.length === 0) return;
  await env.SEARCH_INDEX!.deleteByIds(ids);
}

// Full rebuild — the one-time backfill after the index is created and the
// repair path when vectors stale-date. Upserts are idempotent on id, so a
// repeat run converges rather than duplicating.
// Ordered recall for one query: embed q once, run one Vectorize query per
// kind (independent topKs), floor-filter, and return ids best-first with
// scores. Callers hydrate rows from D1 — this never returns data itself.
export async function semanticMatches(
  env: Env,
  q: string,
  f: SemanticFilters,
): Promise<{ items: { id: string; score: number }[]; venues: { id: string; score: number }[] }> {
  const [vec] = await embedTexts(env, [q.trim()]);
  const floor = minScore(env);
  const recall = async (kind: "item" | "venue", topK: number) => {
    const res = await env.SEARCH_INDEX!.query(vec!, {
      topK,
      filter: metadataFilter(kind, f),
      returnMetadata: "none",
    });
    // Same id can recur in a match list (stale duplicate vectors); keep the
    // first — the highest score — so hydration emits each row once.
    const seen = new Set<string>();
    return res.matches
      .filter((m) => m.score >= floor)
      .flatMap((m) => (seen.has(m.id) ? [] : (seen.add(m.id), [{ id: m.id, score: m.score }])));
  };
  return { items: await recall("item", 50), venues: await recall("venue", 20) };
}

export async function reindexAll(env: Env, db: Db): Promise<{ items: number; venues: number }> {
  const venueIds = (await db.select({ id: venues.id }).from(venues).where(eq(venues.status, "published"))).map(
    (r) => r.id,
  );
  const itemIds = (
    await db
      .select({ id: food_items.id })
      .from(food_items)
      .where(and(eq(food_items.status, "published"), eq(food_items.is_current, true)))
  ).map((r) => r.id);
  await indexVenues(env, db, venueIds);
  await indexItems(env, db, itemIds);
  return { items: itemIds.length, venues: venueIds.length };
}
