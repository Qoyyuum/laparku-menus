import { expect, it } from "vitest";
import { SELF } from "cloudflare:test";

it("GET /api/health returns ok", async () => {
  const res = await SELF.fetch("https://x/api/health");
  expect(await res.json()).toEqual({ status: "ok" });
});
