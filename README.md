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

### Running locally (dev server + magic-link sign-in)

```bash
bunx wrangler d1 migrations apply laparku-menus-db --local   # one-time: local D1 starts empty
bun run dev        # → Ready on http://127.0.0.1:8787
```

Two gotchas that bite on first run:

- **Local D1 starts empty** — better-auth 500s on sign-in (`Missing tables
  user, session, account, verification, apikey`) until migrations are applied
  with `--local` (command above).
- **Magic links are built against `PUBLIC_BASE_URL`** — set it in `.dev.vars`
  (gitignored) or your link points at production, not localhost:

  ```ini
  PUBLIC_BASE_URL=http://localhost:8787
  EXTRACTOR=stub
  ```

To test sign-in locally: email goes through the `send_email` binding, which
`wrangler dev` simulates — nothing is actually delivered. Request a link in
the app (log-in icon → `/signin` → email → "Email me a sign-in link"), find
the `send_email binding called with MessageBuilder:` block in the dev
console, open the `Text:`/`HTML:` file path it logs, and copy the sign-in
URL out of the email body — it 302s to the callback route and sets the
session cookie. (With no `EMAIL` binding at all, the link is logged
directly as `magic link for <email>: <url>`.)

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
- `TURNSTILE_SECRET_KEY` — Cloudflare Turnstile; pair with `TURNSTILE_SITE_KEY` in
  `wrangler.toml` `[vars]` and `EXPO_PUBLIC_TURNSTILE_SITEKEY` for the app build.
  When unset, server-side Turnstile checks are skipped (fine for dev).
- `GRAVATAR_API_KEY` — optional. Bearer key for Gravatar's v3 profile API
  (`api.gravatar.com/v3/profiles/<sha256(email)>`); raises the
  `verified_accounts` cap past 4. When unset, verified-account lookups are
  skipped and profiles just render empty socials (fine for dev — keeps tests
  and local runs offline-clean).

Email needs no secret — magic links + notifications send through the
`send_email` binding (`env.EMAIL`). Before the first real send, onboard the
from-domain to Email Sending (`npx wrangler email sending enable
<domain>`); optionally set the `AUTH_EMAIL_FROM` var to pick the sender
(default `Laparku <no-reply@laparku.com>`).

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
