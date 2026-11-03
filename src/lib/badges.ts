import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { AREAS } from "../db/schema";

// Badge layer — computed, not stored (spec: "a badge registry in code
// defines each badge's condition as a query over existing tables").
// `user_badges` rows exist only for manual/honorary awards an admin grants
// (e.g. community_star); everything else is evaluated at read time, so a
// badge can never drift from the activity it measures.

export interface BadgeResult {
  earned: boolean;
  progress: number;
  target: number;
}

// Everything a badge check needs, gathered once per request by
// collectStatsMany in a fixed handful of aggregate queries (bounded work
// per leaderboard row set — never N badges × M users queries).
export interface UserBadgeStats {
  approved: number; // submissions.status = 'approved'
  checkins: number;
  checkinAreas: number; // distinct districts checked into
  stalls: number; // distinct type='stall' venues checked into
  verifications: number;
  missions: number; // venue_requests fulfilled by this user's submissions
  pioneerAreas: string[]; // districts where this user holds the earliest event
  role: string | null;
  createdAt: string | null; // better-auth "user"."createdAt" (ISO string)
  manualKeys: string[]; // user_badges rows
}

export interface BadgeDef {
  key: string;
  name: string;
  description: string;
  tier: number;
  // Honorary badges are grant-only — their check always reports unearned;
  // getBadges merges user_badges rows on top.
  manual?: boolean;
  // The badge condition over collected stats — the single source of truth
  // both `evaluate` and the batch top-badge path use.
  check(stats: UserBadgeStats): BadgeResult;
  evaluate(db: Db, userId: string): Promise<BadgeResult>;
}

const EMPTY_STATS: UserBadgeStats = {
  approved: 0,
  checkins: 0,
  checkinAreas: 0,
  stalls: 0,
  verifications: 0,
  missions: 0,
  pioneerAreas: [],
  role: null,
  createdAt: null,
  manualKeys: [],
};

function def(d: Omit<BadgeDef, "evaluate">): BadgeDef {
  return {
    ...d,
    async evaluate(db, userId) {
      const stats = (await collectStatsMany(db, [userId])).get(userId) ?? EMPTY_STATS;
      return d.check(stats);
    },
  };
}

const atLeast =
  (get: (s: UserBadgeStats) => number, target: number) =>
  (s: UserBadgeStats): BadgeResult => {
    const n = get(s);
    return { earned: n >= target, progress: n, target };
  };

const binary = (earned: (s: UserBadgeStats) => boolean) =>
  (s: UserBadgeStats): BadgeResult => {
    const e = earned(s);
    return { earned: e, progress: e ? 1 : 0, target: 1 };
  };

// "Brunei-Muara" → "brunei_muara" for pioneer_<district> keys.
const areaSlug = (a: string) =>
  a
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

// Accounts created before the launch-window cutoff count as founding
// members — a fixed date, so the badge stays permanent once earned.
const FOUNDING_CUTOFF = "2027-01-01T00:00:00.000Z";

// Earliest approved-submission or check-in event per district — exactly
// one holder each, permanently (ties broken by earliest created_at, then
// user_id for determinism). Submissions reach a district through the
// publish audit join venue_revisions → venues.area; check-ins through
// venues.area directly. Better-auth "user" stays untracked by drizzle, so
// these fragments are raw SQL like the leaderboard queries.
const PIONEER_EVENTS = sql`
  SELECT v.area AS area, s.user_id AS user_id, s.created_at AS ts
  FROM submissions s
  JOIN venue_revisions r ON r.submission_id = s.id
  JOIN venues v ON v.id = r.venue_id
  WHERE s.status = 'approved' AND s.user_id IS NOT NULL
  UNION ALL
  SELECT v.area AS area, c.user_id AS user_id, c.created_at AS ts
  FROM check_ins c
  JOIN venues v ON v.id = c.venue_id
`;
const PIONEER_HOLDERS = sql`
  SELECT area, user_id FROM (
    SELECT area, user_id,
      ROW_NUMBER() OVER (PARTITION BY area ORDER BY ts ASC, user_id ASC) AS rn
    FROM (${PIONEER_EVENTS})
  ) WHERE rn = 1
`;

// Tiers order the "highest-tier" top_badge on leaderboard rows: 1 is
// account-level recognition every early account holds, 6 is the honorary
// community_star. Within a tier, registry order wins.
const BADGE_LIST: BadgeDef[] = [
  // Contributions — approved submissions only (volume without reviewer
  // acceptance doesn't count, same rule as the contributions board).
  def({ key: "first_dish", name: "First Dish", description: "Had your first submission approved", tier: 2, check: atLeast((s) => s.approved, 1) }),
  def({ key: "contributor_10", name: "Contributor", description: "10 approved submissions", tier: 3, check: atLeast((s) => s.approved, 10) }),
  def({ key: "contributor_50", name: "Trusted Contributor", description: "50 approved submissions", tier: 4, check: atLeast((s) => s.approved, 50) }),
  def({ key: "contributor_100", name: "Century Contributor", description: "100 approved submissions", tier: 5, check: atLeast((s) => s.approved, 100) }),

  // Coverage — one holder per district, forever.
  ...AREAS.map((area) =>
    def({
      key: `pioneer_${areaSlug(area)}`,
      name: `Peneroka ${area}`,
      description: `Earliest approved submission or check-in in ${area} — the district's first mapper`,
      tier: 4,
      check: binary((s) => s.pioneerAreas.includes(area)),
    }),
  ),
  def({ key: "trailblazer", name: "Trailblazer", description: "Fulfilled your first venue mission", tier: 3, check: atLeast((s) => s.missions, 1) }),
  def({ key: "cartographer", name: "Cartographer", description: "Fulfilled 5 venue missions", tier: 5, check: atLeast((s) => s.missions, 5) }),

  // Check-ins.
  def({ key: "first_checkin", name: "First Check-in", description: "Checked in at a venue", tier: 2, check: atLeast((s) => s.checkins, 1) }),
  def({ key: "regular_10", name: "Regular", description: "10 check-ins", tier: 3, check: atLeast((s) => s.checkins, 10) }),
  def({ key: "regular_50", name: "Familiar Face", description: "50 check-ins", tier: 4, check: atLeast((s) => s.checkins, 50) }),
  def({ key: "regular_100", name: "Local Legend", description: "100 check-ins", tier: 5, check: atLeast((s) => s.checkins, 100) }),
  def({ key: "brunei_explorer", name: "Brunei Explorer", description: "Checked in across all four districts", tier: 4, check: atLeast((s) => s.checkinAreas, AREAS.length) }),
  def({ key: "hawker_hero", name: "Hawker Hero", description: "Checked in at 20 different stalls", tier: 5, check: atLeast((s) => s.stalls, 20) }),

  // Verifications.
  def({ key: "fact_checker", name: "Fact Checker", description: "25 freshness votes cast", tier: 4, check: atLeast((s) => s.verifications, 25) }),

  // Special — account attributes and honorary grants.
  def({
    key: "founding",
    name: "Founding Member",
    description: "Joined during the launch window",
    tier: 1,
    check: binary((s) => s.createdAt !== null && s.createdAt < FOUNDING_CUTOFF),
  }),
  def({
    key: "reviewer",
    name: "Reviewer",
    description: "Serves on the review team",
    tier: 1,
    check: binary((s) => (s.role ?? "").split(",").some((r) => r === "reviewer" || r === "admin")),
  }),
  def({
    key: "community_star",
    name: "Community Star",
    description: "Awarded by the team for standout contribution",
    tier: 6,
    manual: true,
    check: () => ({ earned: false, progress: 0, target: 1 }),
  }),
];

export const BADGES: Record<string, BadgeDef> = Object.fromEntries(BADGE_LIST.map((b) => [b.key, b]));

// Batched stat collection: the same metrics collectStats produces for one
// user, gathered for a whole set in a fixed seven queries — leaderboard
// rows need top_badge for up to 50 opted-in users without 50× badge
// evaluations. ids land in one IN (...) list; the board cap keeps us far
// under D1's 100 bound-param limit.
export async function collectStatsMany(db: Db, userIds: string[]): Promise<Map<string, UserBadgeStats>> {
  const stats = new Map<string, UserBadgeStats>();
  for (const id of userIds) stats.set(id, { ...EMPTY_STATS, pioneerAreas: [], manualKeys: [] });
  if (userIds.length === 0) return stats;
  const idList = sql.join(
    userIds.map((i) => sql`${i}`),
    sql`, `,
  );

  const [approvedRows, activityRows, verifyRows, missionRows, userRows, manualRows, pioneerRows] =
    await Promise.all([
      db.all(sql`
        SELECT user_id AS user_id, count(*) AS n FROM submissions
        WHERE status = 'approved' AND user_id IN (${idList}) GROUP BY user_id
      `) as Promise<{ user_id: string; n: number }[]>,
      db.all(sql`
        SELECT c.user_id AS user_id, count(*) AS n,
          count(DISTINCT v.area) AS areas,
          count(DISTINCT CASE WHEN v.type = 'stall' THEN c.venue_id END) AS stalls
        FROM check_ins c JOIN venues v ON v.id = c.venue_id
        WHERE c.user_id IN (${idList}) GROUP BY c.user_id
      `) as Promise<{ user_id: string; n: number; areas: number; stalls: number }[]>,
      db.all(sql`
        SELECT user_id AS user_id, count(*) AS n FROM verifications
        WHERE user_id IN (${idList}) GROUP BY user_id
      `) as Promise<{ user_id: string; n: number }[]>,
      db.all(sql`
        SELECT s.user_id AS user_id, count(*) AS n
        FROM venue_requests r JOIN submissions s ON s.id = r.fulfilled_submission_id
        WHERE r.status = 'fulfilled' AND s.user_id IN (${idList}) GROUP BY s.user_id
      `) as Promise<{ user_id: string; n: number }[]>,
      db.all(sql`
        SELECT id, role, "createdAt" AS created_at FROM "user" WHERE id IN (${idList})
      `) as Promise<{ id: string; role: string | null; created_at: string | null }[]>,
      db.all(sql`
        SELECT user_id, badge_key FROM user_badges WHERE user_id IN (${idList})
      `) as Promise<{ user_id: string; badge_key: string }[]>,
      db.all(sql`
        SELECT area, user_id FROM (${PIONEER_HOLDERS}) WHERE user_id IN (${idList})
      `) as Promise<{ area: string; user_id: string }[]>,
    ]);

  for (const r of approvedRows) stats.get(r.user_id)!.approved = Number(r.n);
  for (const r of activityRows) {
    const s = stats.get(r.user_id)!;
    s.checkins = Number(r.n);
    s.checkinAreas = Number(r.areas);
    s.stalls = Number(r.stalls);
  }
  for (const r of verifyRows) stats.get(r.user_id)!.verifications = Number(r.n);
  for (const r of missionRows) stats.get(r.user_id)!.missions = Number(r.n);
  for (const r of userRows) {
    const s = stats.get(r.id);
    if (s) {
      s.role = r.role;
      s.createdAt = r.created_at;
    }
  }
  for (const r of manualRows) stats.get(r.user_id)?.manualKeys.push(r.badge_key);
  for (const r of pioneerRows) stats.get(r.user_id)?.pioneerAreas.push(r.area);
  return stats;
}

export interface Badge extends BadgeResult {
  key: string;
  name: string;
  description: string;
  tier: number;
  manual: boolean;
}

// Full badge list for one user: every registry badge evaluated, with
// manual awards merged on top (a granted badge is ground truth — it also
// fills progress to target).
export async function getBadges(db: Db, userId: string): Promise<Badge[]> {
  const stats = (await collectStatsMany(db, [userId])).get(userId) ?? EMPTY_STATS;
  const manual = new Set(stats.manualKeys);
  const out: Badge[] = BADGE_LIST.map((d) => {
    const r = d.check(stats);
    const granted = manual.has(d.key);
    return {
      key: d.key,
      name: d.name,
      description: d.description,
      tier: d.tier,
      manual: d.manual === true,
      earned: r.earned || granted,
      progress: granted ? Math.max(r.progress, r.target) : r.progress,
      target: r.target,
    };
  });
  // Awards whose key left the registry still surface — manual rows are
  // append-only history.
  for (const key of stats.manualKeys) {
    if (!BADGES[key]) {
      out.push({ key, name: key, description: "", tier: 0, manual: true, earned: true, progress: 1, target: 1 });
    }
  }
  return out;
}

// Each user's highest-tier earned badge key, for leaderboard rows. Manual
// awards count toward the top; registry order breaks tier ties.
export async function getTopBadges(db: Db, userIds: string[]): Promise<Map<string, string>> {
  const statsMap = await collectStatsMany(db, userIds);
  const top = new Map<string, string>();
  for (const [userId, stats] of statsMap) {
    const manual = new Set(stats.manualKeys);
    let best: BadgeDef | null = null;
    for (const d of BADGE_LIST) {
      if (!manual.has(d.key) && !d.check(stats).earned) continue;
      if (best === null || d.tier > best.tier) best = d;
    }
    if (best) top.set(userId, best.key);
  }
  return top;
}
