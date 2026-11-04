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

// --- /api/me prefs -----------------------------------------------------------

interface MeResponse {
  display_name: string | null;
  show_on_leaderboard: boolean;
  show_credit: boolean;
  theme: string;
  preferred_social: string | null;
  socials: { platform: string; label: string; handle: string; url: string }[];
  avatar_url: string;
}

async function getMe(cookie: string): Promise<MeResponse> {
  const res = await SELF.fetch("https://x/api/me", { headers: { cookie } });
  expect(res.status).toBe(200);
  return res.json();
}

async function patchMe(cookie: string, body: unknown): Promise<Response> {
  return SELF.fetch("https://x/api/me", {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

it("PATCH theme validated; display_name no longer writes", async () => {
  const u = await forgeSession("submitter");
  expect((await patchMe(u.cookie, { theme: "neon" })).status).toBe(400);
  expect((await patchMe(u.cookie, { theme: "dark" })).status).toBe(200);
  // old-field regression: a patch naming only display_name 400s, no write
  expect((await patchMe(u.cookie, { display_name: "VulgarName" })).status).toBe(400);
  const me = await getMe(u.cookie);
  expect(me.theme).toBe("dark");
  expect(me.display_name).toBeNull();
});

it("GET /api/me exposes theme, preferred_social, socials and a gravatar avatar_url", async () => {
  const u = await forgeSession("submitter");
  const me = await getMe(u.cookie);
  expect(me.theme).toBe("system");
  expect(me.preferred_social).toBeNull();
  expect(me.socials).toEqual([]);
  expect(me.avatar_url).toBe(
    `https://www.gravatar.com/avatar/${await sha256Hex(`${u.userId}@test.dev`)}?s=200&d=identicon`,
  );
});
