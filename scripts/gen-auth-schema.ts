// Generates migrations/0001_auth.sql — run: bun scripts/gen-auth-schema.ts
// The @better-auth/cli can't reach the D1 binding, so we stand up a local
// bun:sqlite database with the same plugin set and compile the kysely
// migration plan to SQLite DDL.
import { Database } from "bun:sqlite";
import { apiKey } from "@better-auth/api-key";
import { getMigrations } from "better-auth/db/migration";
import { admin, magicLink } from "better-auth/plugins";

const { compileMigrations } = await getMigrations({
  database: new Database(":memory:"),
  plugins: [
    admin({ defaultRole: "submitter" }),
    magicLink({
      sendMagicLink: async () => {},
    }),
    apiKey(),
  ],
});
console.log(await compileMigrations());
