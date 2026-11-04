import { env, SELF } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { fetchVerifiedAccounts, gravatarUrl, sha256Hex } from "../src/lib/gravatar";
import type { Env } from "../src/env";
import { forgeSession } from "./helpers/auth";

// --- gravatar lib -----------------------------------------------------------

it("gravatarUrl is the sha256 avatar URL with identicon fallback", async () => {
  const url = await gravatarUrl("  User@Example.com ");
  const sha = await sha256Hex("user@example.com");
  expect(url).toBe(`https://www.gravatar.com/avatar/${sha}?s=200&d=identicon`);
});

it("fetchVerifiedAccounts normalizes verified_accounts, hides hidden, [] on 404", async () => {
  const email = "has-profile@test.dev";
  const sha = await sha256Hex(email);
  const realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer k");
    if (url === `https://api.gravatar.com/v3/profiles/${sha}`) {
      return new Response(
        JSON.stringify({
          verified_accounts: [
            {
              service_type: "instagram",
              service_label: "Instagram",
              service_icon: "i",
              url: "https://instagram.com/fit.food/",
              is_hidden: false,
            },
            {
              service_type: "tiktok",
              service_label: "TikTok",
              service_icon: "i",
              url: "https://tiktok.com/@fitfood",
              is_hidden: false,
            },
            {
              service_type: "x",
              service_label: "X",
              service_icon: "i",
              url: "https://x.com/hidden",
              is_hidden: true,
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  try {
    const rows = await fetchVerifiedAccounts({ GRAVATAR_API_KEY: "k" } as Env, email);
    expect(rows).toEqual([
      {
        platform: "instagram",
        label: "Instagram",
        handle: "fit.food",
        url: "https://instagram.com/fit.food/",
      },
      { platform: "tiktok", label: "TikTok", handle: "fitfood", url: "https://tiktok.com/@fitfood" },
    ]);
    expect(await fetchVerifiedAccounts({ GRAVATAR_API_KEY: "k" } as Env, "none@test.dev")).toEqual([]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
