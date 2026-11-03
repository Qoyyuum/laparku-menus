import { env } from "cloudflare:test";

// Mirrors DEFAULT_SECRET in better-auth/dist/utils/constants.mjs — used when
// env.BETTER_AUTH_SECRET is unset (test env). If the binding is set, the real
// secret is used instead.
const DEFAULT_SECRET = "better-auth-secret-12345678901234567890";

// better-auth signs the session_token cookie as `<token>.<base64 hmac>`
// (better-call signCookieValue: HMAC-SHA256 with the auth secret, standard
// base64 with padding). We reproduce that here to forge sessions without
// going through the magic-link email flow.
async function signCookieValue(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return encodeURIComponent(`${value}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`);
}

// Inserts a better-auth `user` + `session` row directly and returns a Cookie
// header value that satisfies auth.api.getSession, plus the forged user id
// (reviewer_id on decided submissions points at it). The kysely adapter
// stores dates as ISO strings and booleans as 0/1 for sqlite backends (D1
// included).
export async function forgeSession(
  role: string,
  { banned = false }: { banned?: boolean } = {},
): Promise<{ cookie: string; userId: string }> {
  const now = new Date();
  const userId = crypto.randomUUID();
  const token = crypto.randomUUID().replaceAll("-", "");
  await env.DB.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "role", "banned")
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
  )
    .bind(userId, "Forge", `${userId}@test.dev`, now.toISOString(), now.toISOString(), role, banned ? 1 : 0)
    .run();
  const expires = new Date(now.getTime() + 60 * 60 * 1000);
  await env.DB.prepare(
    `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), expires.toISOString(), token, now.toISOString(), now.toISOString(), userId)
    .run();
  const secret = env.BETTER_AUTH_SECRET || DEFAULT_SECRET;
  return { cookie: `better-auth.session_token=${await signCookieValue(token, secret)}`, userId };
}
