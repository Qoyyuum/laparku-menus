import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Pretest hook: the Expo web export (app/dist) is a gitignored build artifact,
// so a fresh checkout must build it before the app smoke test can assert on
// what the worker serves. Skip when the export already exists.
if (!existsSync("app/dist/index.html")) {
  // `bun install` at the repo root installs the app workspace too — without it
  // the export fails on missing metro/babel packages.
  if (!existsSync("app/node_modules/expo") && !existsSync("node_modules/expo")) {
    console.error("[ensure-web-build] expo not installed for app/ — run `bun install` at the repo root");
    process.exit(1);
  }
  console.log("[ensure-web-build] app/dist missing — running expo export --platform web");
  const res = spawnSync(process.execPath, ["x", "expo", "export", "--platform", "web"], {
    cwd: "app",
    stdio: "inherit",
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
}
