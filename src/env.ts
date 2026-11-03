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
  RESEND_API_KEY: string;
  // From-address for magic-link emails (optional [vars]; falls back to a
  // no-reply@laparku.com default in src/auth.ts).
  AUTH_EMAIL_FROM?: string;
  // Freshness thresholds ([vars], parsed in src/lib/freshness.ts): a venue
  // is stale when last verified more than STALE_MONTHS ago (or never
  // verified), or when STALE_NO_VOTES distinct users vote "not accurate"
  // since the last verification. Defaults 6 / 3 when unset or unparsable.
  STALE_MONTHS?: string;
  STALE_NO_VOTES?: string;
}
