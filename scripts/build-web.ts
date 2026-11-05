import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// `bun run build:web` — export the Expo app to static web files in app/dist.
const res = spawnSync(process.execPath, ["x", "expo", "export", "--platform", "web"], {
  cwd: "app",
  stdio: "inherit",
});
if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);

// PWA share target — "Share → Laparku" from Chrome/Android for installed
// PWAs. Best-effort: if the export doesn't emit a patchable manifest, skip.
const manifestPath = "app/dist/manifest.json";
if (existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.share_target = {
      action: "/import",
      method: "GET",
      params: { title: "title", text: "text", url: "url" },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log("[build-web] share_target added to web manifest");
  } catch (e) {
    console.warn("[build-web] manifest patch skipped:", e);
  }
}
