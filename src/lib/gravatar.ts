import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import type { Env } from "../env";

// SHA-256 hex of a string — Gravatar's v3 API keys profiles on the sha256
// of the normalized email (crypto.subtle is native to Workers; no dep).
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Public avatar image URL for an email — keyless; identicon placeholder
// when the address has no gravatar.
export async function gravatarUrl(email: string, size = 200): Promise<string> {
  const sha = await sha256Hex(email.trim().toLowerCase());
  return `https://www.gravatar.com/avatar/${sha}?s=${size}&d=identicon`;
}

// One verified social account, normalized from Gravatar's
// {service_type, service_label, url} shape. `handle` is the displayable
// username (last path segment of the profile URL).
export interface VerifiedAccount {
  platform: string;
  label: string;
  handle: string;
  url: string;
}

interface GravatarVerifiedAccount {
  service_type: string;
  service_label: string;
  service_icon: string;
  url: string;
  is_hidden: boolean;
}

// instagram.com/fit.food/ → "fit.food"; tiktok.com/@fitfood → "fitfood".
// No usable path segment → bare hostname.
function accountHandle(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    return last ? last.replace(/^@/, "") : u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// GET api.gravatar.com/v3/profiles/<sha256>. The Bearer key is optional
// upstream but raises the verified_accounts cap past 4; we send it when
// configured. 404 means the email isn't the account's primary address —
// treated as "no verified accounts", not an error. Other non-2xx throws.
export async function fetchVerifiedAccounts(env: Env, email: string): Promise<VerifiedAccount[]> {
  const sha = await sha256Hex(email.trim().toLowerCase());
  const res = await fetch(`https://api.gravatar.com/v3/profiles/${sha}`, {
    headers: env.GRAVATAR_API_KEY ? { authorization: `Bearer ${env.GRAVATAR_API_KEY}` } : {},
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`gravatar profile fetch failed: ${res.status}`);
  const body = (await res.json()) as { verified_accounts?: GravatarVerifiedAccount[] };
  return (body.verified_accounts ?? [])
    .filter((a) => !a.is_hidden)
    .map((a) => ({
      platform: a.service_type,
      label: a.service_label,
      handle: accountHandle(a.url),
      url: a.url,
    }));
}

// The public name for a user row: the handle of their preferred_social,
// resolved off the cached snapshot. Missing pick, missing/malformed
// snapshot, or a platform absent from the snapshot → null (caller renders
// "Anonymous"/no credit). Single place the snapshot shape is trusted —
// leaderboards and contributed_by share it.
export function preferredHandle(
  gravatarAccountsJson: string | null | undefined,
  preferredSocial: string | null | undefined,
): string | null {
  if (!preferredSocial || !gravatarAccountsJson) return null;
  try {
    const accounts: unknown = JSON.parse(gravatarAccountsJson);
    if (!Array.isArray(accounts)) return null;
    const match = accounts.find(
      (a): a is { platform: string; handle: string } =>
        typeof a === "object" && a !== null &&
        (a as { platform?: string }).platform === preferredSocial &&
        typeof (a as { handle?: string }).handle === "string" &&
        (a as { handle?: string }).handle !== "",
    );
    return match?.handle ?? null;
  } catch {
    return null;
  }
}

// Refresh the cached snapshot on the user row. Always stamps
// gravatar_fetched_at — even on failure — so a Gravatar outage doesn't
// make every GET /api/me pay for a doomed request.
export async function refreshGravatarAccounts(
  env: Env,
  userId: string,
  email: string,
): Promise<VerifiedAccount[]> {
  const db = getDb(env);
  try {
    const accounts = await fetchVerifiedAccounts(env, email);
    await db.run(sql`
      UPDATE "user" SET gravatar_accounts = ${JSON.stringify(accounts)}, gravatar_fetched_at = ${new Date().toISOString()}
      WHERE id = ${userId}
    `);
    return accounts;
  } catch (e) {
    await db.run(sql`UPDATE "user" SET gravatar_fetched_at = ${new Date().toISOString()} WHERE id = ${userId}`);
    throw e;
  }
}
