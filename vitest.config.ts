import { existsSync } from "node:fs";
import { configDefaults, defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

const migrationsPath = "./migrations";
const migrations = existsSync(migrationsPath) ? await readD1Migrations(migrationsPath) : [];

export default defineConfig({
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // .worktrees/ holds independent agent checkouts — each is a full repo
    // clone with its own vitest.config + migrations. Letting the root run
    // pick up their test files runs them against the ROOT worker and the
    // ROOT schema, which fails the moment a worktree adds a feature the
    // root doesn't have yet. .gitignore already excludes the directory;
    // the test config now matches.
    exclude: [...configDefaults.exclude, ".worktrees/**"],
    // Each test file boots its own miniflare worker + D1, so a fully
    // parallel run on a busy machine can starve individual tests past the
    // 5 s default. 15 s is enough headroom for real load while still
    // catching actual hangs.
    testTimeout: 15_000,
  },
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // Tests forge `better-auth.session_token` cookies; an https
          // PUBLIC_BASE_URL (production value in wrangler.toml) flips
          // better-auth to __Secure- cookie names and every forged session
          // 401s. Keep the test env on http — production config unaffected.
          PUBLIC_BASE_URL: "http://localhost:8787",
        },
      },
    }),
  ],
});
