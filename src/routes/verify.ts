import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/client";
import { venues } from "../db/schema";
import type { Env } from "../env";
import { recordVerification } from "../lib/freshness";
import { requireAuth, type AuthVariables } from "../middleware/auth";

// Any signed-in user can verify — same role set as POST /api/submissions.
const VERIFY_ROLES = ["submitter", "reviewer", "admin"];

const verifyApi = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// POST /api/venues/:id/verify — the "Is this menu still current?" vote.
// JSON body { accurate: boolean }. One vote per user per venue per UTC day:
// a first vote returns 201, a same-day re-vote updates and returns 200.
// accurate=true additionally bumps venues.last_verified_at.
verifyApi.post("/venues/:id/verify", requireAuth(VERIFY_ROLES), async (c) => {
  let body: { accurate?: unknown };
  try {
    body = (await c.req.json()) as { accurate?: unknown };
  } catch {
    return c.json({ error: "expected JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null || typeof body.accurate !== "boolean") {
    return c.json({ error: "accurate must be a boolean" }, 400);
  }

  const db = getDb(c.env);
  // Votes only attach to the public surface — a draft/closed venue can't
  // accumulate freshness signals for a menu nobody can see.
  const [venue] = await db
    .select({ id: venues.id })
    .from(venues)
    .where(and(eq(venues.id, c.req.param("id")), eq(venues.status, "published")))
    .limit(1);
  if (!venue) return c.json({ error: "venue not found" }, 404);

  const { vote, created } = await recordVerification(db, venue.id, c.get("user").id, body.accurate);
  return c.json({ id: vote.id, accurate: vote.accurate }, created ? 201 : 200);
});

export default verifyApi;
