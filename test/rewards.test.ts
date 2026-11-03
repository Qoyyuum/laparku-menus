import { env, SELF } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { getDb, type Db } from "../src/db/client";
import { check_ins, food_items, submissions, venues, verifications, type Submission } from "../src/db/schema";
import { publishSubmission } from "../src/lib/publish";
import { forgeSession } from "./helpers/auth";

const db = () => getDb(env);

// --- fixtures ---------------------------------------------------------------

// A pending_review submission a reviewer can decide (same shape as
// admin.test.ts's seeder — the approve body carries the items, so the
// raw_extraction draft content doesn't matter for these tests).
async function seedSubmission(userId: string | null, status: Submission["status"] = "pending_review") {
  const [row] = await db()
    .insert(submissions)
    .values({
      user_id: userId,
      source_type: "menu_photo",
      provenance: "photo of the physical menu",
      status,
      raw_extraction: {
        has_food_content: true,
        confidence: 0.9,
        venue_guess: { name: "Kedai Test", type: "restaurant" },
        items: [{ name: "Nasi Lemak", price_bnd: 2.5, item_type: "dish" }],
        suspicion: [],
      },
    })
    .returning();
  return row!;
}

async function seedVenue(name = `RW-${crypto.randomUUID().slice(0, 8)}`) {
  const [v] = await db()
    .insert(venues)
    .values({ name, type: "restaurant", area: "Brunei-Muara" })
    .returning();
  return v!;
}

// Same raw-column convention as leaderboards.test.ts's setPrefs — the
// better-auth `user` table is untracked by drizzle.
async function setPrefs(
  userId: string,
  prefs: { display_name?: string | null; show_on_leaderboard?: boolean; show_credit?: boolean },
) {
  if (prefs.display_name !== undefined) {
    await env.DB.prepare(`UPDATE "user" SET display_name = ? WHERE id = ?`)
      .bind(prefs.display_name, userId)
      .run();
  }
  if (prefs.show_on_leaderboard !== undefined) {
    await env.DB.prepare(`UPDATE "user" SET show_on_leaderboard = ? WHERE id = ?`)
      .bind(prefs.show_on_leaderboard ? 1 : 0, userId)
      .run();
  }
  if (prefs.show_credit !== undefined) {
    await env.DB.prepare(`UPDATE "user" SET show_credit = ? WHERE id = ?`)
      .bind(prefs.show_credit ? 1 : 0, userId)
      .run();
  }
}

async function approve(id: string, cookie: string, body: unknown) {
  return SELF.fetch(`https://x/api/admin/submissions/${id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function reject(id: string, cookie: string, body: unknown) {
  return SELF.fetch(`https://x/api/admin/submissions/${id}/reject`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

// Wraps the real drizzle db so `insert(food_items)` throws — the publish
// rolls back (same trick as admin.test.ts).
function failingInsertDb(): Db {
  const real = db();
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "insert") {
        return (table: unknown) => {
          if (table === food_items) throw new Error("simulated D1 failure");
          return (target.insert as (t: unknown) => unknown).call(target, table);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Db;
}

interface SentMail {
  to: string;
  subject: string;
  html: string;
}

// Stub Resend's outbound POST; returns the recorded send bodies.
function stubResend() {
  const sends: SentMail[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      sends.push(JSON.parse(String(init?.body)) as SentMail);
      return new Response("{}", { status: 200 });
    }),
  );
  const prevKey = env.RESEND_API_KEY;
  env.RESEND_API_KEY = "test-resend-key";
  return {
    sends,
    restore() {
      env.RESEND_API_KEY = prevKey || "";
      vi.unstubAllGlobals();
    },
  };
}

// --- (a)+(e) publish notification --------------------------------------------

it("approve emails the submitter via Resend; reject and rolled-back publishes do not", async () => {
  const stub = stubResend();
  try {
    const submitter = await forgeSession("submitter");
    const reviewer = await forgeSession("reviewer");

    const sub = await seedSubmission(submitter.userId);
    const res = await approve(sub.id, reviewer.cookie, {
      venue: { name: "Notify Resto", type: "restaurant", area: "Tutong" },
      items: [{ name: "Nasi Lemak", price_bnd: 2.5, item_type: "dish" }],
    });
    expect(res.status).toBe(200);
    expect(stub.sends).toHaveLength(1);
    expect(stub.sends[0]!.to).toBe(`${submitter.userId}@test.dev`);
    expect(stub.sends[0]!.html).toContain("Notify Resto");

    // Reject never notifies.
    const rejected = await seedSubmission(submitter.userId);
    const rejRes = await reject(rejected.id, reviewer.cookie, { reason: "duplicate" });
    expect(rejRes.status).toBe(200);
    expect(stub.sends).toHaveLength(1);

    // A publish that fails mid-flight rolls back — no "your menu is live"
    // email may leave for a menu that isn't live.
    const doomed = await seedSubmission(submitter.userId);
    await expect(
      publishSubmission(failingInsertDb(), doomed.id, "test-reviewer", {
        venue: { name: "Rolled Back", type: "stall", area: "Belait" },
        items: [{ name: "X", item_type: "dish" }],
      }, env),
    ).rejects.toThrow("simulated D1 failure");
    expect(stub.sends).toHaveLength(1);

    // Grandfathered anonymous submissions (no user_id) have nobody to email.
    const anon = await seedSubmission(null);
    const anonRes = await approve(anon.id, reviewer.cookie, {
      venue: { name: "Anon Venue", type: "stall", area: "Temburong" },
      items: [{ name: "Y", item_type: "dish" }],
    });
    expect(anonRes.status).toBe(200);
    expect(stub.sends).toHaveLength(1);
  } finally {
    stub.restore();
  }
});

it("approve still succeeds with no RESEND_API_KEY configured (email skipped)", async () => {
  const prevKey = env.RESEND_API_KEY;
  env.RESEND_API_KEY = "";
  try {
    const submitter = await forgeSession("submitter");
    const reviewer = await forgeSession("reviewer");
    const sub = await seedSubmission(submitter.userId);
    const res = await approve(sub.id, reviewer.cookie, {
      venue: { name: "No Mailer", type: "grocer", area: "Belait" },
      items: [{ name: "Z", item_type: "dish" }],
    });
    expect(res.status).toBe(200);
  } finally {
    env.RESEND_API_KEY = prevKey || "";
  }
});

// --- (b) contributed_by -------------------------------------------------------

it("items carry contributed_by only when the source submitter opted into credit", async () => {
  const credited = await forgeSession("submitter");
  const shy = await forgeSession("submitter");
  const noName = await forgeSession("submitter");
  await setPrefs(credited.userId, { display_name: "MenuHunter", show_credit: true });
  await setPrefs(shy.userId, { display_name: "SecretCreditName", show_credit: false });
  // Opted in but never set a name — there is nothing safe to render.
  await setPrefs(noName.userId, { display_name: null, show_credit: true });

  const venue = await seedVenue("Credit Venue");
  const subA = await seedSubmission(credited.userId, "approved");
  const subB = await seedSubmission(shy.userId, "approved");
  const subC = await seedSubmission(noName.userId, "approved");
  const subAnon = await seedSubmission(null, "approved");
  await db()
    .insert(food_items)
    .values([
      { venue_id: venue.id, item_type: "dish", name: "Credited Dish", source_submission_id: subA.id },
      { venue_id: venue.id, item_type: "dish", name: "Shy Dish", source_submission_id: subB.id },
      { venue_id: venue.id, item_type: "dish", name: "NoName Dish", source_submission_id: subC.id },
      { venue_id: venue.id, item_type: "dish", name: "Anon Dish", source_submission_id: subAnon.id },
      { venue_id: venue.id, item_type: "dish", name: "NoSource Dish" },
    ]);

  const res = await SELF.fetch(`https://x/api/venues/${venue.id}/items`);
  expect(res.status).toBe(200);
  const { items } = (await res.json()) as { items: ({ name: string } & Record<string, unknown>)[] };
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));

  expect(byName["Credited Dish"]?.contributed_by).toBe("MenuHunter");
  // Opt-out, opted-in-but-nameless, anonymous-submitter and source-less
  // items all carry no credit — and the opted-out name must never leak.
  for (const n of ["Shy Dish", "NoName Dish", "Anon Dish", "NoSource Dish"]) {
    expect(byName[n]?.contributed_by).toBeUndefined();
  }
  expect(JSON.stringify(items)).not.toContain("SecretCreditName");

  // Search results carry the same credit.
  const search = await SELF.fetch("https://x/api/search?q=Credited%20Dish");
  const { items: found } = (await search.json()) as { items: { name: string; contributed_by?: string }[] };
  expect(found.find((i) => i.name === "Credited Dish")?.contributed_by).toBe("MenuHunter");
});

// --- (c) /api/stats -------------------------------------------------------------

it("GET /api/stats returns public totals (baseline-relative — the test D1 is shared)", async () => {
  interface Stats {
    venues: number;
    items: number;
    contributors: number;
    checkins: number;
  }
  const get = async () => (await (await SELF.fetch("https://x/api/stats")).json()) as Stats;
  const base = await get();

  const u = await forgeSession("submitter");
  const v1 = await seedVenue("Stats A");
  const v2 = await seedVenue("Stats B");
  // Draft venues don't count toward the public total.
  await db()
    .insert(venues)
    .values({ name: "Stats Draft", type: "restaurant", area: "Tutong", status: "draft" });
  const sub = await seedSubmission(u.userId, "approved");
  // Rejected/pending-only submitters are not "contributors" — same live-
  // content meaning as the contributions leaderboard.
  const unlucky = await forgeSession("submitter");
  await seedSubmission(unlucky.userId, "rejected");
  await seedSubmission(unlucky.userId, "pending_review");
  await db()
    .insert(food_items)
    .values([
      { venue_id: v1.id, item_type: "dish", name: "Stats Dish 1", source_submission_id: sub.id },
      { venue_id: v1.id, item_type: "dish", name: "Stats Dish 2", source_submission_id: sub.id },
      { venue_id: v2.id, item_type: "dish", name: "Stats Dish 3" },
      // Superseded rows are history, not menu size.
      {
        venue_id: v2.id,
        item_type: "dish",
        name: "Stats Old",
        status: "superseded",
        is_current: false,
        superseded_by: sub.id,
      },
    ]);
  await db()
    .insert(check_ins)
    .values([
      { venue_id: v1.id, user_id: u.userId },
      { venue_id: v2.id, user_id: u.userId },
    ]);

  const after = await get();
  expect(after.venues).toBe(base.venues + 2);
  expect(after.items).toBe(base.items + 3);
  // `u` (approved submission) is the only new contributor; `unlucky`'s
  // rejected/pending rows must not count.
  expect(after.contributors).toBe(base.contributors + 1);
  expect(after.checkins).toBe(base.checkins + 2);
});

// --- (d) /api/me ---------------------------------------------------------------

it("GET /api/me returns the caller's counts and opt-in prefs; 401 when anonymous", async () => {
  expect((await SELF.fetch("https://x/api/me")).status).toBe(401);

  const u = await forgeSession("submitter");
  const other = await forgeSession("submitter");
  const v = await seedVenue("Me Venue");
  await seedSubmission(u.userId, "approved");
  await seedSubmission(u.userId, "pending_review");
  await seedSubmission(u.userId, "rejected");
  // Someone else's rows must not inflate the caller's counts.
  await seedSubmission(other.userId, "approved");
  await db().insert(check_ins).values({ venue_id: v.id, user_id: u.userId });
  await db().insert(check_ins).values({ venue_id: v.id, user_id: other.userId });
  await db().insert(verifications).values({ venue_id: v.id, user_id: u.userId, accurate: true });

  const res = await SELF.fetch("https://x/api/me", { headers: { cookie: u.cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toMatchObject({
    display_name: null,
    show_on_leaderboard: false,
    show_credit: false,
    submissions: 3,
    approved: 1,
    checkins: 1,
    verifications: 1,
  });

  // The endpoint also reports the current opt-in prefs (Task 5's PATCH
  // surface) so the app can prefill the toggles.
  await setPrefs(u.userId, { display_name: "Me User", show_credit: true });
  const res2 = await SELF.fetch("https://x/api/me", { headers: { cookie: u.cookie } });
  const body2 = (await res2.json()) as Record<string, unknown>;
  expect(body2.display_name).toBe("Me User");
  expect(body2.show_credit).toBe(true);
});
