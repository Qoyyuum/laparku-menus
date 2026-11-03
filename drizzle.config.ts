import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  // Drizzle writes <out>/0000_init.sql (+ meta/); `wrangler d1 migrations`
  // applies the *.sql files in this same directory.
  out: "./migrations",
});
