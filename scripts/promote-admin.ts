// Promote a user's role in the D1 `user` table — bootstrap path for the
// first reviewer/admin (there's no admin UI yet).
//
//   bun scripts/promote-admin.ts <email> [--role admin|reviewer|submitter] [--local]
//
// Default role is `admin`; --local targets `wrangler d1`'s local DB instead
// of the remote one. The user row must already exist (i.e. the person has
// signed in via magic link at least once).
import { spawnSync } from "node:child_process";

const ROLES = ["admin", "reviewer", "submitter"] as const;
const DB_NAME = "laparku-menus-db";

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}`);
  console.error("usage: bun scripts/promote-admin.ts <email> [--role admin|reviewer|submitter] [--local]");
  process.exit(1);
}

const args = process.argv.slice(2);
const local = args.includes("--local");
const positional = args.filter((a) => !a.startsWith("--"));
const roleFlagIdx = args.indexOf("--role");
const role = roleFlagIdx >= 0 ? args[roleFlagIdx + 1] : "admin";
const email = positional.find((a) => a !== role);

if (!email || !/^[^\s'"]+@[^\s'"]+$/.test(email)) usage("a valid email argument is required");
if (!role || !(ROLES as readonly string[]).includes(role)) usage(`--role must be one of: ${ROLES.join(", ")}`);

// Values are single-quote escaped; email/role are already charset-validated.
const sqlEsc = (v: string) => v.replaceAll("'", "''");
const sql = `UPDATE "user" SET role = '${sqlEsc(role)}', "updatedAt" = '${new Date().toISOString()}' WHERE email = '${sqlEsc(email)}';`;

// Run wrangler through bunx so the repo-local devDependency is used.
const cmd = ["wrangler", "d1", "execute", DB_NAME, local ? "--local" : "--remote", "--command", sql];
console.log(`> ${cmd.slice(0, -1).join(" ")} <sql>`);
const res = spawnSync("bunx", cmd, { stdio: "inherit" });
process.exit(res.status ?? 1);
