import { env, SELF } from "cloudflare:test";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { item_flags, submissions, submitters } from "../src/db/schema";
import type { Env } from "../src/env";
import flagsApi from "../src/routes/flags";
import submissionsApi from "../src/routes/submissions";
import { forgeSession } from "./helpers/auth";
import { seed } from "./helpers/seed";

const db = () => getDb(env);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);

// Locally-mounted apps for tests that need a tweaked env (queue mock /
// Turnstile secret) — the same pattern as test/submissions.test.ts. Tests
// that exercise real worker wiring go through SELF instead.
const intakeApp = new Hono<{ Bindings: Env }>().route("/api", submissionsApi);
const flagApp = new Hono<{ Bindings: Env }>().route("/api", flagsApi);

function envWith(overrides: Record<string, unknown>): Env {
  return new Proxy(env, {
    get(target, prop) {
      if (prop in overrides) return overrides[prop as string];
      return Reflect.get(target, prop);
    },
  }) as Env;
}

function flagItem(id: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`https://x/api/items/${id}/flag`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function listFlags(cookie: string, status = "open") {
  const res = await SELF.fetch(`https://x/api/admin/flags?status=${status}`, { headers: { cookie } });
  return { res, body: (await res.json()) as { flags: AdminFlag[] } };
}

interface AdminFlag {
  id: string;
  item_id: string;
  reason: string;
  reporter_contact: string | null;
  status: string;
  item_name: string;
  venue_id: string;
  venue_name: string;
}

// --- (a) post-publish flags -------------------------------------------------

it("flag creates an open item_flags row, surfaces in the admin flagged list, and resolves", async () => {
  const { venue, items } = await seed(env);
  const item = items[0]!;

  const res = await flagItem(item.id, {
    reason: "price is wrong, it's B$3.00 now",
    reporter_contact: "reporter@test.dev",
  });
  expect(res.status).toBe(201);
  const { id: flagId } = (await res.json()) as { id: string };

  const [row] = await db().select().from(item_flags).where(eq(item_flags.id, flagId));
  expect(row?.item_id).toBe(item.id);
  expect(row?.reason).toBe("price is wrong, it's B$3.00 now");
  expect(row?.reporter_contact).toBe("reporter@test.dev");
  expect(row?.status).toBe("open");

  // The admin flagged list shows it with item + venue context.
  const { cookie } = await forgeSession("reviewer");
  const { res: listRes, body } = await listFlags(cookie);
  expect(listRes.status).toBe(200);
  const flag = body.flags.find((f) => f.id === flagId);
  expect(flag?.item_name).toBe(item.name);
  expect(flag?.venue_id).toBe(venue.id);
  expect(flag?.venue_name).toBe(venue.name);

  // Resolve removes it from the open list; a second resolve 409s.
  const resolve = await SELF.fetch(`https://x/api/admin/flags/${flagId}/resolve`, {
    method: "POST",
    headers: { cookie },
  });
  expect(resolve.status).toBe(200);
  const [resolved] = await db().select().from(item_flags).where(eq(item_flags.id, flagId));
  expect(resolved?.status).toBe("resolved");

  const { body: after } = await listFlags(cookie);
  expect(after.flags.find((f) => f.id === flagId)).toBeUndefined();
  const { body: resolvedList } = await listFlags(cookie, "resolved");
  expect(resolvedList.flags.find((f) => f.id === flagId)).toBeTruthy();
  expect(
    (
      await SELF.fetch(`https://x/api/admin/flags/${flagId}/resolve`, {
        method: "POST",
        headers: { cookie },
      })
    ).status,
  ).toBe(409);
});

it("flag requires a published item and a reason", async () => {
  const { items } = await seed(env);
  const superseded = items.find((i) => i.status === "superseded")!;

  expect((await flagItem(crypto.randomUUID(), { reason: "x" })).status).toBe(404);
  expect((await flagItem(superseded.id, { reason: "x" })).status).toBe(404);
  expect((await flagItem(items[0]!.id, {})).status).toBe(400);
  expect((await flagItem(items[0]!.id, { reason: "   " })).status).toBe(400);
  expect((await flagItem(items[0]!.id, { reason: "x".repeat(2001) })).status).toBe(400);
});

it("flag turnstile rules mirror submissions: secret+no token → 403, app client skips", async () => {
  const { items } = await seed(env);
  const e = envWith({ TURNSTILE_SECRET_KEY: "test-secret" });
  const init = (headers: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ reason: "out of date" }),
  });

  // Secret configured, web client, no token → fail closed (no network call).
  expect((await flagApp.request(`/api/items/${items[0]!.id}/flag`, init(), e)).status).toBe(403);
  // Native app clients can't run the web widget — the header skips it.
  expect(
    (await flagApp.request(`/api/items/${items[0]!.id}/flag`, init({ "X-Laparku-Client": "app" }), e)).status,
  ).toBe(201);
});

it("admin flags endpoints reject non-reviewers", async () => {
  expect((await SELF.fetch("https://x/api/admin/flags")).status).toBe(401);
  const { cookie: submitter } = await forgeSession("submitter");
  expect((await SELF.fetch("https://x/api/admin/flags", { headers: { cookie: submitter } })).status).toBe(403);
  expect(
    (
      await SELF.fetch(`https://x/api/admin/flags/${crypto.randomUUID()}/resolve`, {
        method: "POST",
        headers: { cookie: submitter },
      })
    ).status,
  ).toBe(403);
  // Unknown flag → 404 for a real reviewer.
  const { cookie } = await forgeSession("reviewer");
  expect(
    (
      await SELF.fetch(`https://x/api/admin/flags/${crypto.randomUUID()}/resolve`, {
        method: "POST",
        headers: { cookie },
      })
    ).status,
  ).toBe(404);
});

// --- (b) blocked submitters --------------------------------------------------

it("a blocked submitter's POST /api/submissions gets 403 and no row", async () => {
  const email = `blocked-${crypto.randomUUID()}@test.dev`;
  await db().insert(submitters).values({ identifier: email, trust_tier: "anonymous", blocked: true });

  const form = new FormData();
  form.set("source_type", "menu_photo");
  form.set("provenance", "photo of the menu board");
  form.set("email", email);
  form.append("files", new File([PNG], "menu.png", { type: "image/png" }));

  const sent: unknown[] = [];
  const e = envWith({ SUBMISSION_QUEUE: { send: async (m: unknown) => void sent.push(m) } });
  const res = await intakeApp.request("/api/submissions", { method: "POST", body: form }, e);
  expect(res.status).toBe(403);
  expect(sent).toHaveLength(0);
  // The submitter exists (seeded above) but no submission row was created.
  const [submitter] = await db().select().from(submitters).where(eq(submitters.identifier, email));
  expect(
    await db().select().from(submissions).where(eq(submissions.submitter_id, submitter!.id)),
  ).toHaveLength(0);
});

// --- (c) reputation counters feed the queue sort ----------------------------

it("intake → approve/reject updates the submitter accept-ratio counters end-to-end", async () => {
  const email = `counts-${crypto.randomUUID()}@test.dev`;
  const sent: unknown[] = [];
  const e = envWith({ SUBMISSION_QUEUE: { send: async (m: unknown) => void sent.push(m) } });

  // Three real intake calls under the same email → one submitter, count 3.
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const form = new FormData();
    form.set("source_type", "menu_photo");
    form.set("provenance", `photo of menu page ${i + 1}`);
    form.set("email", email);
    form.append("files", new File([PNG], `m${i}.png`, { type: "image/png" }));
    const res = await intakeApp.request("/api/submissions", { method: "POST", body: form }, e);
    expect(res.status).toBe(201);
    ids.push(((await res.json()) as { id: string }).id);
  }
  const [submitter] = await db().select().from(submitters).where(eq(submitters.identifier, email));
  expect(submitter?.submissions_count).toBe(3);
  expect(submitter?.trust_tier).toBe("anonymous");

  // Extraction pipeline would flip pending → pending_review; simulate that.
  await db().update(submissions).set({ status: "pending_review" }).where(inArray(submissions.id, ids));

  const { cookie } = await forgeSession("admin");
  const approve = await SELF.fetch(`https://x/api/admin/submissions/${ids[0]}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      venue: { name: "Counts Resto", type: "restaurant", area: "Tutong" },
      items: [{ name: "Dish", price_bnd: 2, item_type: "dish" }],
    }),
  });
  expect(approve.status).toBe(200);
  const reject = await SELF.fetch(`https://x/api/admin/submissions/${ids[1]}/reject`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ reason: "illegible photo" }),
  });
  expect(reject.status).toBe(200);

  const [after] = await db().select().from(submitters).where(eq(submitters.id, submitter!.id));
  expect(after?.approved_count).toBe(1);
  expect(after?.rejected_count).toBe(1);

  // The submitter's remaining pending_review row surfaces in the queue with
  // the trust tier join the sort depends on (anonymous here → sinks below
  // trusted/new submitters).
  const res = await SELF.fetch("https://x/api/admin/submissions?status=pending_review", {
    headers: { cookie },
  });
  const { submissions: list } = (await res.json()) as {
    submissions: { id: string; submitter_trust_tier: string | null }[];
  };
  const remaining = list.find((s) => s.id === ids[2]);
  expect(remaining?.submitter_trust_tier).toBe("anonymous");
  expect(list.find((s) => s.id === ids[0] || s.id === ids[1])).toBeUndefined();
});
