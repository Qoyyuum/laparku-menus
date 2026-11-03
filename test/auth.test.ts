import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { submissions } from "../src/db/schema";
import { forgeSession } from "./helpers/auth";

// forgeSession lives in test/helpers/auth.ts (shared with admin.test.ts);
// it returns { cookie, userId } — these tests only need the Cookie header.
async function cookieFor(role: string, opts?: { banned?: boolean }): Promise<string> {
  return (await forgeSession(role, opts)).cookie;
}

it("GET /api/admin/ping returns 401 with no session", async () => {
  const res = await SELF.fetch("https://x/api/admin/ping");
  expect(res.status).toBe(401);
});

it("GET /api/admin/ping returns 403 for a submitter-role session", async () => {
  const cookie = await cookieFor("submitter");
  const res = await SELF.fetch("https://x/api/admin/ping", { headers: { cookie } });
  expect(res.status).toBe(403);
});

it("GET /api/admin/ping returns 200 for a reviewer session", async () => {
  const cookie = await cookieFor("reviewer");
  const res = await SELF.fetch("https://x/api/admin/ping", { headers: { cookie } });
  expect(res.status).toBe(200);
});

it("GET /api/admin/ping returns 200 for an admin session", async () => {
  const cookie = await cookieFor("admin");
  const res = await SELF.fetch("https://x/api/admin/ping", { headers: { cookie } });
  expect(res.status).toBe(200);
});

it("GET /api/admin/ping returns 200 for a comma-separated multi-role user", async () => {
  // The admin plugin's setRole writes arrays as "admin,reviewer" — the check
  // must match on any role in the list, not the raw string.
  const cookie = await cookieFor("admin,reviewer");
  const res = await SELF.fetch("https://x/api/admin/ping", { headers: { cookie } });
  expect(res.status).toBe(200);
});

it("GET /api/admin/ping returns 403 for a banned reviewer", async () => {
  const cookie = await cookieFor("reviewer", { banned: true });
  const res = await SELF.fetch("https://x/api/admin/ping", { headers: { cookie } });
  expect(res.status).toBe(403);
});

it("POST /api/submissions/manual accepts a real better-auth session", async () => {
  const cookie = await cookieFor("submitter");
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
