export interface Env {
  DB: D1Database;
  SUBMISSIONS: R2Bucket;
  SUBMISSION_QUEUE: Queue;
  AI: Ai;
  ASSETS: Fetcher;
  // Optional [[ratelimits]] binding — consumed by src/middleware/rate-limit.ts
  // on write endpoints. Absent in test/local envs that don't declare it.
  RATE_LIMITER?: RateLimit;
  PUBLIC_BASE_URL: string;
  // Extraction pipeline ([vars]): vision model id + provider selector.
  EXTRACTION_MODEL: string;
  // "workers-ai" (default) | "stub" (tests — returns a fixture, no AI call).
  EXTRACTOR: string;
  TURNSTILE_SECRET_KEY: string;
  BETTER_AUTH_SECRET: string;
  // Cloudflare Email Service send_email binding ([[send_email]] in
  // wrangler.toml) — magic links + notification emails. Optional like
  // RATE_LIMITER: absent in envs that don't declare it → sendEmail() logs
  // and no-ops.
  EMAIL?: SendEmail;
  // From-address for outbound email (optional [vars]; falls back to a
  // no-reply@laparku.com default in src/lib/notify.ts). Its domain must be
  // onboarded to Email Sending for sends to go out.
  AUTH_EMAIL_FROM?: string;
  // Freshness thresholds ([vars], parsed in src/lib/freshness.ts): a venue
  // is stale when last verified more than STALE_MONTHS ago (or never
  // verified), or when STALE_NO_VOTES distinct users vote "not accurate"
  // since the last verification. Defaults 6 / 3 when unset or unparsable.
  STALE_MONTHS?: string;
  STALE_NO_VOTES?: string;
  // Product-lookup chain secrets (`wrangler secret put`; absent in tests →
  // that provider is skipped). See src/lib/product-lookup.ts.
  EAN_SEARCH_TOKEN?: string;
  UPCITEMDB_KEY?: string;
  BARCODELookup_KEY?: string;
}
