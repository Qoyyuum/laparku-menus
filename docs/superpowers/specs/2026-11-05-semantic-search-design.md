# Semantic search (Vectorize + Workers AI) — design

**Date:** 2026-11-05
**Status:** approved

## Intent

Replace `LIKE %q%` substring matching on `/api/search` with multilingual
semantic search while the corpus is still small, so every item and venue
is indexed from the day it publishes. This is approach **A** (semantic
baseline) built with seams for approach **B** (LLM query-parse + hard
constraints like allergen exclusion and price caps) later.

## Goals / non-goals / anti-goals

**Goals**

- `q` does semantic recall: Malay/English mixing in one query, typo and
  misspelling tolerance, concept matches ("kangkong" ↔ "water spinach",
  "sayur" ↔ "vegetable").
- Every path that makes items/venues live also indexes them; rows that
  leave the public menu (superseded, hidden, venue closed) leave the
  index.
- The index is a rebuildable cache. D1 stays the source of truth —
  every existing filter (`published`, `is_current`, area, halal, type,
  tag, max_price) still applies at hydration, so a stale vector can
  never surface a dead row.
- Offline-safe: a provider var falls back to today's LIKE path for
  tests and devs without the binding.

**Non-goals** (explicitly deferred to B)

- Allergen exclusion and must-have terms — needs an `allergens`/
  `contains` column plus a data-population path (OFF tags for products,
  extractor guess + reviewer confirm for dishes).
- LLM query-understanding ("cheap nutritious food must have kangkong")
  — the parse step lands in B in front of this same pipeline.
- FTS5 lexical index — may join B as the exact/must-have matcher; not
  needed for A.

**Anti-goals**

- Never fail a publish because search infra is down or slow — indexing
  is post-commit, best-effort, repairable.
- Never return non-published or non-current rows.
- No LLM call per keystroke — a query costs one embedding call.

## Approaches considered

- **A — Vectorize + Workers AI embeddings (chosen).** Semantic recall,
  language mixing and typo tolerance with one new resource and no schema
  change. Weak on negation/exclusions — accepted, that's what B is for.
- **B — LLM query-parse → structured + semantic hybrid.** The honest
  shape for "exclude X, must have Y"; deferred — needs the allergens
  data model first, and it builds on A's pipeline anyway.
- **C — D1 FTS5 only.** Cheapest, but purely lexical: "sayur" never
  matches "vegetable" and "nutritious" means nothing to it. Doesn't meet
  the goal alone.

## Data model

- New resource: Vectorize index **`laparku-search`**, 1024 dimensions,
  cosine metric. Created once per environment via wrangler (below);
  bound as `SEARCH_INDEX`.
- **One index, two kinds** — vector id = the row's uuid (venue and item
  uuids can't collide), `kind` metadata distinguishes `"item"`/`"venue"`.
- Indexed metadata (for query-time pre-filtering): `kind`, `venue_id`,
  `item_type`, `area`, `halal`, `price_bnd`. Everything else is
  re-checked at hydration.
- **No D1 schema change** — nothing to migrate.

### Embedding documents

- Item: `"{name} / {name_ms} — {description} | {category} {tags} |
  {item_type} at {venue_name} ({venue_type}, {area})"` — nulls dropped.
- Venue: `"{name} / {name_ms} — {venue_type} in {area} — {address} —
  halal {halal_status}"`.

Venue name rides inside the item doc so "kedai X nasi lemak" works.
Tradeoff (my call): a venue rename stale-dates its items' docs — the
admin reindex endpoint is the repair, and a venue-edit hook re-embeds
that venue's items cheaply at this corpus size.

## Indexing

New module `src/lib/search-index.ts`:

- `itemDoc(item, venue)` / `venueDoc(venue)` — text builders.
- `embedTexts(env, texts)` — `env.AI.run(env.EMBEDDING_MODEL, { text })`,
  batched (bge-m3 accepts string arrays; chunk to keep payloads sane).
- `indexItems(env, db, itemIds)` / `indexVenues(env, db, venueIds)` —
  load rows, build docs, embed, `SEARCH_INDEX.upsert` with metadata.
- `unindex(env, ids)` — `SEARCH_INDEX.deleteByIds`.
- `reindexAll(env, db)` — every `published + is_current` item and
  `published` venue, chunked; the one-time backfill and the repair path.

Hook points — post-commit, same slot the notify emails already use
(awaited so work doesn't race a post-response freeze, wrapped so a
search-infra failure logs and never fails the publish):

- `publishSubmission` — upsert inserted items + the venue; `unindex`
  the superseded id set.
- `trustedPublishScan` / `trustedPublishGmaps` — upsert published items.
- `venues.ts` trusted-create / OSM pick — upsert the new venue.
- `admin.ts` — item hide → `unindex`; unhide → re-index; venue
  closed/draft → `unindex` venue + its items.

## Query path

`searchPublic` (`src/routes/public.ts`) gains a semantic branch, shared
by HTTP and MCP unchanged:

- `q` present + `SEARCH_PROVIDER="vectorize"` + binding present →
  embed `q` once → two queries (`kind=item` topK 50, `kind=venue`
  topK 20) with a metadata filter built from `f` (area/halal/
  item_type/venue_type/price `$lte`) → hydrate rows by id via the
  existing selects (all filters re-applied — metadata narrows recall,
  D1 decides truth) → order by score → cap at LIMIT.
- `SEARCH_MIN_SCORE` floor (var, default `0.5`) drops low-confidence
  tail noise; tuned on real queries.
- `q` empty, provider `like`, or binding absent → today's LIKE/browse
  path byte-for-byte. That's the kill switch and the test path.

Response shape is unchanged — `score` rides along per row for the app
to use later, ignored by the current UI.

## Config

- `wrangler.toml`: `[[vectorize]] binding = "SEARCH_INDEX"
  index_name = "laparku-search"`; vars `EMBEDDING_MODEL =
  "@cf/baai/bge-m3"`, `SEARCH_PROVIDER = "vectorize"`,
  `SEARCH_MIN_SCORE = "0.5"`.
- One-time per env (deploy notes):
  `npx wrangler vectorize create laparku-search --dimensions=1024
  --metric=cosine`, then `create-metadata-index` for each filterable
  property above.
- `env.ts`: `SEARCH_INDEX?: VectorizeIndex`, `EMBEDDING_MODEL`,
  `SEARCH_PROVIDER`, `SEARCH_MIN_SCORE`.
- `.dev.vars`/`vitest.config.ts`: `SEARCH_PROVIDER=like` keeps dev and
  tests offline-deterministic; the vectorize branch is unit-tested with
  a fake `VectorizeIndex`.
- Admin: `POST /api/admin/search/reindex` (same auth as other admin
  routes) → `reindexAll`; run once after the first deploy.

## Costs

bge-m3 embedding calls and a 1024-dim Vectorize index sit far inside
Workers AI / Vectorize free tiers at this corpus size (thousands of
vectors, tens of queries/day). Publish-time embedding adds ~100–300 ms
to the post-commit slot — same order as the notify email it runs next
to.

## Grow path to B

`search-index.ts` is the seam. B adds: an `allergens`/`contains` column
+ populate path, an LLM parse step in front of the semantic branch
turning `q` into `{semantic, must_have, exclude_allergens, max_price}`,
and possibly an FTS5 matcher for must-have terms. None of it touches
the indexing pipeline this builds.

## Open risks

- bge-m3 recall quality on Brunei Malay / mixed-language queries is
  unverifiable until real traffic — `SEARCH_PROVIDER=like` is the
  escape hatch and costs nothing to keep.
- Metadata filters require the properties to be registered as indexed
  at index setup; a forgotten `create-metadata-index` fails loudly at
  query time, easy to catch in the deploy smoke test.
