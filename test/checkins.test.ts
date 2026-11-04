import { env, SELF } from "cloudflare:test";
import { and, eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { check_ins, verifications, venues } from "../src/db/schema";
import { forgeSession } from "./helpers/auth";

const db = () => getDb(env);

// Staleness uses ~30-day months (see src/lib/freshness.ts).
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

// --- fixtures ---------------------------------------------------------------

// A published venue is the only surface a check-in can attach to (same
// public-surface rule as POST /verify).
async function seedVenue() {
  const [v] = await db()
    .insert(venues)
    .values({ name: `CI-${crypto.randomUUID().slice(0, 8)}`, type: "restaurant", area: "Brunei-Muara" })
    .returning();
  return v!;
}

function checkin(venueId: string, body: unknown, cookie?: string) {
  return SELF.fetch(`https://x/api/venues/${venueId}/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

interface StaleVenue {
  id: string;
  status: string;
  possibly_closed: boolean;
}

async function staleList(cookie: string) {
  const res = await SELF.fetch("https://x/api/admin/stale", { headers: { cookie } });
  return { res, body: (await res.json()) as { venues: StaleVenue[] } };
}

// --- (a) check-in creates a row and bumps venues.last_checkin_at -------------

it("check-in creates a row, stores geo, and bumps venues.last_checkin_at", async () => {
  const venue = await seedVenue();
  const { cookie, userId } = await forgeSession("submitter");

  const res = await checkin(venue.id, { lat: 4.9031, lng: 114.9398 }, cookie);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };

  const [row] = await db()
    .select()
    .from(check_ins)
    .where(and(eq(check_ins.venue_id, venue.id), eq(check_ins.user_id, userId)));
  expect(row).toBeTruthy();
  expect(row!.id).toBe(body.id);
  expect(row!.geo_lat).toBeCloseTo(4.9031);
  expect(row!.geo_lng).toBeCloseTo(114.9398);
  expect(row!.menu_accurate).toBeNull();

  const [after] = await db().select().from(venues).where(eq(venues.id, venue.id));
  expect(after!.last_checkin_at!.getTime()).toBeGreaterThan(Date.now() - 60_000);
});

// --- (b) Review Focus #2: counted daily limits → 429 -------------------------

it("25 check-ins in one day: requests 21+ return 429 and the stored count stays 20", { timeout: 20000 }, async () => {
  const { cookie, userId } = await forgeSession("submitter");
  const statuses: number[] = [];
  for (let i = 0; i < 25; i++) {
    const venue = await seedVenue(); // a distinct venue each time — the venue cap never fires
    statuses.push((await checkin(venue.id, {}, cookie)).status);
  }
  expect(statuses.slice(0, 20)).toEqual(Array(20).fill(201));
  expect(statuses.slice(20)).toEqual(Array(5).fill(429));

  // What a leaderboard would count later: exactly 20 rows.
  const [countRow] = await db()
    .select({ n: sql<number>`count(*)` })
    .from(check_ins)
    .where(eq(check_ins.user_id, userId));
  expect(Number(countRow!.n)).toBe(20);
});

it("25 concurrent check-ins in one day still cap at exactly 20", { timeout: 20000 }, async () => {
  const { cookie, userId } = await forgeSession("submitter");
  const venues25 = await Promise.all(Array.from({ length: 25 }, () => seedVenue()));
  // In-flight requests interleave — the atomic INSERT ... WHERE count<20
  // must hold the cap even when reads overlap.
  const res = await Promise.all(venues25.map((v) => checkin(v.id, {}, cookie)));
  expect(res.filter((r) => r.status === 201)).toHaveLength(20);
  expect(res.filter((r) => r.status === 429)).toHaveLength(5);

  const [countRow] = await db()
    .select({ n: sql<number>`count(*)` })
    .from(check_ins)
    .where(eq(check_ins.user_id, userId));
  expect(Number(countRow!.n)).toBe(20);
});

it("a check-in with menu_accurate concurrent with a verify vote still lands one vote", async () => {
  const venue = await seedVenue();
  const { cookie, userId } = await forgeSession("submitter");
  const [verifyRes, checkinRes] = await Promise.all([
    SELF.fetch(`https://x/api/venues/${venue.id}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ accurate: true }),
    }),
    checkin(venue.id, { menu_accurate: false }, cookie),
  ]);
  // Neither side may 500 on the verifications_daily_idx race; the committed
  // check-in still returns 201.
  expect([200, 201]).toContain(verifyRes.status);
  expect(checkinRes.status).toBe(201);
  // One row per user/venue/day regardless of which request landed first.
  const votes = await db()
    .select()
    .from(verifications)
    .where(and(eq(verifications.venue_id, venue.id), eq(verifications.user_id, userId)));
  expect(votes).toHaveLength(1);
});

it("a second check-in at the same venue the same day returns 429", async () => {
  const venue = await seedVenue();
  const other = await seedVenue();
  const { cookie } = await forgeSession("submitter");

  expect((await checkin(venue.id, {}, cookie)).status).toBe(201);
  expect((await checkin(venue.id, {}, cookie)).status).toBe(429);
  // The venue cap is per-venue — a different venue still accepts the check-in.
  expect((await checkin(other.id, {}, cookie)).status).toBe(201);
});

// --- (c) menu_accurate rides the Task 3 verification signal ------------------

it("a check-in carrying menu_accurate writes a verification vote", async () => {
  const bad = await seedVenue();
  const good = await seedVenue();
  const { cookie, userId } = await forgeSession("submitter");

  // menu_accurate=false → a "not accurate" verification row; it must NOT
  // bump last_verified_at (Task 3 semantics — it feeds no-votes instead).
  expect((await checkin(bad.id, { menu_accurate: false }, cookie)).status).toBe(201);
  let [vote] = await db()
    .select()
    .from(verifications)
    .where(and(eq(verifications.venue_id, bad.id), eq(verifications.user_id, userId)));
  expect(vote?.accurate).toBe(false);
  const [badRow] = await db().select().from(venues).where(eq(venues.id, bad.id));
  expect(badRow!.last_verified_at).toBeNull();

  // menu_accurate=true → positive vote, which bumps last_verified_at.
  expect((await checkin(good.id, { menu_accurate: true }, cookie)).status).toBe(201);
  [vote] = await db()
    .select()
    .from(verifications)
    .where(and(eq(verifications.venue_id, good.id), eq(verifications.user_id, userId)));
  expect(vote?.accurate).toBe(true);
  const [goodRow] = await db().select().from(venues).where(eq(venues.id, good.id));
  expect(goodRow!.last_verified_at!.getTime()).toBeGreaterThan(Date.now() - 60_000);
});

// --- (d) geo is optional -----------------------------------------------------

it("check-in without geo still returns 201 and stores NULLs", async () => {
  const venue = await seedVenue();
  const { cookie, userId } = await forgeSession("submitter");

  expect((await checkin(venue.id, {}, cookie)).status).toBe(201);
  const [row] = await db()
    .select()
    .from(check_ins)
    .where(and(eq(check_ins.venue_id, venue.id), eq(check_ins.user_id, userId)));
  expect(row!.geo_lat).toBeNull();
  expect(row!.geo_lng).toBeNull();
});

// --- (e) session + input guards ----------------------------------------------

it("check-in requires a session, a published venue, and valid fields", async () => {
  const venue = await seedVenue();
  // Anonymous → 401 (all writes ride the session).
  expect((await checkin(venue.id, {})).status).toBe(401);

  const { cookie } = await forgeSession("submitter");
  // Unknown venue → 404; draft venues aren't on the public surface either.
  expect((await checkin(crypto.randomUUID(), {}, cookie)).status).toBe(404);
  const [draft] = await db()
    .insert(venues)
    .values({ name: "Draft Spot", type: "stall", area: "Tutong", status: "draft" })
    .returning();
  expect((await checkin(draft!.id, {}, cookie)).status).toBe(404);

  // Field validation: menu_accurate must be a real boolean; lat/lng must
  // arrive together as in-range numbers.
  expect((await checkin(venue.id, { menu_accurate: "yes" }, cookie)).status).toBe(400);
  expect((await checkin(venue.id, { lat: 4.9 }, cookie)).status).toBe(400);
  expect((await checkin(venue.id, { lat: 91, lng: 0 }, cookie)).status).toBe(400);
  // None of the rejected attempts above wrote a row.
  const [countRow] = await db()
    .select({ n: sql<number>`count(*)` })
    .from(check_ins)
    .where(eq(check_ins.venue_id, venue.id));
  expect(Number(countRow!.n)).toBe(0);
});

// --- staleness extension: possibly_closed --------------------------------------

it("venues with no check-in in 6+ months surface in /api/admin/stale as possibly_closed", async () => {
  const now = new Date();
  // Verified recently so only the check-in signal can flag them.
  const [neverVisited] = await db()
    .insert(venues)
    .values({
      name: "Never Visited",
      type: "restaurant",
      area: "Belait",
      last_verified_at: now,
    })
    .returning();
  const [oldVisit] = await db()
    .insert(venues)
    .values({
      name: "Old Visit",
      type: "stall",
      area: "Tutong",
      last_verified_at: now,
      last_checkin_at: new Date(Date.now() - 7 * MONTH_MS),
    })
    .returning();
  const [recentVisit] = await db()
    .insert(venues)
    .values({
      name: "Recent Visit",
      type: "restaurant",
      area: "Temburong",
      last_verified_at: now,
      last_checkin_at: now,
    })
    .returning();
  const { cookie } = await forgeSession("reviewer");

  const { res, body } = await staleList(cookie);
  expect(res.status).toBe(200);
  const byId = new Map(body.venues.map((v) => [v.id, v]));
  // NULL last_checkin_at and >STALE_MONTHS both read as "possibly closed".
  expect(byId.get(neverVisited!.id)?.possibly_closed).toBe(true);
  expect(byId.get(oldVisit!.id)?.possibly_closed).toBe(true);
  // A recent check-in keeps a fresh venue off the list entirely.
  expect(byId.has(recentVisit!.id)).toBe(false);
  // Surfacing is a hint only — never an automatic status change.
  expect(byId.get(neverVisited!.id)?.status).toBe("published");
  const [row] = await db().select().from(venues).where(eq(venues.id, neverVisited!.id));
  expect(row!.status).toBe("published");
});
