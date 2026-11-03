import { env, SELF } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { submissions, verifications, venues } from "../src/db/schema";
import { forgeSession } from "./helpers/auth";

const db = () => getDb(env);

// Staleness uses ~30-day months (see src/lib/freshness.ts).
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

// --- fixtures ---------------------------------------------------------------

// A published venue; pass null to model "never verified" (v1-era rows) or a
// past Date to model an old verification. last_checkin_at is pinned to now
// so these fixtures are never "possibly closed" — the check-in liveness
// signal (Task 4) has its own coverage in checkins.test.ts and would
// otherwise put every seed on the stale list.
async function seedVenue(lastVerifiedAt: Date | null = new Date()) {
  const [v] = await db()
    .insert(venues)
    .values({ name: `Fresh-${crypto.randomUUID().slice(0, 8)}`, type: "restaurant", area: "Brunei-Muara", last_verified_at: lastVerifiedAt, last_checkin_at: new Date() })
    .returning();
  return v!;
}

async function seedPendingSubmission() {
  const [row] = await db()
    .insert(submissions)
    .values({
      source_type: "menu_photo",
      provenance: "photo of the physical menu",
      status: "pending_review",
      raw_extraction: { has_food_content: true, items: [{ name: "Nasi Katok" }] },
    })
    .returning();
  return row!;
}

function verify(venueId: string, accurate: boolean, cookie?: string) {
  return SELF.fetch(`https://x/api/venues/${venueId}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ accurate }),
  });
}

interface StaleVenue {
  id: string;
  name: string;
  status: string;
  last_verified_at: string | null;
  no_votes: number;
  freshness: string;
}

async function staleList(cookie: string) {
  const res = await SELF.fetch("https://x/api/admin/stale", { headers: { cookie } });
  return { res, body: (await res.json()) as { venues: StaleVenue[] } };
}

// --- (a) verify votes ---------------------------------------------------------

it("verify accurate=true records the vote, bumps last_verified_at, and the venue reads fresh", async () => {
  const venue = await seedVenue(new Date(Date.now() - 4 * MONTH_MS)); // aging
  const { cookie, userId } = await forgeSession("submitter");

  const res = await verify(venue.id, true, cookie);
  expect(res.status).toBe(201);

  const [vote] = await db()
    .select()
    .from(verifications)
    .where(and(eq(verifications.venue_id, venue.id), eq(verifications.user_id, userId)));
  expect(vote?.accurate).toBe(true);

  const [after] = await db().select().from(venues).where(eq(venues.id, venue.id));
  expect(after!.last_verified_at!.getTime()).toBeGreaterThan(Date.now() - 60_000);

  const listRes = await SELF.fetch("https://x/api/venues");
  const { venues: list } = (await listRes.json()) as {
    venues: { id: string; freshness: string; last_verified_at: number | null }[];
  };
  expect(list.find((v) => v.id === venue.id)?.freshness).toBe("fresh");
});

it("a second vote the same day updates the row instead of duplicating it", async () => {
  const venue = await seedVenue();
  const { cookie, userId } = await forgeSession("submitter");

  expect((await verify(venue.id, false, cookie)).status).toBe(201);
  expect((await verify(venue.id, true, cookie)).status).toBe(200); // update, not insert

  const votes = await db()
    .select()
    .from(verifications)
    .where(and(eq(verifications.venue_id, venue.id), eq(verifications.user_id, userId)));
  expect(votes).toHaveLength(1);
  expect(votes[0]!.accurate).toBe(true);
});

it("verify requires a session, a boolean `accurate`, and a published venue", async () => {
  const venue = await seedVenue();
  // (e) anonymous → 401
  expect((await verify(venue.id, true)).status).toBe(401);

  const { cookie } = await forgeSession("submitter");
  const bad = (body: unknown, id = venue.id) =>
    SELF.fetch(`https://x/api/venues/${id}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
  expect((await bad({})).status).toBe(400);
  expect((await bad({ accurate: "yes" })).status).toBe(400);
  expect((await bad({ accurate: true }, crypto.randomUUID())).status).toBe(404);
  // Draft venues aren't on the public surface — same 404 the flag route gives.
  const [draft] = await db()
    .insert(venues)
    .values({ name: "Draft Spot", type: "stall", area: "Tutong", status: "draft" })
    .returning();
  expect((await bad({ accurate: true }, draft!.id)).status).toBe(404);
});

// --- (c) admin staleness list (Review Focus #3) --------------------------------

it("one 'not accurate' vote does not stale a fresh venue; three distinct votes do", async () => {
  const freshOneVote = await seedVenue();
  const freshThreeVotes = await seedVenue();
  const { cookie: reviewer } = await forgeSession("reviewer");

  const { cookie: voter } = await forgeSession("submitter");
  expect((await verify(freshOneVote.id, false, voter)).status).toBe(201);
  expect((await verify(freshThreeVotes.id, false, voter)).status).toBe(201);

  // A single distinct no-vote is below the STALE_NO_VOTES threshold.
  let { body } = await staleList(reviewer);
  expect(body.venues.find((v) => v.id === freshOneVote.id)).toBeUndefined();
  expect(body.venues.find((v) => v.id === freshThreeVotes.id)).toBeUndefined();

  // Two more distinct users push the second venue over the threshold.
  for (let i = 0; i < 2; i++) {
    const { cookie } = await forgeSession("submitter");
    expect((await verify(freshThreeVotes.id, false, cookie)).status).toBe(201);
  }

  ({ body } = await staleList(reviewer));
  expect(body.venues.find((v) => v.id === freshOneVote.id)).toBeUndefined();
  const hit = body.venues.find((v) => v.id === freshThreeVotes.id);
  expect(hit).toBeTruthy();
  expect(hit!.no_votes).toBe(3);
  // Staleness flags for reviewers only — never an automatic status change.
  expect(hit!.status).toBe("published");
  const [row] = await db().select().from(venues).where(eq(venues.id, freshThreeVotes.id));
  expect(row!.status).toBe("published");
});

it("time-stale venues surface in /api/admin/stale; never-verified counts as stale too", async () => {
  const ancient = await seedVenue(new Date(Date.now() - 7 * MONTH_MS));
  const neverVerified = await seedVenue(null);
  const fresh = await seedVenue();
  const { cookie } = await forgeSession("reviewer");

  const { res, body } = await staleList(cookie);
  expect(res.status).toBe(200);
  const ids = body.venues.map((v) => v.id);
  expect(ids).toContain(ancient.id);
  expect(ids).toContain(neverVerified.id);
  expect(ids).not.toContain(fresh.id);
  expect(body.venues.find((v) => v.id === ancient.id)?.freshness).toBe("stale");
});

it("a positive vote after 'not accurate' votes clears the no-vote pressure", async () => {
  const venue = await seedVenue();
  const { cookie: reviewer } = await forgeSession("reviewer");

  for (let i = 0; i < 3; i++) {
    const { cookie } = await forgeSession("submitter");
    expect((await verify(venue.id, false, cookie)).status).toBe(201);
  }
  let { body } = await staleList(reviewer);
  expect(body.venues.find((v) => v.id === venue.id)).toBeTruthy();

  // One accurate vote re-verifies the venue; the older no-votes stop counting.
  const { cookie } = await forgeSession("submitter");
  expect((await verify(venue.id, true, cookie)).status).toBe(201);
  ({ body } = await staleList(reviewer));
  expect(body.venues.find((v) => v.id === venue.id)).toBeUndefined();
});

it("admin staleness list rejects non-reviewers", async () => {
  expect((await SELF.fetch("https://x/api/admin/stale")).status).toBe(401);
  const { cookie: submitter } = await forgeSession("submitter");
  expect((await SELF.fetch("https://x/api/admin/stale", { headers: { cookie: submitter } })).status).toBe(403);
});

// --- (d) publish sets last_verified_at -----------------------------------------

it("approving a submission sets last_verified_at — on an existing and a new venue", async () => {
  const { cookie } = await forgeSession("reviewer");
  const approve = (id: string, body: unknown) =>
    SELF.fetch(`https://x/api/admin/submissions/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });

  // Existing venue: an old verification date must be bumped to ~now.
  const staleVenue = await seedVenue(new Date(Date.now() - 8 * MONTH_MS));
  const sub1 = await seedPendingSubmission();
  const res1 = await approve(sub1.id, {
    venue_id: staleVenue.id,
    items: [{ name: "New Dish", price_bnd: 3, item_type: "dish" }],
  });
  expect(res1.status).toBe(200);
  const [v1] = await db().select().from(venues).where(eq(venues.id, staleVenue.id));
  expect(v1!.last_verified_at!.getTime()).toBeGreaterThan(Date.now() - 60_000);

  // New venue created by the publish starts verified too.
  const sub2 = await seedPendingSubmission();
  const res2 = await approve(sub2.id, {
    venue: { name: "Brand New Resto", type: "restaurant", area: "Belait" },
    items: [{ name: "Ambuyat", price_bnd: 4, item_type: "dish" }],
  });
  expect(res2.status).toBe(200);
  const { venue_id } = (await res2.json()) as { venue_id: string };
  const [v2] = await db().select().from(venues).where(eq(venues.id, venue_id));
  expect(v2!.last_verified_at!.getTime()).toBeGreaterThan(Date.now() - 60_000);
});
