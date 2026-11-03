import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { submissions } from "../src/db/schema";
import type { Env } from "../src/env";
import submissionsApi from "../src/routes/submissions";
import { forgeSession } from "./helpers/auth";

// Real PNG magic bytes + arbitrary filler — sniffMagic only reads the
// signature. PNG_A and PNG_B differ after the header so their sha256s differ.
const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6, 5]);
// Windows .exe (MZ header) masquerading as an image upload.
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);

const app = new Hono<{ Bindings: Env }>().route("/api", submissionsApi);

// Wraps the real test env so SUBMISSION_QUEUE.send records messages instead
// of going to miniflare's queue — everything else (D1, R2) stays real.
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

function pngForm(bytes: Uint8Array, extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("source_type", "menu_photo");
  form.set("provenance", "photo of the physical menu at the stall");
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  form.append("files", new File([bytes], "menu.png", { type: "image/png" }));
  return form;
}

// Phase 2: every submission write needs a session. `cookie` comes from
// forgeSession; pass the same one to share a submitter across calls.
function postSubmission(e: Env, form: FormData, cookie: string) {
  return app.request("/api/submissions", { method: "POST", headers: { cookie }, body: form }, e);
}

it("accepts a real PNG: 201, pending row, R2 object, queue message", async () => {
  const { cookie } = await forgeSession("submitter");
  const q = queueMock();
  const res = await postSubmission(q.env, pngForm(PNG_A), cookie);
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  expect(id).toBeTruthy();

  const [row] = await getDb(env).select().from(submissions).where(eq(submissions.id, id));
  expect(row?.status).toBe("pending");
  expect(row?.source_type).toBe("menu_photo");
  expect(row?.provenance).toContain("physical menu");
  expect(row?.image_keys).toHaveLength(1);
  expect(row?.image_keys?.[0]).toBe(`submissions/${id}/0`);
  expect(row?.sha256).toBeTruthy();
  expect(row?.auto_flags).not.toContain("dup_sha256");

  // The file bytes actually landed in R2.
  const obj = await env.SUBMISSIONS.get(row!.image_keys![0]!);
  expect(obj).not.toBeNull();

  // Extraction consumer (Task 7) reads { submissionId } off the queue.
  expect(q.sent).toEqual([{ submissionId: id }]);
});

it("Review Focus #2: .exe bytes labeled image/png are rejected with 400", async () => {
  const { cookie } = await forgeSession("submitter");
  const q = queueMock();
  const before = await getDb(env).select().from(submissions);
  const res = await postSubmission(q.env, pngForm(EXE), cookie);
  expect(res.status).toBe(400);
  expect(q.sent).toHaveLength(0);
  const after = await getDb(env).select().from(submissions);
  expect(after).toHaveLength(before.length);
});

it("missing provenance is rejected with 400", async () => {
  const { cookie } = await forgeSession("submitter");
  const q = queueMock();
  const form = new FormData();
  form.set("source_type", "menu_photo");
  form.append("files", new File([PNG_A], "m.png", { type: "image/png" }));
  const res = await postSubmission(q.env, form, cookie);
  expect(res.status).toBe(400);
  expect(q.sent).toHaveLength(0);
});

it("Review Focus #4: anonymous manual_entry gets 401 and creates no row", async () => {
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
  const rows = await getDb(env)
    .select()
    .from(submissions)
    .where(eq(submissions.source_type, "manual_entry"));
  expect(rows).toHaveLength(0);
  expect(q.sent).toHaveLength(0);
});

it("Review Focus #5: identical bytes resubmitted → second row flagged dup_sha256", async () => {
  const { cookie } = await forgeSession("submitter");
  const q = queueMock();
  const res1 = await postSubmission(q.env, pngForm(PNG_B), cookie);
  expect(res1.status).toBe(201);
  const { id: id1 } = (await res1.json()) as { id: string };

  const res2 = await postSubmission(q.env, pngForm(PNG_B, { provenance: "same menu, submitted again" }), cookie);
  expect(res2.status).toBe(201);
  const { id: id2 } = (await res2.json()) as { id: string };
  expect(id2).not.toBe(id1);

  const db = getDb(env);
  const [first] = await db.select().from(submissions).where(eq(submissions.id, id1));
  const [second] = await db.select().from(submissions).where(eq(submissions.id, id2));
  expect(first?.auto_flags).not.toContain("dup_sha256");
  expect(second?.auto_flags).toContain("dup_sha256");
  // Flagged, not silently merged: it still went to R2 + queue.
  expect(second?.image_keys?.[0]).toBe(`submissions/${id2}/0`);
  expect(q.sent).toEqual([{ submissionId: id1 }, { submissionId: id2 }]);
});

it("magic bytes decide type: PDF bytes labeled image/png are stored as pdf", async () => {
  const { cookie } = await forgeSession("submitter");
  const q = queueMock();
  const res = await postSubmission(q.env, pngForm(PDF), cookie);
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  const obj = await env.SUBMISSIONS.get(`submissions/${id}/0`);
  expect(obj?.httpMetadata?.contentType).toBe("application/pdf");
});
