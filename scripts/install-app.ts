import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

// postinstall hook: the Expo app in app/ is NOT a bun workspace (metro can't
// resolve bun's isolated .bun store layout), so it keeps its own node_modules
// and lockfile. `bun install` at the repo root runs this to install it too.
if (!existsSync("app/package.json")) process.exit(0);
console.log("[install-app] installing app/ dependencies");
const res = spawnSync(process.execPath, ["install"], { cwd: "app", stdio: "inherit" });
process.exit(res.status ?? 1);
