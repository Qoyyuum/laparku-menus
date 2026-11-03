import { applyD1Migrations, env } from "cloudflare:test";

// Applies migrations/*.sql (injected as the TEST_MIGRATIONS binding by
// vitest.config.ts) to the test D1 before each test file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
