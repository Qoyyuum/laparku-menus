import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

// The worker serves the Expo web export from app/dist via the ASSETS binding.
// The export is a gitignored build artifact — the `pretest` script
// (scripts/ensure-web-build.ts) builds it before `bun run test` when missing.
const BUILD_HINT = "is app/dist built? run `bun run build:web`";

it("GET / serves the exported app HTML", async () => {
  const res = await SELF.fetch("https://x/");
  expect(res.status, BUILD_HINT).toBe(200);
  const html = await res.text();
  expect(html).toContain("<html");
  // Expo web export mounts the app at #root.
  expect(html).toContain('id="root"');
});

it("GET /search falls back to the SPA", async () => {
  const res = await SELF.fetch("https://x/search");
  expect(res.status, BUILD_HINT).toBe(200);
  const html = await res.text();
  expect(html).toContain('id="root"');
});
