# Passkeys, Influencer Profiles & Theme Preference — Design

Date: 2026-11-04 · Branch: `feat-passkeys-profiles-theme` (worktree `.worktrees/passkeys`)

## Intent

Three related features around identity:

1. **Passkeys** — sign in and manage passkeys (enrol + unenrol) via `@better-auth/passkey@1.7.15`, matching the installed better-auth.
2. **Influencer-ready profiles** — profile picture (R2 upload, Gravatar fallback by email) and social usernames sourced from the user's **verified Gravatar accounts** (managed on gravatar.com — never freeform text, so nothing vulgar can reach public surfaces; `display_name` editing is removed for the same reason). Social OAuth login is explicitly deferred.
3. **Theme preference** — light / dark / system, stored per-user and applied across the app.

## Goals / Non-goals / Anti-goals

- Goals: passkey enrol, list, delete, sign-in; avatar upload+delete+serve; 5 social fields; theme applied app-wide.
- Non-goals: native (iOS/Android) passkey support; OAuth social sign-in; public profile surfaces (leaderboard/credit stay as today).
- Anti-goal: passkey-only lockout — magic link stays as the always-available fallback.

## Approaches considered

- **Passkey plugin**: `@better-auth/passkey@1.7.15` (chosen — official plugin, exact version match, adds `/api/auth/passkey/*` endpoints + client actions) vs hand-rolled WebAuthn (rejected: weeks of subtle crypto work for zero gain).
- **Avatar storage**: R2 upload in `SUBMISSIONS` bucket under `avatars/` prefix (chosen — bucket exists, no new infra) vs external URL field (rejected by user — wants upload) vs new bucket (rejected: overkill).
- **Gravatar**: v3 REST API keyed on **SHA256** of the normalized email via `crypto.subtle` (chosen — native to Workers, zero new deps; verified against the live OpenAPI spec) vs MD5 + `@noble/hashes` (rejected — v3 profiles are SHA256-keyed).
- **Socials**: Gravatar v3 API `verified_accounts`, cached on the user row and refreshed ~daily (chosen — Gravatar verifies ownership, so handles are trustworthy; users maintain them on gravatar.com) vs `social_*` freeform columns (rejected by user — unmoderatable vulgar input, same problem as display_name) vs a curated picklist of freeform handles (rejected: same trust problem).
- **Public name**: `preferred_social` — the user picks one of their *verified* accounts to be their leaderboard name (chosen — nothing freeform reaches the public) vs keep `display_name` freeform (rejected by user — moderation risk at scale). `display_name` editing is removed from `PATCH /api/me` and the profile UI; the column stays in the DB unrendered.
- **Theme**: NativeWind class-based dark mode (chosen — the app is already built on `className`/`nativewind@4.2.7`: `darkMode: "class"` + the NativeWind `colorScheme` API driven by the stored pref, plus `dark:` variants across screens) vs a JS token palette via `useTheme().colors` (rejected — would mean stripping ~480 className color utilities into `style` props, working against the app's paradigm).

## Server changes

### Migration `0004_passkeys_profiles.sql` (+ `meta/_journal.json` entry)

```sql
create table "passkey" (
  "id" text not null primary key,
  "name" text,
  "publicKey" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "credentialID" text not null,
  "counter" integer not null,
  "deviceType" text not null,
  "backedUp" integer not null,
  "transports" text,
  "createdAt" date,
  "aaguid" text
);
create index "passkey_userId_idx" on "passkey" ("userId");
create index "passkey_credentialID_idx" on "passkey" ("credentialID");

ALTER TABLE "user" ADD "theme" text DEFAULT 'system' NOT NULL;
ALTER TABLE "user" ADD "preferred_social" text;
ALTER TABLE "user" ADD "gravatar_accounts" text;
ALTER TABLE "user" ADD "gravatar_fetched_at" date;
```

`gravatar_accounts` is a JSON snapshot of the verified accounts returned by
the Gravatar v3 API; `gravatar_fetched_at` drives the ~24 h staleness check.
`preferred_social` holds one platform key from that snapshot (or null).

Passkey table shape matches the plugin's declared schema (verified against
`@better-auth/passkey/dist` types: required `publicKey`/`userId`/`credentialID`/
`counter`/`deviceType`/`backedUp`, optional `name`/`transports`/`createdAt`/`aaguid`).

### `src/auth.ts` (+ `src/index.ts` one-line change)

Add `passkey({ rpID, rpName: "Laparku", origin })` to plugins. `rpID`/`origin`
come from the **request origin**, not `PUBLIC_BASE_URL` — `PUBLIC_BASE_URL`
always points at the deployed domain, which would make WebAuthn fail in
`wrangler dev` (builder-check catch). `createAuth(env)` becomes
`createAuth(env, requestOrigin)`; `index.ts` passes `new URL(c.req.url).origin`.

### Profile routes (`src/routes/me.ts`, `src/routes/leaderboards.ts`, new `src/routes/avatar.ts`)

- `PATCH /api/me` — extend accepted fields: `theme` (`"light"|"dark"|"system"`)
  and `preferred_social` (must be a platform key present in the user's cached
  verified accounts, or null to clear). `display_name` is no longer accepted
  (a patch naming only it 400s "nothing to update", same as other unknown
  fields); `show_on_leaderboard`/`show_credit` unchanged.
- `POST /api/me/socials/refresh` — forces a Gravatar re-fetch now (for "I just
  updated my gravatar"). Shares the same refresh path; returns the new list.
- `GET /api/me` — response gains `theme`, `socials` (the cached verified
  accounts: platform + handle + profile URL), `preferred_social`, and
  `avatar_url` (`/api/avatar/<userId>` if `user.image` set, else
  `gravatarUrl(email)`). Refreshes the Gravatar snapshot when
  `gravatar_fetched_at` is absent or >24 h old; skipped quietly when
  `GRAVATAR_API_KEY` is unset or Gravatar errors — the read still succeeds
  with whatever is cached.
- `POST /api/me/avatar` — raw image body (≤2 MB), `sniffMagic` jpeg/png/webp
  only (pdf explicitly rejected); `SUBMISSIONS.put("avatars/<userId>", bytes,
  {httpMetadata:{contentType}})`; sets `user.image` to `/api/avatar/<userId>`.
- `DELETE /api/me/avatar` — deletes the R2 object, nulls `user.image`.
- `GET /api/avatar/:userId` — public; streams the R2 object with stored
  content-type, `cache-control: public, max-age=3600`, 404 when absent.
- `GET /api/leaderboards` — public name switches from `display_name` to the
  user's chosen verified handle: opted-in rows with a `preferred_social`
  render e.g. `handle (instagram)` read off their `gravatar_accounts`
  snapshot (no live Gravatar call on the public path — the snapshot is read
  from D1). Everyone else stays `Anonymous`. No user id, email, avatar URL,
  or gravatar hash on rows — the existing privacy posture is kept.

### `src/lib/gravatar.ts`

- `sha256Hex(s)` → `crypto.subtle.digest("SHA-256")` hex of
  `email.trim().toLowerCase()` — the key for both endpoints below.
- `gravatarUrl(email, size=200)` → `https://www.gravatar.com/avatar/<sha256>?s=<n>&d=identicon`.
  Keyless — serves the public profile image (identicon fallback when the
  email has no gravatar).
- `fetchVerifiedAccounts(env, email)` → `GET https://api.gravatar.com/v3/profiles/<sha256>`
  (+ `Authorization: Bearer ${env.GRAVATAR_API_KEY}` when set). Response
  `verified_accounts: {service_type, service_label, service_icon, url,
  is_hidden}[]`; we cache non-hidden entries as
  `{platform: service_type, label: service_label, handle: <last URL path
  segment>, url}[]`. Throws on non-2xx (404 = email isn't the account's
  primary — treated as empty); callers catch and keep the stale cache.

`env` gains `GRAVATAR_API_KEY?: string` (secret). Refresh runs **only when
the key is set** — the endpoint tolerates unauthenticated calls but caps
`verified_accounts` at 4, and skipping egress without a key matches the
product-lookup provider convention and keeps dev/test offline-clean.

## App changes

- `app/src/auth.ts` — add `passkeyClient()` to plugins. Safe on native:
  `@simplewebauthn/browser` APIs are only touched inside call sites, which
  stay web-gated.
- `app/tailwind.config.js` — `darkMode: "class"`.
- `app/src/theme.tsx` (new) — `ThemeProvider` + `useTheme()` returning
  `{ scheme, pref, setPref }`. `scheme` = `pref === "system" ? useColorScheme()
  (device) : pref`; provider calls NativeWind's `colorScheme.set(scheme)` so
  `dark:` variants resolve. Pref fetched from `GET /api/me` when signed in,
  written via `PATCH /api/me`; signed-out → `system`. Cached locally
  (localStorage web / SecureStore native) to avoid a theme flash on launch.
  Also exports a `navColors(scheme)` token map for the RN-navigation chrome
  (`headerStyle`, `tabBar*TintColor`, `StatusBar`) which isn't className-able.
- `app/src/app/_layout.tsx` + `(tabs)/_layout.tsx` — mount `ThemeProvider`,
  apply `navColors`.
- All screens/components — add `dark:` twins to color utilities
  (`bg-white` → `bg-white dark:bg-neutral-900`, etc.). Mechanical pass over
  ~480 className usages.
- `profile.tsx` — avatar display+upload (expo-image-picker, already a dep),
  display_name field removed; socials section listing the verified Gravatar
  accounts + a "manage on gravatar.com" link + refresh button + a picker for
  `preferred_social` ("shown as your leaderboard name"); theme picker
  (light/dark/system); passkey manager (list via `useListPasskeys` /
  `authClient.passkey.addPasskey` / `deletePasskey`; web-only, hidden on
  native).
- `MagicLinkForm` / `signin.tsx` — "Sign in with passkey" button (web-only)
  → `authClient.signIn.passkey()`, falling back to the magic-link form on
  error/cancel.

## API summary

| Method | Path | Notes |
|---|---|---|
| GET | `/api/me` | +theme, socials (verified), preferred_social, avatar_url |
| PATCH | `/api/me` | +theme, preferred_social; display_name no longer accepted |
| POST | `/api/me/socials/refresh` | force Gravatar re-fetch |
| POST | `/api/me/avatar` | raw image body, ≤2 MB |
| DELETE | `/api/me/avatar` | removes uploaded avatar |
| GET | `/api/avatar/:userId` | public R2 stream |
| * | `/api/auth/passkey/*` | plugin-provided (register, auth options/verify, list, delete) |

## Testing

- `test/profile.test.ts` (new): PATCH validation for theme + preferred_social
  (rejects a platform not in the verified cache, rejects display_name);
  Gravatar refresh path with a stubbed fetch (accounts cached, preferred
  validated against them, `GRAVATAR_API_KEY` unset → skipped); GET /api/me
  shape incl. gravatar `avatar_url` for unuploaded users; avatar POST→GET
  round-trip through the miniflare R2 binding; DELETE restores gravatar;
  non-image body 400; oversize 413; leaderboard renders the verified handle
  for opted-in users.
- Passkey endpoints: unauthenticated calls return 401 (plugin mounted).
- Existing suite must stay green (`bun run test` = 170 tests currently).

## My calls (not user-approved, flag if wrong)

- Platforms are whatever Gravatar verifies — `preferred_social` stores the
  `service_type` key; display uses `service_label`. No fixed platform list
  on our side.
- Avatar max 2 MB (vs submission 8 MB); jpeg/png/webp only; `d=identicon`
  Gravatar default; 1 h public cache.
- Theme pref lives server-side only; signed-out users get `system`.
- Passkey rpID/origin derived from the request URL (works in dev, prod, and
  any future custom domain).
- `avatar_url` is a relative `/api/avatar/<id>` path; native clients prefix
  `API_BASE` (same convention as submission images).
- Gravatar snapshot refreshes on `GET /api/me` when >24 h stale (plus the
  manual refresh endpoint); leaderboard never calls Gravatar — it renders
  whatever snapshot exists, so a deleted gravatar account lingers until the
  next refresh.
