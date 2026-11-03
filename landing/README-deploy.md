# Deploying the landing page

`landing/` is plain static HTML/CSS — no build step. It deploys to Cloudflare Pages.

## Deploy

From the repo root:

```bash
wrangler pages deploy landing --project-name=laparku
```

This publishes the site at **`laparku.pages.dev`**.

Requires a one-time `wrangler login` on the deploying machine. The Pages project
is created automatically on first deploy if it doesn't exist yet.

## Notes

- The menu app URL lives in `<meta name="menu-url">` in `index.html`
  (currently `https://laparku-menus.bbdl.workers.dev`). Update that one meta tag to
  repoint every menu-app link on the page — a small inline script applies it,
  and the anchor `href` fallbacks keep links working without JS.
- Serve locally to preview: `python -m http.server -d landing` or
  `bunx serve landing`.
