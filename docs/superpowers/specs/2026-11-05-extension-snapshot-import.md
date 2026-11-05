# Extension snapshot import — follow-up spec

Status: proposed, not implemented. Follows from `2026-11-05-gmaps-import-design.md`.

## Problem observed

Photo-path imports via serpfast currently pull the wrong images: Google's
`menu` photo category often returns **storefront/location shots**, not menu
images (e.g. Chop Jing Chew imported 2 facade photos). Structured menu data
is rare for Brunei venues, so the photo path is the common one — and it's
also the weakest. Meanwhile the browser provider (Browser Run) hasn't been
verified against real Google Maps pages yet (consent wall / CAPTCHA risk).

## Idea

The user is already looking at the right thing. When they're viewing a
Google Maps photo lightbox (the Menu tab of a venue), the Chrome extension
can **capture what's on screen** and upload it *together with the venue's
Google Maps URL* — no scraping needed, the human does the navigation.

## Proposed flow

1. Extension injects a floating "Send to Laparku" chip on
   `google.com/maps` pages (or adds a context-menu item on the photo).
2. On click, capture the visible tab (`chrome.tabs.captureVisibleTab`) —
   or better, resolve the underlying `<img>` URL in the lightbox for a
   full-res copy instead of a viewport crop.
3. POST to a new endpoint `POST /api/submissions/gmaps-photo` with:
   - the image bytes (JPEG/PNG)
   - the venue URL (`tab.url` — already a canonical place URL with coords)
4. Server resolves the venue from the URL (existing `resolveGmapsLink` +
   `venue-match`), files a `menu_photo`-style submission with the image in
   R2, auto-attaches the venue hint from `resolved`, and runs the existing
   vision extraction → review pipeline.
5. Reuse: `provider_budget` cap for AI extraction, existing `photo_keys`
   dedup (pHash), `provenance.url` = the Maps URL for review.

## Questions to resolve when picking this up

- [ ] Capture mechanism: `captureVisibleTab` (needs `activeTab` on click —
      works, but crops to viewport) vs scraping the lightbox's full-res
      `src` (better quality, needs a content script).
- [ ] Whether Browser Run is viable as primary provider at all — needs a
      real test; if consent/CAPTCHA blocks it, drop `browser` from
      `GMAPS_PROVIDER` and keep serpfast.
- [ ] Whether to fetch more serpfast photo categories (`food_and_drink`,
      `latest`, `by_owner`) or paginate `next_page_token` to widen coverage
      as a cheap alternative to the extension.
- [ ] Mobile equivalent: share-sheet → native app with the photo + venue URL
      (share-intent already routes URLs; would need media+text handling).
