import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { submissions } from "../src/db/schema";
import type { Env } from "../src/env";
import submissionsApi from "../src/routes/submissions";
import { forgeSession } from "./helpers/auth";

// Phase-2 auth gate on submissions: v1 allowed anonymous multipart uploads;
// every write to /api/submissions* now requires a better-auth session and the
// row's user_id records which user filed it.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);

const app = new Hono<{ Bindings: Env }>().route("/api", submissionsApi);

function queueMock(): { sent: unknown[]; env: Env } {
  const sent: unknown[] = [];
  const mockEnv = new Proxy(env, {
    get(target, prop) {
      if (prop === "SUBMISSION_QUEUE") {
        return {
          send: async (msg: unknown) => {
            sent.push(msg);
          },
        };
      }
      return Reflect.get(target, prop);
    },
  }) as Env;
  return { sent, env: mockEnv };
}

function pngForm(extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("source_type", "menu_photo");
  form.set("provenance", "photo of the physical menu at the stall");
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  form.append("files", new File([PNG], "menu.png", { type: "image/png" }));
  return form;
}

it("Review Focus #4: anonymous multipart POST /api/submissions → 401, no row", async () => {
  const q = queueMock();
  const before = await getDb(env).select().from(submissions);
  const res = await app.request("/api/submissions", { method: "POST", body: pngForm() }, q.env);
  expect(res.status).toBe(401);
  expect(q.sent).toHaveLength(0);
  const after = await getDb(env).select().from(submissions);
  expect(after).toHaveLength(before.length);
});

it("X-Laparku-Client: app is not an auth substitute → still 401", async () => {
  const q = queueMock();
  const res = await app.request(
    "/api/submissions",
    { method: "POST", headers: { "X-Laparku-Client": "app" }, body: pngForm() },
    q.env,
  );
  expect(res.status).toBe(401);
});

it("authenticated multipart POST → 201 and the row's user_id is the session user", async () => {
  const { cookie, userId } = await forgeSession("submitter");
  const q = queueMock();
  const res = await app.request(
    "/api/submissions",
    { method: "POST", headers: { cookie }, body: pngForm() },
    q.env,
  );
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  const [row] = await getDb(env).select().from(submissions).where(eq(submissions.id, id));
  expect(row?.user_id).toBe(userId);
  expect(q.sent).toEqual([{ submissionId: id }]);
});

it("anonymous POST /api/submissions/manual → 401, no row (kept from v1)", async () => {
  const q = queueMock();
  const res = await app.request(
    "/api/submissions/manual",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_type: "manual_entry",
        provenance: "typed off the menu board",
        items: [{ name: "Ambuyat", price_bnd: 4.5 }],
      }),
    },
    q.env,
  );
  expect(res.status).toBe(401);
  const rows = await getDb(env).select().from(submissions).where(eq(submissions.source_type, "manual_entry"));
  expect(rows).toHaveLength(0);
  expect(q.sent).toHaveLength(0);
});

it("authenticated manual_entry → 201 and user_id is the session user", async () => {
  const { cookie, userId } = await forgeSession("submitter");
  const q = queueMock();
  const res = await app.request(
    "/api/submissions/manual",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        source_type: "manual_entry",
        provenance: "typed off the menu board",
        items: [{ name: "Ambuyat", price_bnd: 4.5 }],
      }),
    },
    q.env,
  );
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  const [row] = await getDb(env).select().from(submissions).where(eq(submissions.id, id));
  expect(row?.user_id).toBe(userId);
});

it("a banned submitter's session is rejected with 403 on both routes", async () => {
  const { cookie } = await forgeSession("submitter", { banned: true });
  const q = queueMock();
  const res = await app.request(
    "/api/submissions",
    { method: "POST", headers: { cookie }, body: pngForm() },
    q.env,
  );
  expect(res.status).toBe(403);
  const manual = await app.request(
    "/api/submissions/manual",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        source_type: "manual_entry",
        provenance: "x",
        items: [{ name: "x" }],
      }),
    },
    q.env,
  );
  expect(manual.status).toBe(403);
  expect(q.sent).toHaveLength(0);
});
