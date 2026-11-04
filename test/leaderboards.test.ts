import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { AREAS, check_ins, submissions, venue_revisions, venues, verifications, VENUE_TYPES, type Submission } from "../src/db/schema";
import { forgeSession } from "./helpers/auth";

const db = () => getDb(env);
const DAY_MS = 24 * 60 * 60 * 1000;

// --- fixtures ---------------------------------------------------------------

interface BoardRow {
  rank: number;
  name: string;
  count: number;
}
interface BoardResponse {
  board: BoardRow[];
  me: { rank: number; count: number } | null;
  area?: string | null;
}

async function seedVenue(
  area: (typeof AREAS)[number] = "Brunei-Muara",
  type: (typeof VENUE_TYPES)[number] = "restaurant",
) {
  const [v] = await db()
    .insert(venues)
    .values({ name: `LB-${crypto.randomUUID().slice(0, 8)}`, type, area })
    .returning();
  return v!;
}

async function seedCheckins(userId: string, venueIds: string[], createdAt = new Date()) {
  for (const venue_id of venueIds) {
    await db().insert(check_ins).values({ venue_id, user_id: userId, created_at: createdAt });
  }
}

async function seedSubmission(userId: string | null, status: Submission["status"]) {
  const [s] = await db()
    .insert(submissions)
    .values({ user_id: userId, source_type: "manual_entry", provenance: "test", status })
    .returning();
  return s!;
}

// Direct write of the phase-2 opt-in columns on the better-auth `user` table
// (untracked by drizzle — same convention as forgeSession's raw inserts).
async function setPrefs(
  userId: string,
  prefs: {
    display_name?: string | null;
    show_on_leaderboard?: boolean;
    show_credit?: boolean;
    // What the board renders now: a Gravatar-verified handle via
    // preferred_social + the gravatar_accounts snapshot (same shape
    // refreshGravatarAccounts writes). null clears both.
    public_name?: string | null;
  },
) {
  if (prefs.public_name !== undefined) {
    const accounts = prefs.public_name
      ? JSON.stringify([
          {
            platform: "instagram",
            label: "Instagram",
            handle: prefs.public_name,
            url: `https://instagram.com/${prefs.public_name}`,
          },
        ])
      : null;
    await env.DB.prepare(`UPDATE "user" SET preferred_social = ?, gravatar_accounts = ? WHERE id = ?`)
      .bind(prefs.public_name ? "instagram" : null, accounts, userId)
      .run();
  }
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

async function board(query: string, cookie?: string) {
  const res = await SELF.fetch(`https://x/api/leaderboards${query}`, {
    headers: cookie ? { cookie } : {},
  });
  return { res, body: (await res.json()) as BoardResponse };
}

async function patchMe(body: unknown, cookie?: string) {
  return SELF.fetch("https://x/api/me", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

// --- (a) kind=checkins ranks correctly ---------------------------------------

it("kind=checkins ranks users by check-in count with ranks and opt-in names", async () => {
  const v1 = await seedVenue();
  const v2 = await seedVenue();
  const v3 = await seedVenue();
  const ali = await forgeSession("submitter");
  const siti = await forgeSession("submitter");
  await setPrefs(ali.userId, { public_name: "Ali", show_on_leaderboard: true });
  await setPrefs(siti.userId, { public_name: "Siti", show_on_leaderboard: true });

  await seedCheckins(ali.userId, [v1.id, v2.id, v3.id]);
  await seedCheckins(siti.userId, [v1.id]);

  const { res, body } = await board("?kind=checkins&period=all", ali.cookie);
  expect(res.status).toBe(200);
  // top_badge (Task 8): Ali's check-ins are the earliest Brunei-Muara
  // events in this file, so they hold pioneer_brunei_muara (tier 4); Siti
  // tops out at first_checkin (tier 2) over founding (tier 1).
  expect(body.board[0]).toEqual({ rank: 1, name: "Ali", count: 3, top_badge: "pioneer_brunei_muara" });
  expect(body.board[1]).toEqual({ rank: 2, name: "Siti", count: 1, top_badge: "first_checkin" });
  // The caller is inside the board — `me` still reports their rank.
  expect(body.me).toEqual({ rank: 1, count: 3 });
  // An anonymous caller gets the board but no `me`.
  const anon = await board("?kind=checkins&period=all");
  expect(anon.body.me).toBeNull();
});

// --- (b) period=week excludes last month's rows ------------------------------

it("period windows gate by created_at: week excludes last month's rows", async () => {
  // Tutong isolates this board from other tests' rows (the test D1 is shared
  // per file).
  const v1 = await seedVenue("Tutong");
  const v2 = await seedVenue("Tutong");
  const u = await forgeSession("submitter");
  await setPrefs(u.userId, { public_name: "Weekly", show_on_leaderboard: true });
  await seedCheckins(u.userId, [v1.id], new Date(Date.now() - 40 * DAY_MS)); // last month
  await seedCheckins(u.userId, [v2.id]); // today

  const week = await board("?kind=checkins&period=week&area=Tutong");
  expect(week.body.board[0]?.count).toBe(1);
  const all = await board("?kind=checkins&period=all&area=Tutong");
  expect(all.body.board[0]?.count).toBe(2);
  // Default period is month — the 40-day-old row is out of that window too.
  const def = await board("?kind=checkins&area=Tutong");
  expect(def.body.board[0]?.count).toBe(1);
});

// --- (c) area=Belait filters via the venue ------------------------------------

it("area and venue_type filter counts through the venue join", async () => {
  const belaitStall = await seedVenue("Belait", "stall");
  const muaraResto = await seedVenue("Brunei-Muara", "restaurant");
  const u = await forgeSession("submitter");
  await setPrefs(u.userId, { public_name: "Traveller", show_on_leaderboard: true });
  await seedCheckins(u.userId, [belaitStall.id, muaraResto.id]);

  const belait = await board("?kind=checkins&period=all&area=Belait");
  expect(belait.body.board[0]?.count).toBe(1);
  const stall = await board("?kind=checkins&period=all&venue_type=stall");
  expect(stall.body.board[0]?.count).toBe(1);
  const temburong = await board("?kind=checkins&period=all&area=Temburong");
  expect(temburong.body.board).toHaveLength(0);
});

// --- (d) Review Focus #5: opt-out renders "Anonymous" -------------------------

it("a freeform display_name never renders — only verified socials name a row", async () => {
  const venue = await seedVenue();
  const u = await forgeSession("submitter");
  await seedCheckins(u.userId, [venue.id]);
  // display_name set but no preferred_social: unmoderatable freeform text
  // must not reach the public board even for an opted-in user.
  await setPrefs(u.userId, { display_name: "VulgarFreeform", show_on_leaderboard: true });
  const b = await board("?kind=checkins&period=all");
  expect(b.body.board.some((r) => r.name === "VulgarFreeform")).toBe(false);
});

it("malformed gravatar_accounts JSON and absent-platform picks render Anonymous, never 500", async () => {
  const venue = await seedVenue();
  const broken = await forgeSession("submitter");
  const ghost = await forgeSession("submitter");
  await seedCheckins(broken.userId, [venue.id]);
  await seedCheckins(ghost.userId, [venue.id]);
  // Opted in, preferred_social set, snapshot corrupt.
  await env.DB.prepare(
    `UPDATE "user" SET show_on_leaderboard = 1, preferred_social = 'instagram', gravatar_accounts = 'not-json{{' WHERE id = ?`,
  )
    .bind(broken.userId)
    .run();
  // Opted in, preferred_social names a platform absent from the snapshot.
  await env.DB.prepare(
    `UPDATE "user" SET show_on_leaderboard = 1, preferred_social = 'myspace', gravatar_accounts = ? WHERE id = ?`,
  )
    .bind(
      JSON.stringify([{ platform: "instagram", label: "Instagram", handle: "realhandle", url: "https://instagram.com/realhandle" }]),
      ghost.userId,
    )
    .run();
  const { res, body } = await board("?kind=checkins&period=all");
  expect(res.status).toBe(200);
  const names = body.board.map((r) => r.name);
  expect(names).not.toContain("realhandle");
  expect(names.filter((n) => n === "Anonymous").length).toBeGreaterThanOrEqual(2);
});

it("an opt-out user ranked #1 shows \"Anonymous\"; their display_name never leaks; me keeps the real rank", async () => {
  // Temburong isolates the board from other tests' rows.
  const v1 = await seedVenue("Temburong");
  const v2 = await seedVenue("Temburong");
  const top = await forgeSession("submitter");
  const other = await forgeSession("submitter");
  // Opted OUT (default false) but with a display_name set — the sentinel must
  // not appear anywhere in the response.
  await setPrefs(top.userId, { public_name: "SecretNameXYZ", show_on_leaderboard: false });
  await setPrefs(other.userId, { public_name: "Visible", show_on_leaderboard: true });
  await seedCheckins(top.userId, [v1.id, v2.id]);
  await seedCheckins(other.userId, [v1.id]);

  const { res, body } = await board("?kind=checkins&period=all&area=Temburong", top.cookie);
  expect(res.status).toBe(200);
  expect(body.board[0]?.name).toBe("Anonymous");
  expect(body.board[1]?.name).toBe("Visible");
  expect(JSON.stringify(body)).not.toContain("SecretNameXYZ");
  expect(JSON.stringify(body)).not.toContain(top.userId);
  // Opt-out only masks the board row — the caller's own rank stays truthful.
  expect(body.me).toEqual({ rank: 1, count: 2 });
});

// --- (e) kind=contributions counts approved only ------------------------------

it("kind=contributions counts approved submissions only; area filters via the publish revision", async () => {
  const belait = await seedVenue("Belait");
  const reviewer = await forgeSession("reviewer");
  const a = await forgeSession("submitter");
  const b = await forgeSession("submitter");
  await setPrefs(a.userId, { public_name: "Chef", show_on_leaderboard: true });
  await setPrefs(b.userId, { public_name: "Foodie", show_on_leaderboard: true });

  const approvedBelait = await seedSubmission(a.userId, "approved");
  await seedSubmission(a.userId, "approved");
  await seedSubmission(a.userId, "rejected");
  await seedSubmission(a.userId, "pending_review");
  await seedSubmission(b.userId, "approved");
  // Grandfathered v1 rows have no user — they must not form a board row.
  await seedSubmission(null, "approved");

  // The publish audit row is the submission→venue link area filtering reads.
  await db()
    .insert(venue_revisions)
    .values({ venue_id: belait.id, submission_id: approvedBelait.id, reviewer_id: reviewer.userId, mode: "replace" });

  const { res, body } = await board("?kind=contributions&period=all");
  expect(res.status).toBe(200);
  expect(body.board).toHaveLength(2);
  // Both contributors top out at first_dish — the Belait pioneer badge
  // belongs to (c)'s Traveller, whose earlier check-in beats Chef's
  // submission (exactly one holder per district).
  expect(body.board[0]).toEqual({ rank: 1, name: "Chef", count: 2, top_badge: "first_dish" });
  expect(body.board[1]).toEqual({ rank: 2, name: "Foodie", count: 1, top_badge: "first_dish" });

  const belaitBoard = await board("?kind=contributions&period=all&area=Belait");
  expect(belaitBoard.body.board).toHaveLength(1);
  expect(belaitBoard.body.board[0]).toEqual({ rank: 1, name: "Chef", count: 1, top_badge: "first_dish" });
});

it("kind=verifications ranks votes", async () => {
  const v1 = await seedVenue();
  const v2 = await seedVenue();
  const u = await forgeSession("submitter");
  await setPrefs(u.userId, { public_name: "Verifier", show_on_leaderboard: true });
  await db()
    .insert(verifications)
    .values([
      { venue_id: v1.id, user_id: u.userId, accurate: true },
      { venue_id: v2.id, user_id: u.userId, accurate: false },
    ]);

  const { res, body } = await board("?kind=verifications&period=all", u.cookie);
  expect(res.status).toBe(200);
  // 2 votes is short of fact_checker's 25 — founding (tier 1) is the top.
  expect(body.board[0]).toEqual({ rank: 1, name: "Verifier", count: 2, top_badge: "founding" });
  expect(body.me).toEqual({ rank: 1, count: 2 });
});

// --- (f) PATCH /api/me updates the opt-in flags --------------------------------

it("PATCH /api/me sets prefs and flags; the board honours the opt-in gate", async () => {
  const venue = await seedVenue();
  const u = await forgeSession("submitter");
  await seedCheckins(u.userId, [venue.id]);

  // Anonymous → 401.
  expect((await patchMe({ show_on_leaderboard: true })).status).toBe(401);
  // Bad field types → 400; a patch with no recognized fields → 400
  // (display_name is no longer a recognized field — freeform names are gone).
  expect((await patchMe({ theme: "neon" }, u.cookie)).status).toBe(400);
  expect((await patchMe({ show_on_leaderboard: "yes" }, u.cookie)).status).toBe(400);
  expect((await patchMe({}, u.cookie)).status).toBe(400);
  expect((await patchMe({ display_name: "X" }, u.cookie)).status).toBe(400);

  const res = await patchMe(
    { theme: "dark", preferred_social: null, show_on_leaderboard: true, show_credit: true },
    u.cookie,
  );
  expect(res.status).toBe(200);
  const patched = (await res.json()) as {
    theme: string;
    preferred_social: string | null;
    show_on_leaderboard: boolean;
    show_credit: boolean;
  };
  expect(patched).toMatchObject({
    theme: "dark",
    preferred_social: null,
    show_on_leaderboard: true,
    show_credit: true,
  });

  // Board rows key off the name field — seed it directly (public-name
  // source changes in a later task; the opt-in gate is what this test pins).
  await setPrefs(u.userId, { public_name: "Ali B" });
  let b = await board("?kind=checkins&period=all");
  expect(b.body.board.some((r) => r.name === "Ali B" && r.count === 1)).toBe(true);

  // Opting back out re-masks the row: the name disappears entirely.
  expect((await patchMe({ show_on_leaderboard: false }, u.cookie)).status).toBe(200);
  b = await board("?kind=checkins&period=all");
  expect(b.body.board.some((r) => r.name === "Ali B")).toBe(false);
});

// --- board size + caller rank outside the top 50 -------------------------------

it("board caps at 50 and me reports the caller's rank beyond it", async () => {
  const v1 = await seedVenue();
  const v2 = await seedVenue();
  const caller = await forgeSession("submitter");
  // 51 users ahead of the caller (2 check-ins each vs the caller's 1).
  for (let i = 0; i < 51; i++) {
    const u = await forgeSession("submitter");
    await seedCheckins(u.userId, [v1.id, v2.id]);
  }
  await seedCheckins(caller.userId, [v1.id]);

  const { res, body } = await board("?kind=checkins&period=all", caller.cookie);
  expect(res.status).toBe(200);
  expect(body.board).toHaveLength(50);
  // The caller (count 1) is strictly below the cut: every board row outranks
  // them — earlier tests in this file seeded users with counts ≥2 as well,
  // so the exact rank is 1 + the number of strictly-greater users.
  expect(body.board.every((r) => r.count >= 2)).toBe(true);
  expect(body.me?.count).toBe(1);
  expect(body.me?.rank ?? 0).toBeGreaterThan(50);
});

// --- param validation ----------------------------------------------------------

it("invalid kind/period/area/venue_type are rejected with 400", async () => {
  for (const q of [
    "?kind=bogus",
    "?kind=checkins&period=year",
    "?kind=checkins&area=Nowhere",
    "?kind=checkins&venue_type=bogus",
  ]) {
    const { res } = await board(q);
    expect(res.status).toBe(400);
  }
  // Omitted params are fine: kind defaults to checkins, period to month.
  const { res } = await board("");
  expect(res.status).toBe(200);
});
