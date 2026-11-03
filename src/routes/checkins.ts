import { and, eq, gte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/client";
import { check_ins, venues } from "../db/schema";
import type { Env } from "../env";
import { recordVerification } from "../lib/freshness";
import { requireAuth, type AuthVariables } from "../middleware/auth";

// Any signed-in user can check in — same role set as POST /verify.
const CHECKIN_ROLES = ["submitter", "reviewer", "admin"];
// Check-in caps (constants in code, per the phase-2 plan): one check-in
// per user per venue per UTC day, and at most 20 per user per day overall —
// beyond either limit the route answers 429.
const MAX_PER_VENUE_PER_DAY = 1;
const MAX_PER_USER_PER_DAY = 20;

const checkinsApi = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// UTC day boundary — the same clock recordVerification uses for its
// one-vote-per-day window, so a check-in and a vote agree on what "today"
// means.
function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// POST /api/venues/:id/checkin — the "I ate here" signal. JSON body
// { menu_accurate?, lat?, lng? }: everything optional; geo must arrive as a
// lat/lng pair in range; a present menu_accurate also records a
// verifications vote via recordVerification (checking in is how most
// re-verification data arrives — Task 3 semantics). Each check-in bumps
// venues.last_checkin_at, which the admin staleness list reads as a
// "possibly closed" hint. Limits: 1 per user per venue per UTC day and 20
// per user per day → 429 past either.
checkinsApi.post("/venues/:id/checkin", requireAuth(CHECKIN_ROLES), async (c) => {
  let body: { menu_accurate?: unknown; lat?: unknown; lng?: unknown };
  try {
    body = (await c.req.json()) as { menu_accurate?: unknown; lat?: unknown; lng?: unknown };
  } catch {
    return c.json({ error: "expected JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null) {
    return c.json({ error: "expected JSON body" }, 400);
  }
  if (body.menu_accurate !== undefined && typeof body.menu_accurate !== "boolean") {
    return c.json({ error: "menu_accurate must be a boolean" }, 400);
  }
  // A lone latitude is meaningless — geo is stored as a pair or not at all.
  if ((body.lat === undefined) !== (body.lng === undefined)) {
    return c.json({ error: "lat and lng must be sent together" }, 400);
  }
  if (body.lat !== undefined) {
    const { lat, lng } = body as { lat: unknown; lng: unknown };
    if (
      typeof lat !== "number" ||
      typeof lng !== "number" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return c.json({ error: "lat/lng must be in-range numbers" }, 400);
    }
  }

  const db = getDb(c.env);
  // Check-ins only attach to the public surface — same published-venue
  // rule as /verify.
  const [venue] = await db
    .select({ id: venues.id })
    .from(venues)
    .where(and(eq(venues.id, c.req.param("id")), eq(venues.status, "published")))
    .limit(1);
  if (!venue) return c.json({ error: "venue not found" }, 404);

  const userId = c.get("user").id;
  const dayStart = utcDayStart(new Date());

  // Counted caps. The venue/day UNIQUE expression index
  // (check_ins_daily_idx) is the race backstop; counting first is what lets
  // a normal repeat get a 429 instead of a constraint error.
  const [venueToday] = await db
    .select({ n: sql<number>`count(*)` })
    .from(check_ins)
    .where(
      and(
        eq(check_ins.venue_id, venue.id),
        eq(check_ins.user_id, userId),
        gte(check_ins.created_at, dayStart),
      ),
    );
  if (Number(venueToday?.n ?? 0) >= MAX_PER_VENUE_PER_DAY) {
    return c.json({ error: "already checked in at this venue today" }, 429);
  }
  const [userToday] = await db
    .select({ n: sql<number>`count(*)` })
    .from(check_ins)
    .where(and(eq(check_ins.user_id, userId), gte(check_ins.created_at, dayStart)));
  if (Number(userToday?.n ?? 0) >= MAX_PER_USER_PER_DAY) {
    return c.json({ error: "daily check-in limit reached" }, 429);
  }

  const now = new Date();
  let row: typeof check_ins.$inferSelect | undefined;
  try {
    [row] = await db
      .insert(check_ins)
      .values({
        venue_id: venue.id,
        user_id: userId,
        geo_lat: (body.lat as number | undefined) ?? null,
        geo_lng: (body.lng as number | undefined) ?? null,
        menu_accurate: (body.menu_accurate as boolean | undefined) ?? null,
        created_at: now,
      })
      .returning();
  } catch (e) {
    // Race loser of the same-day double-check-in: the UNIQUE index fires,
    // which from the user's perspective is still just "already checked in".
    if (e instanceof Error && /unique/i.test(e.message)) {
      return c.json({ error: "already checked in at this venue today" }, 429);
    }
    throw e;
  }

  await db.update(venues).set({ last_checkin_at: now }).where(eq(venues.id, venue.id));
  if (body.menu_accurate !== undefined) {
    await recordVerification(db, venue.id, userId, body.menu_accurate as boolean);
  }

  return c.json(
    {
      id: row!.id,
      venue_id: row!.venue_id,
      menu_accurate: row!.menu_accurate,
      geo_lat: row!.geo_lat,
      geo_lng: row!.geo_lng,
      created_at: row!.created_at,
    },
    201,
  );
});

export default checkinsApi;
