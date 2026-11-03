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
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
});
