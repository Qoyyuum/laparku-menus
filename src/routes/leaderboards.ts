import { and, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { createAuth } from "../auth";
import { getDb } from "../db/client";
import { AREAS, VENUE_TYPES } from "../db/schema";
import type { Env } from "../env";
import { getTopBadges } from "../lib/badges";
import { requireAuth, type AuthVariables } from "../middleware/auth";

// Leaderboard knobs are constants in code, per the phase-2 plan.
const KINDS = ["checkins", "contributions", "verifications"] as const;
type Kind = (typeof KINDS)[number];
const PERIODS = ["week", "month", "all"] as const;
type Period = (typeof PERIODS)[number];
const DAY_MS = 24 * 60 * 60 * 1000;
// Rolling windows; "month" is ~30 days, matching the staleness convention
// in src/lib/freshness.ts.
const PERIOD_MS: Record<Exclude<Period, "all">, number> = { week: 7 * DAY_MS, month: 30 * DAY_MS };
const BOARD_SIZE = 50;
const MAX_DISPLAY_NAME = 80;
// Any signed-in user may edit their own leaderboard prefs — same role set
// as the other phase-2 write endpoints.
const ME_ROLES = ["submitter", "reviewer", "admin"];

const leaderboardsApi = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Same optional-enum parsing convention as src/routes/public.ts: undefined
// when absent, null when present-but-unknown.
function oneOf<const T extends readonly string[]>(raw: string | undefined, allowed: T): T[number] | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  return (allowed as readonly string[]).includes(raw) ? (raw as T[number]) : null;
}

interface CountedSource {
  // FROM clause for the counted table — always aliased `c`, joined (or
  // left-joined) to `venues` aliased `v` so area/venue_type conditions can
  // reference v.area/v.type uniformly across kinds.
  from: SQL;
  conds: SQL[];
}

// The counted entity per kind. `contributions` counts approved submissions
// only — volume without reviewer acceptance doesn't rank — and reaches the
// venue through venue_revisions, the publish audit row (submissions have no
// venue_id of their own). That join is a LEFT JOIN so area-less boards still
// count every approved row; COUNT(DISTINCT c.id) keeps it fan-out-proof.
// Rows without a user (grandfathered v1 anonymous submissions) can't rank.
function countedSource(kind: Kind): CountedSource {
  if (kind === "contributions") {
    return {
      from: sql`FROM submissions AS c
        LEFT JOIN venue_revisions AS r ON r.submission_id = c.id
        LEFT JOIN venues AS v ON v.id = r.venue_id`,
      conds: [sql`c.status IN ('approved','trusted_published')`, sql`c.user_id IS NOT NULL`],
    };
  }
  const table = kind === "checkins" ? sql`check_ins` : sql`verifications`;
  return {
    from: sql`FROM ${table} AS c JOIN venues AS v ON v.id = c.venue_id`,
    conds: [sql`c.user_id IS NOT NULL`],
  };
}

// GET /api/leaderboards?kind=&period=&area=&venue_type= — public board.
// kind: checkins | contributions | verifications (default checkins);
// period: week | month | all (default month, rolling windows); area and
// venue_type filter counts through the venue join. Returns the top-50 rows
// as { rank, name, count } plus `me`, the caller's own { rank, count } —
// null for anonymous callers and callers with no qualifying rows.
//
// Opt-in privacy (Review Focus #5): rows render `display_name` only when the
// user set show_on_leaderboard; every other row — and opted-in users with an
// empty name — renders "Anonymous". `user` is the untracked better-auth
// table, so the join is raw SQL and the row carries no id/email at all.
//
// Many small boards by design: when the caller is signed in and doesn't pass
// `area`, the board defaults to the area they check into most (their home
// board); the applied area is echoed back in the response.
leaderboardsApi.get("/leaderboards", async (c) => {
  // `null` = present-but-invalid (400); `undefined` = absent (defaults).
  const kindParam = oneOf(c.req.query("kind"), KINDS);
  if (kindParam === null) return c.json({ error: "invalid kind", allowed: KINDS }, 400);
  const kind = kindParam ?? "checkins";
  const periodParam = oneOf(c.req.query("period"), PERIODS);
  if (periodParam === null) return c.json({ error: "invalid period", allowed: PERIODS }, 400);
  const period = periodParam ?? "month";
  const areaParam = c.req.query("area");
  const area = oneOf(areaParam, AREAS);
  if (area === null) return c.json({ error: "invalid area", allowed: AREAS }, 400);
  const venueType = oneOf(c.req.query("venue_type"), VENUE_TYPES);
  if (venueType === null) return c.json({ error: "invalid venue_type", allowed: VENUE_TYPES }, 400);

  const db = getDb(c.env);
  // Optional session — the board itself is public; the session only unlocks
  // `me` and the caller-area default.
  const session = await createAuth(c.env)
    .api.getSession({ headers: c.req.raw.headers })
    .catch(() => null);
  const callerId = session?.user?.id;

  // Caller-area default: only when `area` is entirely absent — an explicit
  // `area=` (empty) is a signed-in caller asking for the global board.
  let effectiveArea = area;
  if (areaParam === undefined && callerId) {
    const [home] = (await db.all(sql`
      SELECT v.area AS area FROM check_ins AS c
      JOIN venues AS v ON v.id = c.venue_id
      WHERE c.user_id = ${callerId}
      GROUP BY v.area ORDER BY count(*) DESC, v.area ASC LIMIT 1
    `)) as { area: string }[];
    effectiveArea = home?.area as (typeof AREAS)[number] | undefined;
  }

  const { from, conds } = countedSource(kind);
  if (period !== "all") {
    // Raw epoch-ms bind — D1 rejects Date bind params (see checkins.ts).
    conds.push(sql`c.created_at >= ${Date.now() - PERIOD_MS[period]}`);
  }
  if (effectiveArea) conds.push(sql`v.area = ${effectiveArea}`);
  if (venueType) conds.push(sql`v.type = ${venueType}`);
  const where = and(...conds)!; // conds always carries the kind predicate

  const rows = (await db.all(sql`
    SELECT t.user_id AS user_id, t.n AS n,
      CASE WHEN u.show_on_leaderboard = 1 AND u.display_name IS NOT NULL AND u.display_name <> ''
        THEN u.display_name ELSE 'Anonymous' END AS name,
      u.show_on_leaderboard AS show_on_leaderboard
    FROM (
      SELECT c.user_id AS user_id, count(DISTINCT c.id) AS n
      ${from} WHERE ${where} GROUP BY c.user_id
    ) AS t
    LEFT JOIN "user" AS u ON u.id = t.user_id
    ORDER BY t.n DESC, t.user_id ASC
    LIMIT ${BOARD_SIZE}
  `)) as { user_id: string; n: number; name: string; show_on_leaderboard: number | null }[];

  // Badge flair (Task 8): each OPTED-IN row carries its user's
  // highest-tier badge key — badges leak activity patterns, so opted-out
  // rows always read null, same privacy gate as /api/users/:id/badges.
  // One batched pass for the whole board, not a lookup per row.
  const optedIn = rows.filter((r) => Number(r.show_on_leaderboard) === 1).map((r) => r.user_id);
  const topBadges = await getTopBadges(db, optedIn);

  // Competition ranking (1 + count of strictly-greater entries) so ties
  // share a rank — the same rule `me` is computed with below.
  let rank = 0;
  const board = rows.map((r, i) => {
    if (i === 0 || Number(r.n) !== Number(rows[i - 1]!.n)) rank = i + 1;
    return {
      rank,
      name: String(r.name),
      count: Number(r.n),
      top_badge: Number(r.show_on_leaderboard) === 1 ? (topBadges.get(r.user_id) ?? null) : null,
    };
  });

  // The caller's own rank, including beyond the top-50 cut: their count plus
  // how many users sit strictly above it.
  let me: { rank: number; count: number } | null = null;
  if (callerId) {
    const [mine] = (await db.all(sql`
      SELECT count(DISTINCT c.id) AS n ${from} WHERE ${where} AND c.user_id = ${callerId}
    `)) as { n: number }[];
    const count = Number(mine?.n ?? 0);
    if (count > 0) {
      const [higher] = (await db.all(sql`
        SELECT count(*) AS h FROM (
          SELECT count(DISTINCT c.id) AS n ${from} WHERE ${where} GROUP BY c.user_id
        ) AS t WHERE t.n > ${count}
      `)) as { h: number }[];
      me = { rank: Number(higher?.h ?? 0) + 1, count };
    }
  }

  return c.json({ board, me, area: effectiveArea ?? null });
});

// PATCH /api/me — the opt-in prefs that live on the better-auth `user`
// table (untracked by drizzle, hence the raw UPDATE). Body fields, all
// optional: display_name (string|null, ≤80 chars — empty clears it),
// show_on_leaderboard (bool), show_credit (bool). A patch naming none of
// them is a 400. Returns the stored values.
leaderboardsApi.patch("/me", requireAuth(ME_ROLES), async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "expected JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null) {
    return c.json({ error: "expected JSON body" }, 400);
  }

  const sets: SQL[] = [];
  if (body.display_name !== undefined) {
    if (body.display_name !== null && typeof body.display_name !== "string") {
      return c.json({ error: "display_name must be a string or null" }, 400);
    }
    const name = typeof body.display_name === "string" ? body.display_name.trim() : null;
    if (name !== null && name.length > MAX_DISPLAY_NAME) {
      return c.json({ error: `display_name must be at most ${MAX_DISPLAY_NAME} characters` }, 400);
    }
    sets.push(sql`"display_name" = ${name === "" ? null : name}`);
  }
  for (const key of ["show_on_leaderboard", "show_credit"] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "boolean") return c.json({ error: `${key} must be a boolean` }, 400);
      // 1/0 — D1 doesn't accept boolean bind params.
      sets.push(sql`${sql.raw(`"${key}"`)} = ${body[key] ? 1 : 0}`);
    }
  }
  if (sets.length === 0) {
    return c.json({ error: "nothing to update: provide display_name, show_on_leaderboard or show_credit" }, 400);
  }

  const userId = c.get("user").id;
  // "updatedAt" is the better-auth timestamp column (ISO strings via the
  // kysely adapter) — no trigger keeps it fresh, so we bump it.
  sets.push(sql`"updatedAt" = ${new Date().toISOString()}`);
  const db = getDb(c.env);
  await db.run(sql`UPDATE "user" SET ${sql.join(sets, sql`, `)} WHERE id = ${userId}`);

  const [row] = (await db.all(sql`
    SELECT display_name, show_on_leaderboard, show_credit FROM "user" WHERE id = ${userId}
  `)) as { display_name: string | null; show_on_leaderboard: number; show_credit: number }[];
  return c.json({
    display_name: row?.display_name ?? null,
    show_on_leaderboard: row?.show_on_leaderboard === 1,
    show_credit: row?.show_credit === 1,
  });
});

export default leaderboardsApi;
