# Semantic Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `LIKE %q%` on `/api/search` with multilingual semantic search (Vectorize + Workers AI bge-m3 embeddings), indexed at every publish path, with a LIKE fallback.

**Architecture:** A new `src/lib/search-index.ts` module owns embed-doc building, Workers AI embedding, and Vectorize upsert/delete/query. Publish paths index post-commit (best-effort); `searchPublic` gains a semantic branch that recalls via Vectorize and hydrates from D1 with all existing filters re-applied. D1 stays the source of truth — the index is a rebuildable cache.

**Tech Stack:** Hono + drizzle-orm on Cloudflare Workers; `VectorizeIndex` binding + `env.AI.run` (`@cf/baai/bge-m3`, 1024 dims, cosine); vitest via @cloudflare/vitest-pool-workers.

**Spec:** `docs/superpowers/specs/2026-11-05-semantic-search-design.md`

## Global Constraints

- No D1 schema change — no migration in this plan.
- Search-infra failures never fail a publish or a search: index hooks are wrapped best-effort; the semantic branch falls back to the LIKE path on recall errors.
- `SEARCH_PROVIDER` env values: `"vectorize"` (prod default) | `"like"`. Tests run `like`; the vectorize branch is exercised via wrapped envs + fakes.
- Embedding model var `EMBEDDING_MODEL`, default `@cf/baai/bge-m3`. Score floor `SEARCH_MIN_SCORE`, default `0.5`.
- D1 bound-param cap: chunk `inArray`/`IN` usage at 90, same convention as existing code.
- Vectorize metadata values must be `string | number | boolean` — omit absent fields, never send null.
- Commit style: `feat:` / `fix:` / `test:` / `docs:` conventional prefixes (see `git log`).

## Review Focus

- Whitespace/garbage `q` — semantic branch must trim and treat empty-after-trim as the browse path (no embedding call).
- Recall error mid-search (AI quota, index 5xx) — expect graceful LIKE fallback, never a 500.
- Hydration ordering — `inArray` returns unordered; rows must be re-sorted by vector score.
- Stale-vector leakage — an item the index returns but D1 says hidden/superseded must not appear in results.
- Publish supersede — dropped item ids must leave the index (`unindex`), or dead items stay recallable until reindex.

---

### Task 1: Config surface + search-index core (gate, doc builders, metadata filter)

**Files:**
- Modify: `src/env.ts` (add bindings/vars)
- Modify: `wrangler.toml` (vectorize binding + vars)
- Modify: `vitest.config.ts` (test env `SEARCH_PROVIDER=like`)
- Create: `src/lib/search-index.ts`
- Test: `test/search-index.test.ts`

**Interfaces:**
- Consumes: `Env`, `Db` (`src/db/client.ts`), `FoodItem`, `Venue` (`src/db/schema.ts`).
- Produces (all later tasks rely on these exact names):
  ```ts
  export const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-m3";
  export const DEFAULT_MIN_SCORE = 0.5;

  // Recall-time filters — the subset of PublicSearchFilters the index
  // can pre-narrow on. public.ts maps its filters into this shape.
  export interface SemanticFilters {
    area?: string;
    halal?: string;
    itemType?: string;
    venueType?: string;
    maxPrice?: number;
  }

  export function searchEnabled(env: Env): boolean;
  export function minScore(env: Env): number;
  export function itemDoc(item: FoodItem, venue: Venue): string;
  export function venueDoc(venue: Venue): string;
  export function metadataFilter(kind: "item" | "venue", f: SemanticFilters): VectorizeVectorMetadataFilter;
  ```

- [ ] **Step 1: Write the failing tests**

In `test/search-index.test.ts`, import from `../src/lib/search-index` and seed rows via `test/helpers/seed.ts` conventions (plain objects cast as `FoodItem`/`Venue` are fine — the builders read fields only):

```ts
it("itemDoc embeds bilingual name, description, tags and venue context", () => {
  const doc = itemDoc(
    { name: "Nasi Katok", name_ms: "ناسي کاتوق", description: "rice + sambal + chicken",
      category: "rice", tags: ["spicy"], item_type: "dish", price_bnd: 1.5 } as FoodItem,
    { name: "Kedai A", type: "restaurant", area: "Tutong" } as Venue,
  );
  expect(doc).toContain("Nasi Katok");
  expect(doc).toContain("Kedai A");
  expect(doc).toContain("Tutong");
  expect(doc).toContain("spicy");
});

it("itemDoc drops null fields without stray separators", () => {
  const doc = itemDoc({ name: "Fries", name_ms: null, description: null, category: null,
    tags: [], item_type: "dish" } as unknown as FoodItem, { name: "V", type: "stall", area: "Belait" } as Venue);
  expect(doc).not.toMatch(/null|undefined/);
});

it("metadataFilter maps filters; venue queries ignore item-only keys", () => {
  const f = { area: "Tutong", halal: "halal-certified", itemType: "dish", venueType: "restaurant", maxPrice: 5 };
  expect(metadataFilter("item", f)).toEqual({
    kind: "item", area: "Tutong", halal: "halal-certified",
    item_type: "dish", venue_type: "restaurant", price_bnd: { $lte: 5 },
  });
  expect(metadataFilter("venue", f)).toEqual({
    kind: "venue", area: "Tutong", halal: "halal-certified", venue_type: "restaurant",
  });
});

it("searchEnabled requires provider=vectorize AND the binding", () => {
  expect(searchEnabled({ SEARCH_PROVIDER: "like", SEARCH_INDEX: {} } as unknown as Env)).toBe(false);
  expect(searchEnabled({ SEARCH_PROVIDER: "vectorize" } as unknown as Env)).toBe(false);
  expect(searchEnabled({ SEARCH_PROVIDER: "vectorize", SEARCH_INDEX: {} } as unknown as Env)).toBe(true);
});

it("minScore parses the var, defaults 0.5", () => {
  expect(minScore({} as Env)).toBe(0.5);
  expect(minScore({ SEARCH_MIN_SCORE: "0.7" } as Env)).toBe(0.7);
  expect(minScore({ SEARCH_MIN_SCORE: "junk" } as Env)).toBe(0.5);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/search-index.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/lib/search-index.ts`**

Create the module with exactly the exports in the Interfaces block:

- `itemDoc`: `"{name}"` + `" / {name_ms}"` when present + `" — {description}"` when present + `" | {category} {tags.join(" ")}"` when any of category/tags + `" | {item_type} at {venue.name} ({venue.type}, {venue.area})"`. Trim/join so absent fields leave no separators.
- `venueDoc`: `"{name} / {name_ms} — {type} in {area} — {address} — halal {halal_status}"` with absent fields dropped the same way.
- `metadataFilter`: flat `$eq` entries for `kind`, `area`, `halal`, `venue_type`; `item_type` and `price_bnd: { $lte }` only for `kind="item"`.
- `searchEnabled`: `env.SEARCH_PROVIDER === "vectorize" && !!env.SEARCH_INDEX`.
- `minScore`: `Number(env.SEARCH_MIN_SCORE)`, finite else `DEFAULT_MIN_SCORE`.

- [ ] **Step 4: Wire the config surface**

`src/env.ts` — add:

```ts
  // Semantic search: [[vectorize]] binding + [vars]. Optional — absent or
  // SEARCH_PROVIDER!="vectorize" → searchEnabled() is false and callers
  // keep the LIKE path. See src/lib/search-index.ts.
  SEARCH_INDEX?: VectorizeIndex;
  EMBEDDING_MODEL?: string;
  SEARCH_PROVIDER?: string;
  SEARCH_MIN_SCORE?: string;
```

`wrangler.toml` — append after the `[ai]` block:

```toml
# Semantic search index (src/lib/search-index.ts). Create once per env:
#   npx wrangler vectorize create laparku-search --dimensions=1024 --metric=cosine
#   npx wrangler vectorize create-metadata-index laparku-search --property-name=kind --type=string
#   (repeat for venue_id, venue_type, item_type, area, halal — string — and price_bnd — number)
[[vectorize]]
binding = "SEARCH_INDEX"
index_name = "laparku-search"
```

`[vars]` — add `EMBEDDING_MODEL = "@cf/baai/bge-m3"`, `SEARCH_PROVIDER = "vectorize"`, `SEARCH_MIN_SCORE = "0.5"`.

`vitest.config.ts` `miniflare.bindings` — add `SEARCH_PROVIDER: "like"` (keeps every existing `/api/search` test on the deterministic LIKE path).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run test/search-index.test.ts && bun run typecheck`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add src/env.ts wrangler.toml vitest.config.ts src/lib/search-index.ts test/search-index.test.ts
git commit -m "feat: search-index module — doc builders, metadata filter, provider gate"
```

---

### Task 2: Embed + index mutation + reindex + admin endpoint

**Files:**
- Modify: `src/lib/search-index.ts`
- Modify: `src/routes/admin.ts` (add reindex route)
- Test: `test/search-index.test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces (Task 3+4 rely on):
  ```ts
  export async function embedTexts(env: Env, texts: string[]): Promise<number[][]>;
  export async function indexItems(env: Env, db: Db, itemIds: string[]): Promise<void>;
  export async function indexVenues(env: Env, db: Db, venueIds: string[]): Promise<void>;
  export async function unindex(env: Env, ids: string[]): Promise<void>;
  export async function reindexAll(env: Env, db: Db): Promise<{ items: number; venues: number }>;
  ```
  `indexItems`/`indexVenues`/`unindex` no-op when `!searchEnabled(env)`.

- [ ] **Step 1: Write the failing tests**

Test via wrapped env — spread the real `env` so `getDb` still works, inject fakes:

```ts
const fakeIndex = () => {
  const calls = { upsert: [] as VectorizeVector[][], deleted: [] as string[][] };
  return {
    calls,
    index: {
      upsert: async (v: VectorizeVector[]) => { calls.upsert.push(v); return { ids: v.map((x) => x.id), count: v.length }; },
      deleteByIds: async (ids: string[]) => { calls.deleted.push(ids); return { ids, count: ids.length }; },
      query: async () => ({ matches: [], count: 0 }),
    } as unknown as VectorizeIndex,
  };
};
const fakeAi = {
  run: async (_m: string, input: { text: string[] }) => ({
    shape: [input.text.length, 3],
    data: input.text.map((t) => [t.length, 1, 0.5]),
  }),
} as unknown as Ai;

it("indexItems embeds and upserts vectors with metadata", async () => {
  const { venue } = await seed(env);
  const db = getDb(env);
  const [item] = await db.select().from(food_items).where(eq(food_items.venue_id, venue.id)).limit(1);
  const fi = fakeIndex();
  const w = { ...env, SEARCH_PROVIDER: "vectorize", SEARCH_INDEX: fi.index, AI: fakeAi } as Env;
  await indexItems(w, db, [item!.id]);
  expect(fi.calls.upsert.flat().map((v) => v.id)).toEqual([item!.id]);
  const meta = fi.calls.upsert.flat()[0]!.metadata!;
  expect(meta).toMatchObject({ kind: "item", venue_id: venue.id, venue_type: venue.type, area: venue.area });
});

it("indexItems no-ops when provider is like", async () => {
  const fi = fakeIndex();
  let aiCalled = false;
  const w = { ...env, SEARCH_PROVIDER: "like", SEARCH_INDEX: fi.index,
    AI: { run: async () => { aiCalled = true; return { data: [] }; } } as unknown as Ai } as Env;
  await indexItems(w, getDb(env), ["anything"]);
  expect(aiCalled).toBe(false);
  expect(fi.calls.upsert).toHaveLength(0);
});

it("unindex deletes ids; reindexAll covers live rows and skips hidden", async () => {
  const { venue } = await seed(env);
  const db = getDb(env);
  const fi = fakeIndex();
  const w = { ...env, SEARCH_PROVIDER: "vectorize", SEARCH_INDEX: fi.index, AI: fakeAi } as Env;
  await unindex(w, ["a", "b"]);
  expect(fi.calls.deleted).toEqual([["a", "b"]]);
  const counts = await reindexAll(w, db);
  const upserted = fi.calls.upsert.flat();
  expect(upserted.every((v) => v.metadata?.kind === "item" || v.metadata?.kind === "venue")).toBe(true);
  expect(counts.venues).toBeGreaterThanOrEqual(1);
  expect(counts.items).toBeGreaterThanOrEqual(1);
  // hidden rows must not be indexed
  const [hidden] = await db.insert(food_items).values({
    venue_id: venue.id, item_type: "dish", name: "Ghost", status: "hidden", is_current: false,
  }).returning();
  fi.calls.upsert.length = 0;
  await reindexAll(w, db);
  expect(fi.calls.upsert.flat().map((v) => v.id)).not.toContain(hidden!.id);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/search-index.test.ts`
Expected: FAIL — `embedTexts`/`indexItems`/etc. not exported.

- [ ] **Step 3: Implement in `src/lib/search-index.ts`**

- `embedTexts(env, texts)`: `env.AI.run(env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL, { text: texts })` → `.data` as `number[][]`. Chunk input at 50 texts/call.
- `indexItems`: early-return `!searchEnabled || ids.length===0`. Load items (chunked `inArray`, 90) joined to their venue, build `itemDoc`, embed, `upsert` vectors `{id, values, metadata}` — metadata `{kind:"item", venue_id, venue_type, item_type, area, halal}` + `price_bnd` only when non-null.
- `indexVenues`: same shape for `venueDoc`, metadata `{kind:"venue", venue_type, area, halal}`.
- `unindex`: `env.SEARCH_INDEX.deleteByIds(ids)` gated by `searchEnabled`.
- `reindexAll`: select all `published` venues + all `published AND is_current` items, call `indexVenues`/`indexItems` over full id lists, return counts.

- [ ] **Step 4: Add `POST /api/admin/search/reindex` in `src/routes/admin.ts`**

Inside the existing file (guard `adminApi.use("*", requireAuth(REVIEW_ROLES))` already covers it):

```ts
adminApi.post("/search/reindex", async (c) => {
  const counts = await reindexAll(c.env, getDb(c.env));
  return c.json({ ok: true, ...counts });
});
```

Add a test asserting an unauthenticated request 401s (same pattern as `test/auth.test.ts` guard checks) and — via `adminApi.request("/search/reindex", { method: "POST", headers: reviewerSessionHeaders }, wrappedEnv)` — that it upserts. (Hono's `app.request(path, init, env)` accepts env as the third arg; forge the reviewer session the way the existing admin tests in `test/helpers/auth.ts` do.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run test/search-index.test.ts && bun run typecheck`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add src/lib/search-index.ts src/routes/admin.ts test/search-index.test.ts
git commit -m "feat: embed+upsert indexing, reindexAll, admin reindex endpoint"
```

---

### Task 3: Semantic branch in `searchPublic`

**Files:**
- Modify: `src/lib/search-index.ts` (add `semanticMatches`)
- Modify: `src/routes/public.ts` (`searchPublic` semantic branch)
- Test: `test/search-index.test.ts` or `test/api-public.test.ts`

**Interfaces:**
- Consumes: Task 1–2 exports.
- Produces:
  ```ts
  // Ordered recall — ids best-first, score attached. Floor-filtered.
  export async function semanticMatches(
    env: Env, q: string, f: SemanticFilters,
  ): Promise<{ items: { id: string; score: number }[]; venues: { id: string; score: number }[] }>;
  ```
  `searchPublic` keeps its signature; result rows gain optional `score` when the semantic branch ran.

- [ ] **Step 1: Write the failing tests**

Drive `searchPublic` directly with a wrapped env (fake AI returns fixed vectors; fake index returns canned matches). Seed first:

```ts
const semanticEnv = (matches: Record<string, { id: string; score: number }[]>) => {
  const index = {
    query: async (_v: number[], o: { filter?: Record<string, unknown>; topK?: number }) => ({
      matches: matches[String((o.filter as { kind: string }).kind)] ?? [],
      count: 0,
    }),
    upsert: async () => ({ ids: [], count: 0 }),
    deleteByIds: async () => ({ ids: [], count: 0 }),
  } as unknown as VectorizeIndex;
  return { ...env, SEARCH_PROVIDER: "vectorize", SEARCH_INDEX: index, AI: fakeAi } as Env;
};

it("semantic search hydrates D1 rows ordered by score", async () => {
  const { venue } = await seed(env);
  const db = getDb(env);
  const items = await db.select().from(food_items).limit(3);
  const w = semanticEnv({ item: [
    { id: items[2]!.id, score: 0.9 }, { id: items[0]!.id, score: 0.8 }, { id: items[1]!.id, score: 0.7 },
  ]});
  const r = await searchPublic(w, { q: "spicy rice" });
  expect(r.items.map((i) => i.id)).toEqual([items[2]!.id, items[0]!.id, items[1]!.id]);
  expect((r.items[0] as { score?: number }).score).toBe(0.9);
});

it("score floor drops low-confidence matches; stale rows never leak", async () => {
  const { venue } = await seed(env);
  const db = getDb(env);
  const [live] = await db.select().from(food_items).limit(1);
  const [ghost] = await db.insert(food_items).values({
    venue_id: venue.id, item_type: "dish", name: "Ghost", status: "hidden", is_current: false,
  }).returning();
  const w = semanticEnv({ item: [
    { id: live!.id, score: 0.9 }, { id: ghost!.id, score: 0.95 }, { id: live!.id, score: 0.3 },
  ]});
  const r = await searchPublic(w, { q: "anything", });
  const ids = r.items.map((i) => i.id);
  expect(ids).toContain(live!.id);
  expect(ids).not.toContain(ghost!.id);         // hidden row recalled but filtered at hydration
  expect(ids.filter((x) => x === live!.id)).toHaveLength(1); // deduped double-recall
});

it("whitespace q uses the browse path — no embedding call", async () => {
  let called = false;
  const w = { ...semanticEnv({}), AI: { run: async () => { called = true; return { data: [] }; } } as unknown as Ai } as Env;
  await searchPublic(w, { q: "   " });
  expect(called).toBe(false);
});

it("recall failure falls back to LIKE", async () => {
  const { } = await seed(env);
  const w = {
    ...env, SEARCH_PROVIDER: "vectorize", AI: fakeAi,
    SEARCH_INDEX: { query: async () => { throw new Error("index down"); },
      upsert: async () => ({ ids: [], count: 0 }), deleteByIds: async () => ({ ids: [], count: 0 }),
    } as unknown as VectorizeIndex,
  } as Env;
  const r = await searchPublic(w, { q: "katok" });
  expect(r.items.map((i) => i.name)).toContain("Nasi Katok"); // LIKE path still found it
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/search-index.test.ts`
Expected: FAIL — `semanticMatches` missing / `searchPublic` ignores vectorize.

- [ ] **Step 3: Implement `semanticMatches` in `src/lib/search-index.ts`**

`trim` q; embed once; two `env.SEARCH_INDEX.query(vec, { topK, filter: metadataFilter(kind, f), returnMetadata: "none" })` calls — `topK` 50 for `kind="item"`, 20 for `kind="venue"`; drop matches below `minScore(env)`; return ordered `{id, score}` lists.

- [ ] **Step 4: Wire the semantic branch in `src/routes/public.ts` `searchPublic`**

At the top of `searchPublic`, after `const db = getDb(env)`:

```ts
const q = f.q?.trim();
if (q && searchEnabled(env)) {
  try {
    const recall = await semanticMatches(env, q, {
      area: f.area, halal: f.halal, itemType: f.itemType, venueType: f.venueType, maxPrice: f.maxPrice,
    });
    // hydrate by id with the SAME conds as the LIKE path, then re-sort by score
  } catch {
    /* fall through to LIKE below */
  }
}
```

Hydrate items: existing `iConds` minus the `itemTextMatch(f.q)` clause + `inArray(food_items.id, itemIds)` (chunked 90); map to a `Map<id, row>`; emit in recall order, attach `score`, cap `LIMIT`. Venues identically minus `venueNameMatch`. On any thrown error, log and run the existing LIKE path unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run test/search-index.test.ts test/api-public.test.ts && bun run typecheck`
Expected: PASS — including all existing `/api/search` tests (they run under `SEARCH_PROVIDER=like`).

- [ ] **Step 6: Commit**

```bash
git add src/lib/search-index.ts src/routes/public.ts test/search-index.test.ts
git commit -m "feat: semantic recall in /api/search with LIKE fallback"
```

---

### Task 4: Indexing hooks in the publish paths

**Files:**
- Modify: `src/lib/publish.ts` (`publishSubmission` — collect inserted ids, post-commit index+unindex)
- Modify: `src/lib/trusted-publish.ts` (`trustedPublishScan`)
- Modify: `src/lib/gmaps-publish.ts` (`trustedPublishGmaps`)
- Modify: `src/routes/venues.ts` (create + revive)
- Modify: `src/routes/admin.ts` (`items/:id/unpublish`)
- Test: `test/search-index.test.ts` (or a new `test/search-hooks.test.ts`)

**Interfaces:**
- Consumes: `indexItems`, `indexVenues`, `unindex`, `searchEnabled` from Task 2.
- Produces: nothing new — hooks only.

- [ ] **Step 1: Write the failing tests**

Call the lib functions directly with the wrapped semantic env — they all take `env` as a parameter:

```ts
it("trustedPublishScan indexes published items", async () => {
  const { venue } = await seed(env);
  const db = getDb(env);
  const fi = fakeIndex();
  const w = { ...env, SEARCH_PROVIDER: "vectorize", SEARCH_INDEX: fi.index, AI: fakeAi } as Env;
  // seed a found cache row so the trust gate passes (see scan-intake.test.ts conventions)
  await trustedPublishScan(db, { userId: user.id, venueId: venue.id, provenance: "t",
    items: [{ barcode: "1234567890123", name: "Kangkong Chips", source_tags: ["openfoodfacts"] }] }, w);
  expect(fi.calls.upsert.flat().map((v) => v.metadata?.kind)).toContain("item");
});

it("publishSubmission indexes new items and unindexes superseded ones", async () => {
  // approve a pending_review submission via publishSubmission with wrapped env;
  // assert upsert includes the new item ids and calls.deleted includes the
  // venue's previously-current item ids.
});

it("admin unpublish unindexes the item", async () => {
  const { venue } = await seed(env);
  const db = getDb(env);
  const [item] = await db.select().from(food_items).limit(1);
  const fi = fakeIndex();
  const w = { ...env, SEARCH_PROVIDER: "vectorize", SEARCH_INDEX: fi.index, AI: fakeAi } as Env;
  const res = await adminApi.request(`/items/${item!.id}/unpublish`, { method: "POST" }, w);
  expect(res.status).toBe(200);
  expect(fi.calls.deleted.flat()).toContain(item!.id);
});
```

(Scan-trust-gate seeding mirrors `test/scan-intake.test.ts` — copy its product_lookup_cache fixture.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/search-index.test.ts`
Expected: FAIL — no upserts/deletes recorded.

- [ ] **Step 3: `publish.ts` — collect ids + post-commit hooks**

In `publishSubmission`: add `.returning({ id: food_items.id })` to the chunked insert loop and collect `insertedIds`. `PublishResult` gains `inserted_ids: string[]` and `superseded_ids: string[]` (the `dropIds` that actually flipped — collect from the supersede `.returning`). After the try/catch (post-commit, beside `notifyPublished`):

```ts
try {
  await indexVenues(env, db, [result.venue_id]);
  await indexItems(env, db, result.inserted_ids);
  if (result.superseded_ids.length) await unindex(env, result.superseded_ids);
} catch (e) {
  console.error("search index hook failed", e);
}
```

(Only when `searchEnabled` — the functions no-op anyway, so no gate needed at the call site.)

- [ ] **Step 4: `trusted-publish.ts` + `gmaps-publish.ts`**

Both already mint item ids explicitly (`const id = crypto.randomUUID()` before each insert). Collect the ids that actually inserted; after the success branch (where `notifyTrustedPublish` is awaited):

```ts
try { await indexItems(env, db, publishedIds); } catch (e) { console.error("search index hook failed", e); }
```

- [ ] **Step 5: `venues.ts` + `admin.ts`**

- `venues.ts` POST /venues: after the create returns 201 and after the revive branch returns 200 → `indexVenues(c.env, db, [venue.id])` in try/catch (dedup-hit returns an existing published row — already indexed, no call needed; a revive call covers the unindexed-dead-row case).
- `admin.ts` `items/:id/unpublish`: after the claimed update → `unindex(c.env, [id])` in try/catch.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bunx vitest run test/search-index.test.ts && bun run test && bun run typecheck`
Expected: PASS — full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/publish.ts src/lib/trusted-publish.ts src/lib/gmaps-publish.ts src/routes/venues.ts src/routes/admin.ts test/search-index.test.ts
git commit -m "feat: index items/venues on every publish path, unindex on removal"
```

---

### Task 5: Deploy wiring — DEPLOY-NOTES + smoke checklist

**Files:**
- Modify: `DEPLOY-NOTES.md`
- Modify: `README.md` (one-liner in Notes)

- [ ] **Step 1: Document the one-time resource setup**

Add to `DEPLOY-NOTES.md` in the resource-inventory style already there:

```bash
npx wrangler vectorize create laparku-search --dimensions=1024 --metric=cosine
for p in kind venue_id venue_type item_type area halal; do
  npx wrangler vectorize create-metadata-index laparku-search --property-name=$p --type=string
done
npx wrangler vectorize create-metadata-index laparku-search --property-name=price_bnd --type=number
```

Note the post-deploy smoke steps: deploy → `POST /api/admin/search/reindex` (one-time backfill) → `GET /api/search?q=kangkong` sanity → `SEARCH_PROVIDER=like` is the documented kill switch (var flip + redeploy).

- [ ] **Step 2: One line in `README.md` Notes**

`/api/search` is semantic (Vectorize + bge-m3) when `SEARCH_PROVIDER=vectorize`; `like` falls back to substring matching — e.g. for offline dev.

- [ ] **Step 3: Final verification**

Run: `bun run test && bun run typecheck`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add DEPLOY-NOTES.md README.md
git commit -m "docs: vectorize index setup + search provider kill switch"
```

---

## Self-Review notes

- Spec coverage: indexing hooks (publish×3, venue create/revive, unpublish), semantic query path, metadata filter, score floor, LIKE fallback, reindex endpoint, config surface, deploy docs — all mapped to tasks.
- Deferred per spec: allergens column, LLM parse step, FTS5 — none in this plan.
- Type consistency: `SemanticFilters`/`semanticMatches`/`indexItems`/`indexVenues`/`unindex`/`reindexAll`/`searchEnabled`/`minScore`/`itemDoc`/`venueDoc`/`metadataFilter` used identically across tasks.
