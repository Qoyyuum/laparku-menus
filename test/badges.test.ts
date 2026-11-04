import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import {
  AREAS,
  check_ins,
  submissions,
  venue_revisions,
  venues,
  VENUE_TYPES,
  type Submission,
} from "../src/db/schema";
import { forgeSession } from "./helpers/auth";

const db = () => getDb(env);

// --- fixtures ---------------------------------------------------------------

interface BadgeRow {
  key: string;
  name: string;
  earned: boolean;
  progress: number;
  target: number;
}
interface BadgesResponse {
  badges: BadgeRow[];
}
interface BoardRow {
  rank: number;
  name: string;
  count: number;
  top_badge?: string | null;
}

async function seedVenue(
  area: (typeof AREAS)[number] = "Brunei-Muara",
  type: (typeof VENUE_TYPES)[number] = "restaurant",
) {
  const [v] = await db()
    .insert(venues)
    .values({ name: `BDG-${crypto.randomUUID().slice(0, 8)}`, type, area })
    .returning();
  return v!;
}

async function seedSubmission(
  userId: string | null,
  status: Submission["status"] = "approved",
  createdAt?: Date,
) {
  const [s] = await db()
    .insert(submissions)
    .values({
      user_id: userId,
      source_type: "manual_entry",
      provenance: "test",
      status,
      ...(createdAt ? { created_at: createdAt } : {}),
    })
    .returning();
  return s!;
}

// Approved submissions reach a venue through venue_revisions, the publish
// audit row — the pioneer_<district> badges read district off that join.
async function linkRevision(submissionId: string, venueId: string) {
  await db()
    .insert(venue_revisions)
    .values({ venue_id: venueId, submission_id: submissionId, reviewer_id: "test-reviewer", mode: "replace" });
}

async function seedCheckin(userId: string, venueId: string, createdAt?: Date) {
  await db()
    .insert(check_ins)
    .values({ venue_id: venueId, user_id: userId, ...(createdAt ? { created_at: createdAt } : {}) });
}

// Same raw-column convention as leaderboards.test.ts — the better-auth
// `user` table is untracked by drizzle.
async function setPrefs(
  userId: string,
  prefs: { public_name?: string | null; show_on_leaderboard?: boolean },
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
  if (prefs.show_on_leaderboard !== undefined) {
    await env.DB.prepare(`UPDATE "user" SET show_on_leaderboard = ? WHERE id = ?`)
      .bind(prefs.show_on_leaderboard ? 1 : 0, userId)
      .run();
  }
}

async function myBadges(cookie: string) {
  const res = await SELF.fetch("https://x/api/me/badges", { headers: { cookie } });
  return { res, body: (await res.json().catch(() => ({}))) as BadgesResponse };
}

async function publicBadges(userId: string, cookie?: string) {
  const res = await SELF.fetch(`https://x/api/users/${userId}/badges`, {
    headers: cookie ? { cookie } : {},
  });
  return { res, body: (await res.json().catch(() => ({}))) as BadgesResponse };
}

async function award(userId: string, body: unknown, cookie?: string) {
  const res = await SELF.fetch(`https://x/api/admin/users/${userId}/badges`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { res, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

function badgeMap(r: { body: BadgesResponse }) {
  return Object.fromEntries(r.body.badges.map((b) => [b.key, b])) as Record<string, BadgeRow>;
}

// --- (a) contribution badges + progress --------------------------------------

it("one approved submission earns first_dish and drives contributor_* progress", async () => {
  const u = await forgeSession("submitter");
  await seedSubmission(u.userId, "approved");
  // Pending/rejected rows never count toward contribution badges.
  await seedSubmission(u.userId, "pending_review");
  await seedSubmission(u.userId, "rejected");

  const { res, body } = await myBadges(u.cookie);
  expect(res.status).toBe(200);
  expect(body.badges.length).toBeGreaterThan(0);
  const m = badgeMap({ body });
  expect(m["first_dish"]).toMatchObject({ earned: true, progress: 1, target: 1 });
  expect(m["contributor_10"]).toMatchObject({ earned: false, progress: 1, target: 10 });
  expect(m["contributor_50"]).toMatchObject({ earned: false, progress: 1, target: 50 });
  expect(m["contributor_100"]).toMatchObject({ earned: false, progress: 1, target: 100 });
  // Unrelated metrics stay at zero.
  expect(m["first_checkin"]).toMatchObject({ earned: false, progress: 0, target: 1 });
});

// --- (b) Review Focus #7 — pioneer_<district> has exactly one holder ---------

it("pioneer_belait belongs to the earliest Belait event; the second arrival never earns it", async () => {
  const venue = await seedVenue("Belait");
  const early = await forgeSession("submitter");
  const late = await forgeSession("submitter");
  // Explicit timestamps put both events safely before every other fixture
  // in this file — the shared test D1 makes "earliest" global.
  const s1 = await seedSubmission(early.userId, "approved", new Date("2020-01-01T00:00:00Z"));
  const s2 = await seedSubmission(late.userId, "approved", new Date("2020-06-01T00:00:00Z"));
  await linkRevision(s1.id, venue.id);
  await linkRevision(s2.id, venue.id);

  const earlyBadges = badgeMap(await myBadges(early.cookie));
  expect(earlyBadges["pioneer_belait"]).toMatchObject({ earned: true });
  const lateBadges = badgeMap(await myBadges(late.cookie));
  expect(lateBadges["pioneer_belait"]).toMatchObject({ earned: false });
  // The late arrival keeps their own contribution badges — only pioneer is locked.
  expect(lateBadges["first_dish"]).toMatchObject({ earned: true });

  // Through the public endpoint the same holds for opted-in users.
  await setPrefs(early.userId, { public_name: "Early", show_on_leaderboard: true });
  await setPrefs(late.userId, { public_name: "Late", show_on_leaderboard: true });
  const pubEarly = await publicBadges(early.userId);
  expect(pubEarly.res.status).toBe(200);
  expect(pubEarly.body.badges.map((b) => b.key)).toContain("pioneer_belait");
  const pubLate = await publicBadges(late.userId);
  expect(pubLate.res.status).toBe(200);
  expect(pubLate.body.badges.map((b) => b.key)).not.toContain("pioneer_belait");
});

// --- (c) brunei_explorer ------------------------------------------------------

it("check-ins across all four districts earn brunei_explorer", async () => {
  const u = await forgeSession("submitter");
  for (const area of AREAS) {
    const v = await seedVenue(area);
    await seedCheckin(u.userId, v.id);
  }
  const m = badgeMap(await myBadges(u.cookie));
  expect(m["brunei_explorer"]).toMatchObject({ earned: true, progress: 4, target: 4 });
  expect(m["first_checkin"]).toMatchObject({ earned: true, progress: 4, target: 1 });
  expect(m["regular_10"]).toMatchObject({ earned: false, progress: 4, target: 10 });
});

// --- (d) opt-out privacy -------------------------------------------------------

it("opt-out user's public badge endpoint is 404; their own /api/me/badges still works", async () => {
  expect((await SELF.fetch("https://x/api/me/badges")).status).toBe(401);

  const u = await forgeSession("submitter");
  await seedSubmission(u.userId, "approved");

  // show_on_leaderboard defaults to false — the public endpoint must not
  // leak even the existence of badge activity.
  const denied = await publicBadges(u.userId);
  expect(denied.res.status).toBe(404);

  // Their own view is unaffected by the opt-out.
  const own = await myBadges(u.cookie);
  expect(own.res.status).toBe(200);
  expect(own.body.badges.length).toBeGreaterThan(0);

  // Unknown user ids are indistinguishable from opted-out users.
  expect((await publicBadges("no-such-user")).res.status).toBe(404);

  // Opt in → earned badges only, no progress on unearned ones. A display
  // name is set too so this user's board row isn't anonymous — keeps the
  // "Anonymous ⇒ no badge" assertion in the leaderboard test below clean.
  await setPrefs(u.userId, { public_name: "BadgeOptedIn", show_on_leaderboard: true });
  const pub = await publicBadges(u.userId);
  expect(pub.res.status).toBe(200);
  expect(pub.body.badges.length).toBeGreaterThan(0);
  expect(pub.body.badges.every((b) => b.earned)).toBe(true);
  const keys = pub.body.badges.map((b) => b.key);
  expect(keys).toContain("first_dish");
  expect(keys).not.toContain("contributor_10");
});

// --- (e) admin honorary awards -------------------------------------------------

it("admins award honorary badges; non-admins 403; unknown keys and duplicates rejected", async () => {
  const admin = await forgeSession("admin");
  const reviewer = await forgeSession("reviewer");
  const target = await forgeSession("submitter");

  expect((await award(target.userId, { badge_key: "community_star" })).res.status).toBe(401);
  expect((await award(target.userId, { badge_key: "community_star" }, target.cookie)).res.status).toBe(403);
  // Reviewers pass the /api/admin guard but are not admins — still 403.
  expect((await award(target.userId, { badge_key: "community_star" }, reviewer.cookie)).res.status).toBe(403);

  expect((await award("no-such-user", { badge_key: "community_star" }, admin.cookie)).res.status).toBe(404);
  expect((await award(target.userId, { badge_key: "nonsense" }, admin.cookie)).res.status).toBe(400);

  const ok = await award(target.userId, { badge_key: "community_star" }, admin.cookie);
  expect(ok.res.status).toBe(201);

  // The manual award merges into the badge list as earned.
  const m = badgeMap(await myBadges(target.cookie));
  expect(m["community_star"]).toMatchObject({ earned: true });

  // Already held → 409, not a second row.
  expect((await award(target.userId, { badge_key: "community_star" }, admin.cookie)).res.status).toBe(409);
});

// --- (f) leaderboard top_badge ---------------------------------------------------

it("leaderboard rows carry each opted-in user's highest-tier badge key", async () => {
  const u = await forgeSession("submitter");
  const shy = await forgeSession("submitter");
  await setPrefs(u.userId, { public_name: "BadgeHolder", show_on_leaderboard: true });
  await seedSubmission(u.userId, "approved");
  await seedSubmission(u.userId, "approved");
  // Opted-out contributor: their row must not leak a badge.
  await seedSubmission(shy.userId, "approved");

  const res = await SELF.fetch("https://x/api/leaderboards?kind=contributions&period=all");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { board: BoardRow[] };
  const badged = body.board.find((r) => r.name === "BadgeHolder");
  expect(badged).toBeDefined();
  // first_dish outranks founding (role/account tier) in the tier order.
  expect(badged!.top_badge).toBe("first_dish");

  const anonRows = body.board.filter((r) => r.name === "Anonymous");
  expect(anonRows.length).toBeGreaterThan(0);
  expect(anonRows.every((r) => r.top_badge == null)).toBe(true);
});
