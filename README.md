# laparku-menus

Crowdsourced Brunei F&B dataset — public API, mobile app, submission/extraction/review pipeline, and MCP endpoint. Runs on Cloudflare Workers.

- **App / API:** https://laparku-menus.bbdl.workers.dev
- **Landing page:** https://laparku.pages.dev
- **MCP endpoint:** `POST https://laparku-menus.bbdl.workers.dev/mcp`

If this project is useful to you: [☕ Buy me a coffee](https://buymeacoffee.com/qoyyuum)

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
(e.g. `https://laparku-menus.bbdl.workers.dev/api`); web defaults to same-origin `/api`.

## Deploy

Everything except a handful of secrets is in `wrangler.toml` — see
`DEPLOY-NOTES.md` for the full production inventory (resource IDs, commands,
rate-limit config, smoke-test results).

```bash
# One-time resource setup (already done for production):
npx wrangler d1 create laparku-menus-db
npx wrangler r2 bucket create laparku-menus-submissions
npx wrangler queues create laparku-menus-submissions
npx wrangler pages project create laparku --production-branch=main

# Schema + deploy:
npx wrangler d1 migrations apply laparku-menus-db --remote
bun run build:web                      # refresh app/dist if app/ changed
npx wrangler deploy                    # worker → https://laparku-menus.bbdl.workers.dev
npx wrangler pages deploy landing --project-name=laparku   # → https://laparku.pages.dev
```

## Secrets

Set via `wrangler secret put <NAME>` — never commit them:

- `BETTER_AUTH_SECRET` — any long random string (`crypto.randomUUID()` x2 works)
- `RESEND_API_KEY` — magic-link + notification email via Resend
- `TURNSTILE_SECRET_KEY` — Cloudflare Turnstile; pair with `TURNSTILE_SITE_KEY` in
  `wrangler.toml` `[vars]` and `EXPO_PUBLIC_TURNSTILE_SITEKEY` for the app build.
  When unset, server-side Turnstile checks are skipped (fine for dev).

## Contributing

Submissions, flags, and check-ins flow through the API — the easiest
contribution is using the app. For code: `bun install`, `bun run test` must stay
green (127 tests), `bun run typecheck` must pass, then open a PR against
`main`. See `DEPLOY-NOTES.md` for the production topology before changing
bindings or routes.

## Notes

- `app/dist` is the Expo web export output (`[assets]` binding, SPA fallback via
  `not_found_handling`). It's a gitignored build artifact — produce it with
  `bun run build:web`.
- Write endpoints (`POST /api/submissions*`, `POST /api/items/:id/flag`) are
  rate-limited via the `[[ratelimits]]` binding (10 req/min per client IP) —
  see `src/middleware/rate-limit.ts`.
- Native store distribution via EAS Build is deferred; the app runs via Expo Go
  and the exported web bundle on the Worker.
