# Laparku Maps Import — Chrome extension

Sends the Google Maps page you're viewing straight to
`https://menu.laparku.co.bn/import?url=<page-url>` — which pre-fills and
auto-submits the import (the `/import` screen already accepts `?url=` and
`?text=` deep links).

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode** (top right).
2. **Load unpacked** → select this `extension/` folder.
3. On any `google.com/maps` place page (or right-click a `maps.app.goo.gl`
   link): click the toolbar icon, or right-click → **Import venue into
   Laparku**.

To test against a local worker, change `IMPORT_ORIGIN` in `background.js`
to `http://localhost:8787`.

## Zero-install alternative

A bookmark does the same thing — create a bookmark with this as the URL:

```
javascript:location.href='https://menu.laparku.co.bn/import?url='+encodeURIComponent(location.href)
```
