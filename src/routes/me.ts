import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { requireAuth, type AuthVariables } from "../middleware/auth";

// Any signed-in user may read their own stats — same role set as PATCH
// /api/me and the other phase-2 write endpoints.
const ME_ROLES = ["submitter", "reviewer", "admin"];

const meApi = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// GET /api/me — the signed-in caller's personal counts plus their current
// opt-in prefs (what PATCH /api/me in src/routes/leaderboards.ts writes, so
// the app can prefill the toggles). Counts are per-user and exact; prefs
// come off the untracked better-auth `user` table via raw SQL — same
// convention as leaderboards.ts.
meApi.get("/me", requireAuth(ME_ROLES), async (c) => {
  const userId = c.get("user").id;
  const db = getDb(c.env);
  const [counts] = (await db.all(sql`
    SELECT
      (SELECT count(*) FROM submissions WHERE user_id = ${userId}) AS submissions,
      (SELECT count(*) FROM submissions WHERE user_id = ${userId} AND status IN ('approved','trusted_published')) AS approved,
      (SELECT count(*) FROM check_ins WHERE user_id = ${userId}) AS checkins,
      (SELECT count(*) FROM verifications WHERE user_id = ${userId}) AS verifications
  `)) as { submissions: number; approved: number; checkins: number; verifications: number }[];
  const [u] = (await db.all(sql`
    SELECT display_name, show_on_leaderboard, show_credit FROM "user" WHERE id = ${userId}
  `)) as { display_name: string | null; show_on_leaderboard: number; show_credit: number }[];
  return c.json({
    display_name: u?.display_name ?? null,
    show_on_leaderboard: u?.show_on_leaderboard === 1,
    show_credit: u?.show_credit === 1,
    submissions: Number(counts?.submissions ?? 0),
    approved: Number(counts?.approved ?? 0),
    checkins: Number(counts?.checkins ?? 0),
    verifications: Number(counts?.verifications ?? 0),
  });
});

export default meApi;
