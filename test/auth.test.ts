import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { submissions } from "../src/db/schema";

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
// header value that satisfy auth.api.getSession. The kysely adapter stores
// dates as ISO strings and booleans as 0/1 for sqlite backends (D1 included).
async function forgeSession(role: string): Promise<string> {
  const now = new Date();
  const userId = crypto.randomUUID();
  const token = crypto.randomUUID().replaceAll("-", "");
  await env.DB.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "role")
     VALUES (?, ?, ?, 0, ?, ?, ?)`,
  )
    .bind(userId, "Forge", `${userId}@test.dev`, now.toISOString(), now.toISOString(), role)
    .run();
  const expires = new Date(now.getTime() + 60 * 60 * 1000);
  await env.DB.prepare(
    `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), expires.toISOString(), token, now.toISOString(), now.toISOString(), userId)
    .run();
  const secret = env.BETTER_AUTH_SECRET || DEFAULT_SECRET;
  return `better-auth.session_token=${await signCookieValue(token, secret)}`;
}

it("GET /api/admin/ping returns 401 with no session", async () => {
  const res = await SELF.fetch("https://x/api/admin/ping");
  expect(res.status).toBe(401);
});

it("GET /api/admin/ping returns 403 for a submitter-role session", async () => {
  const cookie = await forgeSession("submitter");
  const res = await SELF.fetch("https://x/api/admin/ping", { headers: { cookie } });
  expect(res.status).toBe(403);
});

it("GET /api/admin/ping returns 200 for a reviewer session", async () => {
  const cookie = await forgeSession("reviewer");
  const res = await SELF.fetch("https://x/api/admin/ping", { headers: { cookie } });
  expect(res.status).toBe(200);
});

it("GET /api/admin/ping returns 200 for an admin session", async () => {
  const cookie = await forgeSession("admin");
  const res = await SELF.fetch("https://x/api/admin/ping", { headers: { cookie } });
  expect(res.status).toBe(200);
});

it("POST /api/submissions/manual accepts a real better-auth session", async () => {
  const cookie = await forgeSession("submitter");
  const res = await SELF.fetch("https://x/api/submissions/manual", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      source_type: "manual_entry",
      provenance: "typed in by the cafe owner over the counter",
      items: [{ name: "Teh Tarik", price_bnd: 1.0 }],
    }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  const [row] = await getDb(env).select().from(submissions).where(eq(submissions.id, id));
  expect(row?.source_type).toBe("manual_entry");
  expect(row?.status).toBe("pending");
});
