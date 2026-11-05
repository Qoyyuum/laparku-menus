# Open Food Facts Write-Back Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push reviewed, published packaged-product data to Open Food Facts on a scheduled, batched, retryable pipeline, with a manual admin drain for backfill/testing.

**Architecture:** A cron (hourly 22:00–09:00 Brunei, UTC `0 14-23,0-1 * * *`) scans `food_items` for OFF-eligible products, records them in a new `off_push` outbox table, and enqueues one message per item on a new `laparku-menus-off-push` Cloudflare Queue. The consumer probes OFF (all normalized barcode candidates), then creates the product or enriches an existing one with additive `countries`/`stores` tags, marks the outbox row, and links `food_items.off_barcode`.

**Tech Stack:** Cloudflare Workers (Hono, scheduled events, Queues), drizzle-orm/D1, vitest-pool-workers (miniflare), Open Food Facts write API v2 (`POST /cgi/product_jqm2.pl`).

**Spec:** `docs/superpowers/specs/2026-11-05-off-writeback-design.md`

## Global Constraints

- `bun run test` must stay green (127 tests); `bun run typecheck` must pass.
- Tests never hit the network: `vi.stubGlobal("fetch", ...)` for all OFF calls (pattern: `test/product-lookup.test.ts`).
- OFF writes only go to `env.OFF_BASE_URL` (default `https://bn.openfoodfacts.org`); secrets `OFF_USER_ID`/`OFF_USER_PASSWORD` via `wrangler secret put`, never in `wrangler.toml`.
- OFF write success = response JSON `status: 1` (`"fields saved"`); anything else is an error.
- Eligible item = `item_type='product' AND is_current AND status='published' AND pending_verification=false AND barcode NOT NULL AND off_barcode IS NULL`, minus OFF-family-sourced, commercial-sourced, and lookup-cache-OFF-hit rows.
- `OFF_PUSH_BATCH` default `25` items per drain.
- D1 ~100 bound-param cap: chunk any large `IN` clause at 90 (existing convention in publish.ts).

## Review Focus

- UPC-E item whose OFF record exists under its UPC-A expansion → probe walks `normalizeBarcode(...).candidates`, links the hit code, never creates a duplicate (Task 5).
- Item carrying a commercial `barcode_source` (eansearch/upcitemdb/barcodelookup) → never queued, even with `pending_verification=false` (Task 4).
- Item hidden/superseded between enqueue and consume → outbox `skipped`, not `failed` (Task 5).
- OFF 5xx/timeout mid-batch → `msg.retry()`, final attempt marks `failed` (Task 5).
- Item whose barcode fails `normalizeBarcode` → outbox `skipped` immediately; never retried, never blocks the batch (Task 4).

---

### Task 1: `off_push` schema, env bindings, wrangler wiring

**Files:**
- Create: `migrations/0008_off_push.sql`
- Modify: `src/db/schema.ts` (append table + statuses + types)
- Modify: `src/env.ts` (add bindings/vars)
- Modify: `wrangler.toml` (queue producer/consumer, `[triggers]`, vars)
- Test: `test/off-push.test.ts`

**Interfaces:**
- Produces:
  - `OFF_PUSH_STATUSES = ["pending","sent","linked","skipped","failed"] as const` and `type OffPushStatus`
  - `off_push` drizzle table: `id` (uuid PK), `item_id` (text, UNIQUE, → food_items.id), `barcode` (text notNull), `status` (enum notNull default `"pending"`), `attempts` (int notNull default 0), `last_error` (text), `created_at`, `sent_at` (timestamp_ms, nullable) — plus index on `status`
  - Env: `OFF_PUSH_QUEUE: Queue`, `OFF_PUSH_BATCH?: string`, `OFF_BASE_URL?: string`, `OFF_USER_ID?: string`, `OFF_USER_PASSWORD?: string`
- Consumes: nothing (foundation task)

- [ ] **Step 1: Write the failing test**

```ts
// test/off-push.test.ts
import { env } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";

it("off_push table exists with unique item_id", async () => {
  const db = getDb(env);
  await db.run(sql`INSERT INTO off_push (id, item_id, barcode) VALUES ('a','i1','123')`);
  await expect(
    db.run(sql`INSERT INTO off_push (id, item_id, barcode) VALUES ('b','i1','123')`),
  ).rejects.toThrow(/unique/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/off-push.test.ts`
Expected: FAIL (no such table: off_push)

- [ ] **Step 3: Create migration + drizzle schema + env + wrangler wiring**

`migrations/0008_off_push.sql`: `CREATE TABLE off_push (...)` matching the column list in Interfaces; `item_id TEXT NOT NULL UNIQUE REFERENCES food_items(id)`; `CREATE INDEX off_push_status_idx ON off_push(status)`. Follow 0007's file style.

`src/db/schema.ts`: append `OFF_PUSH_STATUSES`, `off_push` table, `OffPush`/`NewOffPush` types — same helpers (`id()`, `createdAt()`) as neighbors.

`src/env.ts`: add the five entries per Interfaces (OFF_PUSH_QUEUE required like SUBMISSION_QUEUE; vars optional).

`wrangler.toml`: append after the existing queues block:
```toml
[[queues.producers]]
binding = "OFF_PUSH_QUEUE"
queue = "laparku-menus-off-push"

[[queues.consumers]]
queue = "laparku-menus-off-push"
max_retries = 3

[triggers]
# Hourly 22:00→09:00 Brunei (UTC+8): end-of-day + start-of-day pushes
# with an hourly drain between.
crons = ["0 14-23,0-1 * * *"]
```
and `[vars]` additions: `OFF_PUSH_BATCH = "25"`, `OFF_BASE_URL = "https://bn.openfoodfacts.org"`. Extend the secrets comment to mention `OFF_USER_ID`/`OFF_USER_PASSWORD`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run test/off-push.test.ts`
Expected: PASS (migrations auto-apply via `readD1Migrations`)

- [ ] **Step 5: Commit**

```bash
git add migrations/0008_off_push.sql src/db/schema.ts src/env.ts wrangler.toml test/off-push.test.ts
git commit -m "feat: off_push outbox schema + OFF queue/cron bindings"
```

---

### Task 2: Publish-path provenance — `package_size` + `source_tags`→`barcode_source`

**Files:**
- Modify: `src/lib/extractor.ts` (DraftItem field)
- Modify: `src/lib/publish.ts` (row map ~line 383-397)
- Test: `test/admin.test.ts` (or extend `test/off-push.test.ts`)

**Interfaces:**
- Produces: `DraftItem` gains `package_size?: string` and `source_tags?: string[]`; published `food_items` rows persist `package_size` and `barcode_source` (JSON string[] of provider names) when drafts carry them.
- Consumes: nothing

- [ ] **Step 1: Write the failing test**

Approve a `pending_review` submission whose `raw_extraction.items[0]` is `{item_type:"product", name:"X", barcode:"012345000065", package_size:"500ml", source_tags:["eansearch"]}` via `publishSubmission`; assert the inserted `food_items` row has `package_size="500ml"` and `barcode_source=["eansearch"]`. (Seed pattern: `test/admin.test.ts` `SeedSubOpts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/off-push.test.ts`
Expected: FAIL — both columns NULL

- [ ] **Step 3: Implement**

- `extractor.ts`: add `package_size?: string; source_tags?: string[]` to `DraftItem`.
- `publish.ts` row map (~line 383): add `package_size: str(item.package_size) ?? null` and `barcode_source: Array.isArray(item.source_tags) ? item.source_tags.filter((t): t is string => typeof t === "string") : null`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run test/off-push.test.ts test/admin.test.ts`
Expected: PASS (existing admin publish tests unaffected — fields optional)

- [ ] **Step 5: Commit**

```bash
git commit -am "feat: persist package_size + barcode_source through review approve"
```

---

### Task 3: `verify_nutrition` on any published item

**Files:**
- Modify: `src/routes/admin.ts:215-240` (`POST /items/:id/verify`)
- Test: `test/off-push.test.ts`

**Interfaces:**
- Produces: `verify_nutrition: true` works on any item with a `nutrition_estimate`, regardless of `pending_verification`; response `{ ok: true, already_verified: true }` only when the badge was already cleared AND no nutrition change was requested.
- Consumes: nothing new

- [ ] **Step 1: Write the failing test**

Seed an item `pending_verification=false` with `nutrition_estimate={status:"estimated",calories_kcal:100}`; `POST /api/admin/items/:id/verify` `{verify_nutrition:true}` via SELF.fetch with a forged reviewer session (`test/helpers/auth.ts` `forgeSession`); assert `nutrition_estimate.status === "verified"`.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — current code early-returns `already_verified` before applying the nutrition patch.

- [ ] **Step 3: Implement**

Restructure the handler: compute `patch` first; when `item.pending_verification` is false and `body.verify_nutrition === true`, apply only the nutrition part of the patch (no badge claim needed — keep the conditional UPDATE `pending_verification=true` only when the badge is set; otherwise plain update by id). `already_verified` response only when nothing changed.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run test/off-push.test.ts test/admin.test.ts`
Expected: PASS — idempotent double-verify still returns 200.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat: verify_nutrition works on any published item"
```

---

### Task 4: Eligibility scan + drain (`src/lib/off-push.ts`)

**Files:**
- Create: `src/lib/off-push.ts`
- Test: `test/off-push.test.ts`

**Interfaces:**
- Consumes: `off_push` table + `Env` (Task 1); `normalizeBarcode` from `../product-lookup` (returns `{code, candidates}` or null); `product_lookup_cache` table.
- Produces:
  - `OFF_FAMILY` — same set as product-lookup.ts (openfoodfacts/openbeautyfacts/openpetfoodfacts/openproductsfacts); export the one in product-lookup or define locally (it's currently file-private there — hoist or duplicate, builder's call, but both files must use the same set)
  - `COMMERCIAL_PROVIDERS = new Set(["eansearch","upcitemdb","barcodelookup"])`
  - `drainOffPush(db: Db, queue: Queue, opts: { limit: number; dryRun?: boolean }): Promise<{ scanned: number; eligible: string[]; queued: number }>` — `eligible` is the item-id list (dry-run visibility); `queued` is messages sent (0 when dryRun).

**Drain algorithm:**
1. Select candidate items: `item_type='product' AND is_current=true AND status='published' AND pending_verification=false AND barcode IS NOT NULL AND off_barcode IS NULL`, joined minimal cols (`id, barcode, barcode_source`) — exclude ids already in `off_push` with `status IN ('pending','sent','linked','skipped')` (only `failed` rows may be re-picked via admin retry flipping them to `pending`).
2. Filter in JS: `normalizeBarcode` null → outbox `skipped` ("invalid barcode"); `barcode_source` ∩ OFF_FAMILY ∪ COMMERCIAL_PROVIDERS → skip silently (no outbox row — provenance-based exclusion, not a failure).
3. OFF-cache check: for remaining items, gather all `candidates` codes, chunked `IN` (90) against `product_lookup_cache` where `found=true`; any cache row whose `sources` names an OFF-family provider → skip silently.
4. Insert outbox rows (`pending`, `barcode`=canonical) for survivors up to `limit`, then `queue.send({itemId})` per row (chunked `sendBatch` is fine — Queue supports batch send). `dryRun`: return `eligible` without inserting/sending.

- [ ] **Step 1: Write the failing tests**

```ts
// distinct barcodes per case — D1 persists across its in a file
it.each([
  ["dish with barcode", { item_type: "dish", barcode: "8880000000001" }, false],
  ["pending_verification product", { item_type: "product", barcode: "8880000000002", pending_verification: true }, false],
  ["OFF-sourced product", { item_type: "product", barcode: "8880000000003", barcode_source: ["openfoodfacts"] }, false],
  ["commercial-sourced product", { item_type: "product", barcode: "8880000000004", barcode_source: ["eansearch"] }, false],
  ["clean product", { item_type: "product", barcode: "8880000000005" }, true],
])("eligibility: %s", async (_n, item, want) => { /* seed venue+item, drain dryRun, expect inclusion === want */ });

it("excludes items whose lookup cache names an OFF provider", async () => {
  // item barcode 8880000000006 + product_lookup_cache(found, sources:[{provider:"openfoodfacts"}])
});
it("invalid barcode gets a skipped outbox row and is not re-scanned", async () => { /* barcode "abc" */ });
it("dryRun reports but writes nothing; real drain inserts outbox + sends queue messages", async () => {
  // spy: vi.spyOn(env.OFF_PUSH_QUEUE, "send")
});
it("limit caps the batch", async () => { /* 3 eligible items, limit=2 → queued=2 */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run test/off-push.test.ts`
Expected: FAIL — `drainOffPush` doesn't exist.

- [ ] **Step 3: Implement `src/lib/off-push.ts`**

Per the algorithm above. `normalizeBarcode` is imported (not duplicated). Keep the OFF-hit check behind the cheap filters so the cache query only runs for survivors.

- [ ] **Step 4: Run to verify they pass**

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat: OFF push eligibility scan + drain"
```

---

### Task 5: OFF write consumer (`src/lib/off-push-send.ts` + queue dispatch)

**Files:**
- Create: `src/lib/off-push-send.ts`
- Modify: `src/queue.ts` (or `src/index.ts` — see wiring in Task 6) — `handleOffPushBatch` entry
- Test: `test/off-push.test.ts`

**Interfaces:**
- Consumes: `off_push`, `food_items`, `venues` (store name + type for `stores`), `submissions.user_id` (for `app_uuid`), `normalizeBarcode`, `Env` (OFF_BASE_URL, OFF_USER_ID, OFF_USER_PASSWORD).
- Produces:
  - `buildOffBody(item: FoodItem, venue: Venue | undefined, mode: "create" | "enrich", ctx: { submissionUserId?: string }): URLSearchParams` — pure, unit-testable.
  - `sendToOff(env: Env, fetcher: typeof fetch, row: OffPush): Promise<void>` — the probe + write + bookkeeping (exported for tests).
  - `handleOffPushBatch(batch: MessageBatch<{ itemId: string }>, env: Env): Promise<void>` — per-message wrapper: load outbox row + item, call `sendToOff`, `ack()`/`retry()`.

**sendToOff flow:**
1. Reload `food_items` + its venue; if missing/`!is_current`/`status!=='published'`/`off_barcode` set → outbox `skipped`, return.
2. If `env.OFF_USER_ID`/`OFF_USER_PASSWORD` unset → throw (retriable — a deploy without secrets shouldn't burn the outbox into `failed`; doc constraint: secrets are optional in Env).
3. Probe each `normalizeBarcode(item.barcode).candidates` in order: `GET {OFF_BASE}/api/v0/product/{code}.json` (5 s timeout). `status===1` → hit code; any non-ok/timeout → throw → retry.
4. Hit → POST `product_jqm2.pl` to the **hit code** with enrich body (`add_countries=Brunei`, `add_stores=<venue name>` only when venue.type ∈ {supermarket,grocer,convenience}, `comment`, `app_*`). Write `status===1` → outbox `linked`, `food_items.off_barcode=<hit code>`, `sent_at`.
5. All miss → POST create body to **canonical** code with the full field map from the spec (names en/ms, brands, quantity, categories, countries, stores, nutriment_* **only when `nutrition_estimate.status==="verified"`** + `nutrition_data_per=100g`, comment, `app_name=laparku-menus`, `app_version` from package.json, `app_uuid` = hex sha256 of `submissions.user_id` when present). `status===1` → outbox `sent`, `off_barcode=canonical`, `sent_at`; else throw.
6. ~1 s sleep between POSTs within a message (single item per message — the sleep applies only to probe+write pairs; keep it simple: `await new Promise(r => setTimeout(r, 1000))` once after a successful POST).

**handleOffPushBatch:** for each message: `attempts++` on the outbox row, try `sendToOff` → `ack()`; catch → on final attempt (`batch.retries` exhausted — mirror `QUEUE_MAX_RETRIES` convention from queue.ts) mark `failed`+`last_error` and `ack()` (no DLQ — same rule as submissions consumer), else `msg.retry({delaySeconds: 60 * attempts})`.

- [ ] **Step 1: Write the failing tests**

```ts
// mock fetch like test/product-lookup.test.ts; return per-URL responses.
it("create: posts full field set to canonical code, marks sent, links off_barcode", ...)
// assert POST body: code, product_name_en, brands, quantity, countries=Brunei,
// nutriment_* only when verified, user_id/password from env, app_name.
it("enrich: OFF knows code → POSTs add_* fields to hit code, marks linked", ...)
it("UPC-E candidate hit: canonical misses, expansion hits → off_barcode = expanded code", ...)
it("item hidden between enqueue and consume → skipped, no POST", ...)
it("OFF 5xx on probe → throws (message retried); exhausted retries → failed+last_error", ...)
it("nutrition estimated → no nutriment_* in body; verified → nutriment_* present", ...)
```

- [ ] **Step 2: Run to verify they fail**

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `src/lib/off-push-send.ts`**

`buildOffBody` is pure URLSearchParams assembly — the spec's field table is authoritative. `sendToOff` takes `fetcher` as a param so tests inject a fake (avoids global stubbing of probe URLs vs queue internals); `handleOffPushBatch` passes global `fetch`.

- [ ] **Step 4: Run to verify they pass**

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat: OFF write consumer — probe, create/enrich, outbox bookkeeping"
```

---

### Task 6: Worker wiring + admin endpoints

**Files:**
- Modify: `src/index.ts` (`scheduled()` + `queue()` dispatch)
- Modify: `src/routes/admin.ts` (3 endpoints)
- Test: `test/off-push.test.ts`

**Interfaces:**
- Consumes: `drainOffPush` (Task 4), `handleOffPushBatch` (Task 5), `off_push` (Task 1).
- Produces:
  - `scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext)` — `ctx.waitUntil(drainOffPush(getDb(env), env.OFF_PUSH_QUEUE, { limit: parseInt(env.OFF_PUSH_BATCH ?? "25", 10) || 25 }))`
  - `queue(batch, env)` — dispatch on `batch.queue === "laparku-menus-off-push"` → `handleOffPushBatch`, else existing `handleQueueBatch`
  - `GET /api/admin/off-push` → `{ counts: Record<status, number>, failed: OffPushRow[] (latest 50, joined item name) }`
  - `POST /api/admin/off-push/drain` body `{ dry_run?: boolean; limit?: number }` → drain result (limit defaults OFF_PUSH_BATCH; admin role check like the badges endpoint)
  - `POST /api/admin/off-push/retry` → flips `failed`→`pending`, returns `{ retried: n }`

- [ ] **Step 1: Write the failing tests**

```ts
it("GET /admin/off-push returns status counts", ...)
it("POST /admin/off-push/drain dry_run lists candidates without writing", ...)
it("POST /admin/off-push/drain real run queues and writes outbox", ...)
it("POST /admin/off-push/retry flips failed→pending", ...)
it("non-admin (plain reviewer allowed, submitter rejected?) — match existing guard", ...)
```

- [ ] **Step 2: Run to verify they fail**

Expected: FAIL — 404s.

- [ ] **Step 3: Implement**

- `index.ts`: add `scheduled` export + queue dispatch branch (compare `batch.queue` to the literal queue name).
- `admin.ts`: three endpoints inside the existing file-level reviewer guard; drain/retry take an `admin`-only role check if reviewers shouldn't push — match the badges-endpoint precedent (`c.get("user").role` includes `"admin"`).

- [ ] **Step 4: Run to verify they pass**

Run: `bun run test` (full suite)
Expected: all green, 127+ tests.

- [ ] **Step 5: Typecheck + Commit**

```bash
bun run typecheck
git commit -am "feat: OFF write-back — scheduled drain + admin endpoints"
```

---

## Post-implementation (not tasks — deployment checklist for the human)

- `wrangler secret put OFF_USER_ID` + `wrangler secret put OFF_USER_PASSWORD` (dedicated OFF account; also make one on `world.openfoodfacts.net` staging and point `.dev.vars` `OFF_BASE_URL` + creds there for live testing).
- `npx wrangler queues create laparku-menus-off-push` (production) + `npx wrangler d1 migrations apply laparku-menus-db --remote`.
- First real run: `POST /api/admin/off-push/drain {"dry_run":true}` → eyeball candidates → real drain with small `limit` against staging, then production.
