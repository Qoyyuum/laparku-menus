import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { getBadges } from "../lib/badges";
import { requireAuth, type AuthVariables } from "../middleware/auth";

// Any signed-in user may read their own badge progress — same role set as
// the other /api/me endpoints.
const ME_ROLES = ["submitter", "reviewer", "admin"];

const badgesApi = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// GET /api/me/badges — the caller's FULL badge list, earned and unearned
// with {progress, target} so the app can render progress bars ("23/50
// check-ins"). Computed at read time by src/lib/badges.ts — never stored.
badgesApi.get("/me/badges", requireAuth(ME_ROLES), async (c) => {
  const badges = await getBadges(getDb(c.env), c.get("user").id);
  return c.json({ badges });
});

// GET /api/users/:id/badges — public, but EARNED badges only and ONLY for
// users who opted into show_on_leaderboard: badge counts leak activity
// patterns, so privacy follows the same opt-in as the boards. Opted-out
// and unknown users are indistinguishable — both are a flat 404.
badgesApi.get("/users/:id/badges", async (c) => {
  const db = getDb(c.env);
  const userId = c.req.param("id");
  const [u] = (await db.all(sql`
    SELECT show_on_leaderboard FROM "user" WHERE id = ${userId}
  `)) as { show_on_leaderboard: number }[];
  if (!u || Number(u.show_on_leaderboard) !== 1) {
    return c.json({ error: "not found" }, 404);
  }
  const badges = (await getBadges(db, userId)).filter((b) => b.earned);
  return c.json({ badges });
});

export default badgesApi;
