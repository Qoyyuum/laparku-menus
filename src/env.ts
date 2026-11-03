export interface Env {
  DB: D1Database;
  SUBMISSIONS: R2Bucket;
  SUBMISSION_QUEUE: Queue;
  AI: Ai;
  ASSETS: Fetcher;
  PUBLIC_BASE_URL: string;
  // Extraction pipeline ([vars]): vision model id + provider selector.
  EXTRACTION_MODEL: string;
  // "workers-ai" (default) | "stub" (tests — returns a fixture, no AI call).
  EXTRACTOR: string;
  TURNSTILE_SECRET_KEY: string;
  BETTER_AUTH_SECRET: string;
  RESEND_API_KEY: string;
}
