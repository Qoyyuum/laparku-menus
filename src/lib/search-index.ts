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
