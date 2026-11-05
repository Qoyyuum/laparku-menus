# Google Maps link import — design

**Date:** 2026-11-05
**Status:** approved (brainstorm session → implementation plan)

## Intent

Borderly AI-style import: a user shares a Google Maps venue link
(`maps.app.goo.gl/…`, `google.com/maps/place/…`, `?cid=…`) instead of
photographing a menu. The worker resolves the link to a Google place, reads
the "Menu" tab, and routes the result into the existing
submission → review → publish pipeline — or, for structured menus on
already-known venues, the trusted-publish path.

## Goals / non-goals / anti-goals

**Goals**

- Paste or share a Maps link → menu items land in the dataset with minimal
  friction.
- Structured menus (sections → items + prices) go live via a trusted path
  when the venue is confidently matched, behind `pending_verification`.
- Photo fallback: venues without a structured menu still contribute —
  Menu/Food & drink photos flow through the existing vision extractor.
- Ordered provider chain (`browser` → `serpfast` → …) so scraper services
  can be added or reordered without code changes beyond a registration.

**Non-goals**

- Auto-creating venues. Venue type/area/halal can't be inferred reliably
  from Google data — new venues always go through reviewer approval (with a
  pre-filled draft).
- Sync request-path scraping. Browser sessions take ~10–30 s; all provider
  work happens in the queue consumer.
- Native share intent on Expo Go (native module can't load there — dev
  client builds only, guarded).

**Anti-goals**

- Never bypass review for photo-extracted content.
- Never strand a submission row: unresolved links, empty places, and
  abandoned venue picks all settle to a terminal status.
- Never bill for nothing: provider 404s are definitive cheap answers;
  browser sessions always `close()` in `finally`.

## Approaches considered

| Approach | Trade-off | Verdict |
|---|---|---|
| Paid API only (SerpApi/serpfast) | Reliable JSON; ~$0.001–0.005/call; third-party dependency | Fallback provider in chain |
| Cloudflare Browser Run (headless Chrome via `@cloudflare/puppeteer`) | Free within 10 browser-hrs/mo; Google bot-detection risk; more code | Primary provider |
| Self-scrape place page HTML | Free but most brittle; datacenter IP degradation | Rejected — strictly worse than browser |
| Google Places API | No menus — doesn't expose this data at all | Rejected — impossible |

Chain semantics follow `product-lookup.ts`: `GMAPS_PROVIDER` is a
comma-separated list walked in order; providers skip on missing
secret/binding, budget exhaustion, or thrown error; the first non-null
(definitive) answer wins.

## Parts

### Intake

`POST /api/submissions/gmaps {url}` — rate-limited, session-required,
JSON. Resolves the URL (goo.gl redirect, `!1s`/`0x…:0x…`/`?cid=`/`@lat,lng`
parsing), files a `gmaps_link` submission (`pending`), enqueues. Returns
`{submission_id}`.

`GET /api/submissions/:id` — new endpoint; own-submission-scoped status +
gmaps summary for the polling UI.

`POST /api/submissions/gmaps/:id/venue {venue_id | new_venue:true}` —
venue disambiguation confirm. `venue_id` → trusted publish from the cached
provider payload (zero extra provider calls). `new_venue` → leaves the row
in `pending_review` with a pre-filled venue draft for the reviewer.

### Queue

`processSubmission` branches: `gmaps_link` rows with no `image_keys` run
`processGmapsImport` — provider fetch →

- structured menu + strong venue match (`google_place_id` equality, or
  ≤50 m + similarName) → `trustedPublishGmaps` → `trusted_published`
- structured menu + ambiguous/no match → `pending_review` with draft items,
  venue candidates, and place data stored under `raw_extraction.gmaps`
- no menu → photo cascade (≤10 URLs) → download → R2 → `image_keys` → fall
  through to the normal vision pipeline
- nothing → `auto_rejected` (`gmaps_no_data`)

Auto-flag additions: `gmaps_recent_dup` (same place_id imported ≤14 days),
`venue_ambiguous`.

### Providers (`src/lib/gmaps-provider.ts`)

- `browser` — `env.BROWSER` binding; consent-wall click-through;
  `APP_INITIALIZATION_STATE` extraction (primary) / Menu-tab DOM
  (fallback); place details + menu sections + photo URLs in one session.
  Budget: `provider_budget(provider="browser_run")` in seconds/day vs
  `GMAPS_DAILY_BROWSER_SECONDS` (~20 min/day ≈ 10 hrs/month free tier).
- `serpfast` — `/api/v1/google/maps/menu` (404→null, unbilled) +
  `/api/v1/google/maps/photos?category=menu|food_and_drink`; secret
  `SERPFAST_API_KEY`; budget in calls vs `SERPFAST_DAILY_CALL_CAP`.
- `stub` — test hook (`setStubGmapsProvider`).

### Trusted publish (`src/lib/gmaps-publish.ts`)

Modeled on `trusted-publish.ts`. Items keyed by normalized name via
`matchItems`: existing-name match → freshness re-verification (`stale`
count → `recordVerification` vote); new name → `food_items` insert
(`pending_verification`, `publish_mode="trusted"`, `venue_revisions` mode
`merge`). Atomic daily item cap `GMAPS_DAILY_ITEM_CAP`; overflow → a
`pending_review` submission, never dropped. Sets `venues.google_place_id`
when unset.

### Schema (migration 0007)

- `venues.google_place_id TEXT` + `UNIQUE` index — hard dedup key, same
  role as `osm_ref`.
- `SOURCE_TYPES` += `gmaps_link` (plain TEXT column — no DDL).
- `RawExtraction.gmaps` — cached provider payload (place, sections,
  photo_urls, venue_candidates, resolved_url).

### Venue draft

`PublishEdits.venue` (reviewer new-venue draft) gains optional
`lat`/`lng`/`google_place_id` so reviewer-created venues from imports get
real coordinates and the dedup key.

### App

- `/import` screen (SignInGate-wrapped): URL field, clipboard paste
  (`expo-clipboard`), deep-link params `?url=`/`?text=`, poll
  `GET /api/submissions/:id`, venue picker when ambiguous.
- `/submit` gains an "Import from Google Maps" entry → `/import`.
- `expo-share-intent` (guarded `useShareIntent` in root layout →
  `/import?url=…`); requires EAS dev-client builds.
- Best-effort PWA `share_target` patch in `scripts/build-web.ts`.

## Constraints

- Google Maps scraping has no official API — exposure is real but bounded
  by user-initiated, low-volume lookups. The provider chain keeps the risk
  portable (browser → serpfast → future).
- `browser.close()` in `finally` — idle sessions bill until the 60 s
  timeout.
- `bun run test` must stay green (tests run `GMAPS_PROVIDER=stub` — no
  network).

## Open risk

Google bot-detection on datacenter headless Chrome is the known unknown —
consent walls are automatable, CAPTCHAs aren't. Mitigation is the chain:
`browser` returns null on failure → `serpfast` answers instead. Observed
hit rates in production should inform whether `browser` stays first.
