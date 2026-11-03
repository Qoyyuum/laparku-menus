import { spawnSync } from "node:child_process";

// `bun run build:web` — export the Expo app to static web files in app/dist.
const res = spawnSync(process.execPath, ["x", "expo", "export", "--platform", "web"], {
  cwd: "app",
  stdio: "inherit",
});
process.exit(res.status ?? 1);
