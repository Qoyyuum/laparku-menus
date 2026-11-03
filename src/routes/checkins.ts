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
  const now = new Date();
  const dayStart = utcDayStart(now);

  // Venue/day cap: a pre-check for the friendly 429; the check_ins_daily_idx
  // UNIQUE expression index is its atomic race backstop (see the insert's
  // catch below).
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

  // The 20/day cap is enforced INSIDE the insert — a plain count-then-insert
  // lets two concurrent requests both read 19 and both write a 20th and
  // 21st row. `INSERT ... SELECT ... WHERE (count) < cap` evaluates the cap
  // atomically with the write; zero RETURNING rows means the cap was hit.
  // Bound values are raw SQLite types (epoch-ms ints, 1/0 for the bool —
  // D1 doesn't accept Date/boolean bind params).
  const id = crypto.randomUUID();
  const geoLat = body.lat === undefined ? null : (body.lat as number);
  const geoLng = body.lng === undefined ? null : (body.lng as number);
  const menuAccurate =
    body.menu_accurate === undefined ? null : (body.menu_accurate as boolean) ? 1 : 0;
  let inserted: Record<string, unknown> | undefined;
  try {
    inserted = (await db.get(sql`
      INSERT INTO check_ins (id, venue_id, user_id, geo_lat, geo_lng, menu_accurate, created_at)
      SELECT ${id}, ${venue.id}, ${userId}, ${geoLat}, ${geoLng}, ${menuAccurate}, ${now.getTime()}
      WHERE (
        SELECT count(*) FROM check_ins
        WHERE user_id = ${userId} AND created_at >= ${dayStart.getTime()}
      ) < ${MAX_PER_USER_PER_DAY}
      RETURNING id
    `)) as Record<string, unknown> | undefined;
  } catch (e) {
    // Race loser of the same-day double-check-in at the same venue: the
    // UNIQUE index fires, which from the user's perspective is still just
    // "already checked in".
    if (e instanceof Error && /unique/i.test(e.message)) {
      return c.json({ error: "already checked in at this venue today" }, 429);
    }
    throw e;
  }
  if (!inserted) {
    return c.json({ error: "daily check-in limit reached" }, 429);
  }

  await db.update(venues).set({ last_checkin_at: now }).where(eq(venues.id, venue.id));
  if (body.menu_accurate !== undefined) {
    // recordVerification retries its own same-day UNIQUE race internally;
    // if it still can't land the vote, the committed check-in still counts —
    // a verification row for today already exists in that failure mode, so
    // the signal wasn't lost anyway.
    try {
      await recordVerification(db, venue.id, userId, body.menu_accurate as boolean);
    } catch (e) {
      if (!(e instanceof Error) || !/unique/i.test(e.message)) throw e;
    }
  }

  return c.json(
    {
      id,
      venue_id: venue.id,
      menu_accurate: menuAccurate === null ? null : menuAccurate === 1,
      geo_lat: geoLat,
      geo_lng: geoLng,
      created_at: now,
    },
    201,
  );
});

export default checkinsApi;
