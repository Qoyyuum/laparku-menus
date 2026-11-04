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
    expect(
      ((init as { headers?: Record<string, string> } | undefined)?.headers ?? {}).authorization,
    ).toBe("Bearer k");
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
  }) as unknown as typeof fetch;
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
  return (await res.json()) as MeResponse;
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

// --- socials refresh ---------------------------------------------------------

const GRAVATAR_PAYLOAD = {
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
  ],
};

function stubGravatar(email: string, opts: { fail?: boolean } = {}) {
  const realFetch = globalThis.fetch;
  return (async () => {
    const sha = await sha256Hex(email);
    globalThis.fetch = vi.fn(async (input: unknown) => {
      if (opts.fail) throw new Error("gravatar down");
      if (String(input) === `https://api.gravatar.com/v3/profiles/${sha}`) {
        return new Response(JSON.stringify(GRAVATAR_PAYLOAD), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  })();
}

it("POST /me/socials/refresh caches verified accounts; preferred_social validates against them", async () => {
  const u = await forgeSession("submitter");
  const prevKey = env.GRAVATAR_API_KEY;
  env.GRAVATAR_API_KEY = "k";
  const restore = await stubGravatar(`${u.userId}@test.dev`);
  try {
    const res = await SELF.fetch("https://x/api/me/socials/refresh", {
      method: "POST",
      headers: { cookie: u.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { socials: { platform: string }[] };
    expect(body.socials.map((s) => s.platform)).toEqual(["instagram", "tiktok"]);

    // A platform in the verified set is accepted; anything else 400s.
    expect((await patchMe(u.cookie, { preferred_social: "instagram" })).status).toBe(200);
    expect((await patchMe(u.cookie, { preferred_social: "myspace" })).status).toBe(400);
    expect((await getMe(u.cookie)).preferred_social).toBe("instagram");
  } finally {
    restore();
    env.GRAVATAR_API_KEY = prevKey || "";
  }
});

it("refresh failures are not fatal: endpoint still 200s with the stale cache", async () => {
  const u = await forgeSession("submitter");
  // Pre-seed a snapshot so there's a "stale cache" to fall back to.
  await env.DB.prepare(`UPDATE "user" SET gravatar_accounts = ? WHERE id = ?`)
    .bind(JSON.stringify([{ platform: "x", label: "X", handle: "oldone", url: "https://x.com/oldone" }]), u.userId)
    .run();
  const prevKey = env.GRAVATAR_API_KEY;
  env.GRAVATAR_API_KEY = "k";
  const restore = await stubGravatar(`${u.userId}@test.dev`, { fail: true });
  try {
    const res = await SELF.fetch("https://x/api/me/socials/refresh", {
      method: "POST",
      headers: { cookie: u.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { socials: { handle: string }[]; error?: string };
    expect(body.error).toBeTruthy();
    expect(body.socials[0]?.handle).toBe("oldone");
  } finally {
    restore();
    env.GRAVATAR_API_KEY = prevKey || "";
  }
});

it("refresh is skipped when GRAVATAR_API_KEY is unset", async () => {
  const u = await forgeSession("submitter");
  const prevKey = env.GRAVATAR_API_KEY;
  env.GRAVATAR_API_KEY = "";
  const restore = await stubGravatar(`${u.userId}@test.dev`);
  try {
    const res = await SELF.fetch("https://x/api/me/socials/refresh", {
      method: "POST",
      headers: { cookie: u.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { socials: unknown[] };
    expect(body.socials).toEqual([]);
  } finally {
    restore();
    env.GRAVATAR_API_KEY = prevKey || "";
  }
});

it("GET /api/me survives a Gravatar outage on the stale-refresh path", async () => {
  const u = await forgeSession("submitter");
  // Seed a stale snapshot (fetched long ago) so GET /me tries to refresh.
  await env.DB.prepare(
    `UPDATE "user" SET gravatar_accounts = ?, gravatar_fetched_at = ? WHERE id = ?`,
  )
    .bind(
      JSON.stringify([{ platform: "x", label: "X", handle: "cachedhandle", url: "https://x.com/cachedhandle" }]),
      new Date(0).toISOString(),
      u.userId,
    )
    .run();
  const prevKey = env.GRAVATAR_API_KEY;
  env.GRAVATAR_API_KEY = "k";
  const restore = await stubGravatar(`${u.userId}@test.dev`, { fail: true });
  try {
    const me = await getMe(u.cookie);
    expect(me.socials[0]?.handle).toBe("cachedhandle");
  } finally {
    restore();
    env.GRAVATAR_API_KEY = prevKey || "";
  }
});

// --- avatar ------------------------------------------------------------------

// Minimal valid-signature payloads — sniffMagic only checks magic bytes.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

async function postAvatar(cookie: string, body: Uint8Array, contentType = "image/png") {
  return SELF.fetch("https://x/api/me/avatar", {
    method: "POST",
    headers: { "content-type": contentType, cookie },
    body: body as unknown as BodyInit,
  });
}

it("avatar upload→serve→delete round-trips through R2", async () => {
  const u = await forgeSession("submitter");
  const up = await postAvatar(u.cookie, PNG_BYTES);
  expect(up.status).toBe(200);
  expect(((await up.json()) as { avatar_url: string }).avatar_url).toBe(`/api/avatar/${u.userId}`);

  // /api/me now reports the uploaded avatar instead of gravatar.
  expect((await getMe(u.cookie)).avatar_url).toBe(`/api/avatar/${u.userId}`);

  const img = await SELF.fetch(`https://x/api/avatar/${u.userId}`);
  expect(img.status).toBe(200);
  expect(img.headers.get("content-type")).toBe("image/png");
  expect(img.headers.get("cache-control")).toContain("public");
  expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG_BYTES);

  const del = await SELF.fetch("https://x/api/me/avatar", { method: "DELETE", headers: { cookie: u.cookie } });
  expect(del.status).toBe(200);
  expect(((await del.json()) as { avatar_url: string }).avatar_url).toContain("gravatar.com/avatar/");
  expect((await SELF.fetch(`https://x/api/avatar/${u.userId}`)).status).toBe(404);
});

it("avatar upload rejects non-images, oversize, and unauthenticated callers", async () => {
  const u = await forgeSession("submitter");
  expect((await postAvatar(u.cookie, PDF_BYTES, "application/pdf")).status).toBe(400);
  // Declared png but actually pdf bytes → sniff wins over the header.
  expect((await postAvatar(u.cookie, PDF_BYTES, "image/png")).status).toBe(400);
  const big = new Uint8Array(2 * 1024 * 1024 + 1);
  big.set(PNG_BYTES);
  expect((await postAvatar(u.cookie, big)).status).toBe(413);
  expect((await postAvatar("", PNG_BYTES)).status).toBe(401);
  expect((await SELF.fetch("https://x/api/avatar/no-such-user")).status).toBe(404);
});

// --- passkeys ----------------------------------------------------------------

it("passkey plugin is mounted: its endpoints 401 unauthenticated, not 404", async () => {
  const res = await SELF.fetch("https://x/api/auth/passkey/list-user-passkeys");
  // A missing plugin would fall through to 404; mounted but unauthed → 401.
  expect(res.status).toBe(401);
});
