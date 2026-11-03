# Deploy notes — laparku-menus production

Deployed 2026-11-03. Account: **Qainetic** (`c5605e27d8dc0a608fa07e50c4737f42`),
workers.dev subdomain **`bbdl`**. Wrangler 4.156.2 (project-local, via `npx`).

## Live URLs

| Surface | URL |
|---|---|
| Worker (app + API + MCP) | https://laparku-menus.bbdl.workers.dev |
| Landing page (Pages) | https://laparku.pages.dev |

## Resources created

| Resource | Name | ID / notes |
|---|---|---|
| D1 database | `laparku-menus-db` | `7bd7bcbc-9e86-4736-bafb-c743a9054647` (region APAC) |
| R2 bucket | `laparku-menus-submissions` | Standard storage class |
| Queue | `laparku-menus-submissions` | `0ef5c4918a3742c2a5a813bb335ab9d1`; producer + consumer on the Worker, `max_retries = 3` |
| Pages project | `laparku` | production branch `main` |
| Rate-limit binding | `RATE_LIMITER` | namespace_id `1001`, 10 req / 60s per key |
| AI binding | `AI` | `[ai]` in wrangler.toml |

## Commands run

```bash
npx wrangler d1 create laparku-menus-db
npx wrangler r2 bucket create laparku-menus-submissions
npx wrangler queues create laparku-menus-submissions
bun -e "console.log(crypto.randomUUID()+crypto.randomUUID())" | npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler d1 migrations apply laparku-menus-db --remote   # 0000_init, 0001_auth, 0002_phase2 — all applied
npx wrangler deploy
npx wrangler pages project create laparku --production-branch=main
npx wrangler pages deploy landing --project-name=laparku
```

## Secrets

| Secret | Status |
|---|---|
| `BETTER_AUTH_SECRET` | ✅ set (generated, 2× UUID) |
| `RESEND_API_KEY` | ❌ not set — magic links log instead of sending, approval emails skipped |
| `TURNSTILE_SECRET_KEY` | ❌ not set — server-side Turnstile checks are skipped while unset |

`TURNSTILE_SITE_KEY` in `[vars]` is a placeholder (`TODO-create-turnstile-widget`).

## Rate limiting

Zone-level WAF rate-limit rules **cannot apply** — they only run on zones, and
`*.workers.dev` hostnames don't belong to an account zone. Instead the Worker
uses the native `[[ratelimits]]` binding:

```toml
[[ratelimits]]
name = "RATE_LIMITER"
namespace_id = "1001"
simple = { limit = 10, period = 60 }
```

Enforced in `src/middleware/rate-limit.ts` on `POST /api/submissions`,
`POST /api/submissions/manual`, `POST /api/items/:id/flag`, keyed on
`CF-Connecting-IP` → HTTP 429 over limit. Verified bound and invoked
(`wrangler tail` shows `limit()` called per request).

**Caveat:** per Cloudflare docs the binding is approximate — counts are
per-location and eventually consistent. In testing, a ~150-request burst from
one IP did not trip the 10/60s limit (requests spread across edge machines,
each holding a low local count). It will engage under sustained load once
counts synchronize, but it is not a hard ceiling. For a strict limit, attach a
custom domain (zone) and add a WAF rate-limiting rule, or replace the
middleware with Durable-Object-backed counting.

## Smoke-test results (2026-11-03, production)

| Check | Result |
|---|---|
| `GET /api/health` | 200 `{"status":"ok"}` |
| `GET /api/search` | 200 `{"venues":[],"items":[]}` |
| `GET /api/venues` | 200 `{"venues":[]}` |
| `GET /api/stats` | 200 `{"venues":0,"items":0,"contributors":0,"checkins":0}` |
| `GET /api/leaderboards` | 200 `{"board":[],"me":null,"area":null}` |
| `GET /api/coverage` | 200 (4 Brunei districts, all zeros) |
| `POST /mcp` initialize | 200 JSON-RPC `serverInfo: laparku-menus 0.1.0` |
| `GET /` (SPA) | 200 `text/html` |
| `GET https://laparku.pages.dev/` | 200 |

Empty result sets are expected — fresh database, no approved submissions yet.

## Remaining manual steps (need the user)

1. **`wrangler secret put RESEND_API_KEY`** — needs their Resend API key.
   Until set, magic-link emails only log and approval notification emails are
   skipped.
2. **Turnstile widget + `wrangler secret put TURNSTILE_SECRET_KEY`** — create a
   widget in the CF dashboard (Security → Turnstile) for
   `laparku-menus.bbdl.workers.dev`, put the site key in `[vars]`
   (`TURNSTILE_SITE_KEY`), rebuild the web bundle with
   `EXPO_PUBLIC_TURNSTILE_SITEKEY` set, and redeploy.
3. **Optional: stricter rate limiting** — attach a custom domain to the Worker
   and add a WAF rate-limiting rule (10/min per IP on the write endpoints) if
   the approximate binding proves too lax.
4. **Optional: promote first admin/reviewer** — `scripts/promote-admin.ts`
   once a real user signs up.
5. **Optional: EAS Build** for native store distribution (deferred).

## Repo notes for this deploy

- `wrangler.toml` now carries real resource IDs — committed (IDs aren't secrets).
- `vitest.config.ts` overrides `PUBLIC_BASE_URL=http://localhost:8787` for the
  test env: an https base URL flips better-auth to `__Secure-` cookie names and
  every forged-session test 401s. Production is unaffected.
- `landing/index.html` + `landing/README-deploy.md` repointed at the real
  worker URL (`bbdl` subdomain).
