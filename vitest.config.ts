import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

const migrationsPath = "./migrations";
const migrations = existsSync(migrationsPath) ? await readD1Migrations(migrationsPath) : [];

export default defineConfig({
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
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
