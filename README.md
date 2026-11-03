# laparku-menus

Crowdsourced Brunei F&B dataset — public API, mobile app, submission/extraction/review pipeline, and MCP endpoint. Runs on Cloudflare Workers.

## Develop

```bash
bun install          # installs the worker deps AND the app/ Expo workspace
bun run dev          # wrangler dev
bun run test         # vitest (runs inside workerd via @cloudflare/vitest-pool-workers)
bun run typecheck
bun run build:web    # expo export --platform web → app/dist (what the worker serves)
```

`app/` keeps its own `node_modules` and lockfile (not a bun workspace — Metro can't
resolve bun's isolated store layout); a `postinstall` hook (`scripts/install-app.ts`)
makes the root `bun install` install it too. `bun run test` runs a `pretest` step
(`scripts/ensure-web-build.ts`) that builds the web export once when `app/dist` is
missing; rebuild it manually with `bun run build:web` after app changes.

For native builds set `EXPO_PUBLIC_API_URL` to the deployed worker API URL
(e.g. `https://<worker>.workers.dev/api`); web defaults to same-origin `/api`.

## Secrets

Set via `wrangler secret put <NAME>` — never commit them:

- `TURNSTILE_SECRET_KEY`
- `BETTER_AUTH_SECRET`
- `RESEND_API_KEY`

## Notes

- `app/dist` is the Expo web export output (`[assets]` binding, SPA fallback via
  `not_found_handling`). It's a gitignored build artifact — produce it with
  `bun run build:web`.
- The `database_id` in `wrangler.toml` is a placeholder — create the real D1 (`wrangler d1 create laparku-menus`) before deploying.
