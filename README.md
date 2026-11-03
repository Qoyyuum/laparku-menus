# laparku-menus

Crowdsourced Brunei F&B dataset — public API, mobile app, submission/extraction/review pipeline, and MCP endpoint. Runs on Cloudflare Workers.

## Develop

```bash
bun install
bun run dev      # wrangler dev
bun run test     # vitest (runs inside workerd via @cloudflare/vitest-pool-workers)
bun run typecheck
```

## Secrets

Set via `wrangler secret put <NAME>` — never commit them:

- `TURNSTILE_SECRET_KEY`
- `BETTER_AUTH_SECRET`
- `RESEND_API_KEY`

## Notes

- `app/dist` is the Expo web export output (`[assets]` binding); a `.gitkeep` placeholder is committed until the app lands.
- The `database_id` in `wrangler.toml` is a placeholder — create the real D1 (`wrangler d1 create laparku-menus`) before deploying.
