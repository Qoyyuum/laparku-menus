# Open Food Facts write-back — design

**Date:** 2026-11-05
**Status:** pending approval (brainstorm session → design)

## Intent

Push laparku's reviewed, published packaged-product data to Open Food
Facts (OFF) — the products Brunei scans/menus surface that OFF doesn't
know about — while keeping laparku's own rows as the venue-availability
link. OFF remains the read source for barcode lookups
(`src/lib/product-lookup.ts`); this adds the write direction on a
scheduled, batched, retryable pipeline.

## Goals / non-goals / anti-goals

**Goals**

- Every published `product` item OFF doesn't already record gets created
  on OFF with laparku's data: name (en + ms), brand, quantity,
  categories, `countries=Brunei`, `stores` (grocer-type venue names),
  and reviewer-verified nutrition.
- Writes are batched and scheduled off-peak: hourly ticks 22:00 → 09:00
  Brunei time (UTC+8), small batches per tick, retries with backoff.
- A manual admin trigger drains the same pipeline on demand — used for
  testing and for the one-time backfill of already-published products.
- Success links the item to its OFF record (`food_items.off_barcode`).

**Non-goals**

- Cooked dishes / `item_type="dish"` — no established third-party write
  API exists (ASEANFOODS is contact-based; user opted to skip it).
- Pushing user photos to OFF — a licensing/consent question
  (OFF content is CC-BY-SA); revisit separately.
- Syncing deletions — OFF has no delete semantics for this; hidden/
  superseded items just stop being eligible.
- Real-time push — overnight batching is deliberate.

**Anti-goals**

- Never echo OFF's own data back as a new contribution: items whose data
  came from an OFF-family provider (`barcode_source` OR
  `product_lookup_cache.sources`) are skipped.
- Never republish commercial-provider data (eansearch/upcitemdb/
  barcodelookup — the 24h cache TTL exists because it can't be
  redistributed): items whose `barcode_source` names one are skipped.
- Never push unvetted data — `pending_verification` items (trusted-path,
  not yet reviewer-cleared) are ineligible; OFF has no delete.
- Never push machine-estimated nutrition — only
  `nutrition_estimate.status="verified"` (a human asked for it).
- Never block or slow the publish path on a third party.
- Never lose a push on transient failure — outbox + queue retries +
  a failed status an admin can replay.

## Approaches considered

| Approach | Trade-off | Verdict |
|---|---|---|
| Cron-scanned outbox → queue consumer → OFF write | No publish-path changes; backfill free; retries per item | **Picked** |
| Synchronous POST inside `publishSubmission` | Less code; couples publish latency/failure to OFF; OFF docs explicitly say queue writes | Rejected |
| Manual batch script only | Good for backfill, not an ongoing pipeline | Merged — same drain, exposed as admin endpoint |

Eligibility is *discovered at drain time* rather than marked at publish
time: scan `food_items` for `item_type='product' AND is_current AND
status='published' AND pending_verification=false AND barcode NOT NULL
AND off_barcode IS NULL`, then drop:

- rows already in `off_push` with status `sent`/`linked`/`skipped`
- rows whose `barcode_source` intersects the OFF family
  (openfoodfacts/openbeautyfacts/openpetfoodfacts/openproductsfacts) —
  echo prevention
- rows whose `barcode_source` names a commercial provider — license
  republishing risk (my call; relaxable per-item later)
- rows whose canonical barcode has a `product_lookup_cache` `found` row
  naming an OFF-family provider — the provenance that review-path items
  otherwise lose (see below)

Two small publish-side changes preserve what the scan needs (the only
hooks):

- `publishSubmission`'s row map copies `package_size` and
  `source_tags`→`barcode_source` from drafts that carry them (scan
  overflow items land in `raw_extraction.items` with `source_tags`;
  `DraftItem`/`validateDraftItem` already pass them through). Without
  this, review-approved scan items lose their provider provenance and
  the OFF-echo skip can't see them.
- `DraftItem` gains optional `package_size`.

OFF write endpoint: `POST /cgi/product_jqm2.pl` (API v2, stable, all
fields supported). The v3 structured PATCH write API is still under
development and doesn't yet cover the full field set — revisit later.
Writes authenticate with a dedicated OFF contributor account
(`OFF_USER_ID` / `OFF_PASSWORD` secrets). OFF imposes no per-IP write
rate limit; the batch cap below is for politeness and worker limits,
not quota.

## Parts

### Schema (migration 0008)

New `off_push` outbox table:

- `id` uuid PK
- `item_id` → food_items.id, UNIQUE (one outbox row per item, ever)
- `barcode` — canonical form at enqueue time (audit + debugging)
- `status` — `pending` | `sent` | `linked` | `skipped` | `failed`
  - `sent` = laparku created/updated the OFF product
  - `linked` = OFF already had the product; enrich-only or no write
    needed, `off_barcode` was set
  - `skipped` = became ineligible between enqueue and consume (item
    hidden/superseded, `off_barcode` set elsewhere, or the OFF-probe
    discovered an OFF-sourced product the drain check missed)
  - `failed` = retries exhausted; admin replayable
- `attempts` int, `last_error` text, `created_at`, `sent_at`

Indexes: `off_push_status_idx` on (status) — the drain query.

No `food_items` schema change — `off_barcode` already exists and is the
sync marker.

### The drain (`src/lib/off-push.ts`)

Entry: `drainOffPush(env, { limit, dryRun })` → `{ scanned, queued }`.

1. SELECT eligible food_items (criteria above) — barcode canonicalized
   via `normalizeBarcode`; invalid codes get an outbox row marked
   `failed` ("invalid barcode") so they're not rescanned forever.
2. Skip items whose `barcode_source` array intersects the OFF family
   (same set as product-lookup: openfoodfacts/openbeautyfacts/
   openpetfoodfacts/openproductsfacts).
3. Insert outbox rows (`pending`) for the rest, then enqueue up to
   `limit` pending rows — one message per item on a new queue
   `OFF_PUSH_QUEUE` (queue `laparku-menus-off-push`). `dryRun` returns
   the candidate list without writing.

### The consumer (`src/lib/off-push-send.ts`)

Per message (one item):

1. Reload the item; if it's no longer `is_current`/`published` or
   `off_barcode` is now set, mark the outbox row `skipped` and stop —
   idempotent under at-least-once delivery.
2. Probe OFF with **each normalized candidate** in order
   (`normalizeBarcode(...).candidates` — canonical first, then the
   UPC-E→UPC-A expansion, same walk the lookup chain does):
   - first `status=1` hit → that code is OFF's record:
     `food_items.off_barcode = <hit code>`, then **enrich only** — POST
     to the hit code with `add_countries=Brunei`/`add_stores` +
     comment (additive tags are new data to OFF even when the product
     exists); mark `linked`.
   - all candidates `status=0` → **create** under the canonical code:
     POST the full field set below; `off_barcode = canonical`; mark
     `sent`.
   - any candidate erroring (network/5xx/non-1 response) → throw →
     queue retry (max_retries=3, backoff via `retry()` delaySeconds);
     final failure → `failed` + last_error. A real OFF `status: 1` in
     the write response is success; anything else is an error.
3. Success marks the outbox row + sets `sent_at`.

Between POSTs the consumer sleeps ~1 s (politeness; OFF asks for
queued writes and we're a new contributor).

**Field mapping** (`application/x-www-form-urlencoded` POST):

| OFF field | laparku source |
|---|---|
| `code` | `food_items.barcode` (canonical) |
| `user_id`, `password` | `OFF_USER_ID` / `OFF_PASSWORD` secrets |
| `lc` | `en` |
| `product_name_en` | `name` |
| `product_name_ms` | `name_ms` (when present) |
| `brands` | `brand` |
| `quantity` | `package_size` |
| `categories` | `category` (when present) |
| `countries` | `Brunei` |
| `stores` | venue name — only when venue.type is `supermarket`/`grocer`/`convenience` |
| `nutrition_data_per` + `nutriment_*` | only when `nutrition_estimate.status="verified"`: `nutrition_data_per=100g`, `nutriment_energy-kcal`←`calories_kcal`, `nutriment_proteins`←`protein_g`, `nutriment_carbohydrates`←`carbs_g`, `nutriment_fat`←`fat_g` |
| `comment` | `Data via laparku-menus (menu.laparku.co.bn) — Brunei crowdsourced menus, submission <source_submission_id>` |
| `app_name` / `app_version` / `app_uuid` | `laparku-menus` / package version / sha256(source submission's user_id) — OFF moderation provenance |

### Scheduling (`wrangler.toml` + `src/index.ts`)

```toml
[[queues.producers]]
binding = "OFF_PUSH_QUEUE"
queue = "laparku-menus-off-push"

[[queues.consumers]]
queue = "laparku-menus-off-push"
max_retries = 3

[triggers]
# Hourly 14:00–23:00,00:00–01:00 UTC = 22:00–09:00 Brunei time (UTC+8):
# end-of-day push, start-of-day push, hourly drain between.
crons = ["0 14-23,0-1 * * *"]
```

`scheduled()` handler calls `drainOffPush(env, { limit: OFF_PUSH_BATCH })`.
`OFF_PUSH_BATCH` var, default **25** items/tick → max ~300/day across the
12 ticks; a bigger backlog self-drains over consecutive ticks.

The `queue()` export branches on `batch.queue` — submissions queue keeps
`handleQueueBatch`; `laparku-menus-off-push` gets `handleOffPushBatch`.

### Admin endpoints (Option C — manual drain + observability)

In `src/routes/admin.ts` (reviewer+ role, same file guard):

- `GET /api/admin/off-push` — status counts + recent `failed` rows
  (item name, barcode, last_error, attempts).
- `POST /api/admin/off-push/drain` body `{ dry_run?: boolean, limit?: number }`
  — runs `drainOffPush` now. `dry_run` lists what *would* be queued;
  real run enqueues. This is the backfill button AND the test path.
- `POST /api/admin/off-push/retry` — flips `failed` → `pending` so the
  next tick/drain picks them up.

### Verify-path change (nutrition graduation)

`POST /api/admin/items/:id/verify` currently early-returns
`already_verified` when `pending_verification` is false — so
review-published items can never get `nutrition_estimate.status:
"verified"`. Relax: `verify_nutrition: true` works on any published
item (the badge-clear semantics stay unchanged). This is what lets
reviewed nutrition reach OFF at all.

### Config / secrets

- `wrangler secret put OFF_USER_ID`, `OFF_USER_PASSWORD` — a dedicated
  OFF account (username, not email).
- Vars: `OFF_PUSH_BATCH` (default 25), `OFF_BASE_URL`
  (default `https://world.openfoodfacts.org`).
- **Testing:** `OFF_BASE_URL=https://world.openfoodfacts.net` is OFF's
  public staging server — real write round-trips without touching the
  production database (staging needs its own account credentials).
  Vitest never hits the network: the payload builder and eligibility
  scan are pure/D1 functions; the send path takes an injectable fetch.

## Constraints

- OFF writes require auth (enforced since Oct 2026) — no anonymous push.
- ODbL: laparku already consumes OFF data, so OFF-sourced items shown in
  the app need "© Open Food Facts contributors" attribution — a separate
  small app-side change noted here so it isn't forgotten.
- `bun run test` stays green; consumer/send tests mock fetch.
- D1 param cap: eligibility scan uses no large IN clauses; the outbox
  insert is chunked like publish.ts's inserts if needed.

## Open risks

- OFF write response is `{status: 1, status_verbose: "fields saved"}`
  on success — anything else is treated as an error and lands in
  `last_error`; malformed-barcodes OFF rejects surface on the admin
  endpoint as `failed`.
- Staging (.net) and production (.org) need separate OFF accounts —
  test creds go in `.dev.vars`, never `wrangler secret`.
- Commercial-sourced items are skipped wholesale; if reviewers want a
  specific verified item pushed anyway, that's a per-item admin action
  to add later (the outbox `skipped` status keeps it visible).
