import { and, asc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { verifications, venues, type Venue, type Verification } from "../db/schema";
import type { Env } from "../env";

export type Freshness = "fresh" | "aging" | "stale";

const DAY_MS = 24 * 60 * 60 * 1000;
// A "month" here is ~30 days — staleness is a reviewer heuristic, not a
// contract, so a fixed day-count keeps the [vars] thresholds legible.
const MONTH_MS = 30 * DAY_MS;
const LIMIT = 100;

// STALE_MONTHS ([vars], default 6): verified-longer-ago-than-this → stale.
export function staleMonths(env: Env): number {
  const n = Number(env.STALE_MONTHS);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

// STALE_NO_VOTES ([vars], default 3): this many distinct users voting "not
// accurate" since the last positive verification also marks a venue stale.
export function staleNoVotes(env: Env): number {
  const n = Number(env.STALE_NO_VOTES);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

// fresh < half the stale window (<3mo at the default), aging < the full
// window (<6mo), stale beyond it — or never verified at all (NULL).
export function freshness(
  venue: { last_verified_at: Date | null },
  months: number,
  now: Date = new Date(),
): Freshness {
  const at = venue.last_verified_at;
  if (!at) return "stale";
  const age = now.getTime() - at.getTime();
  if (age < (months / 2) * MONTH_MS) return "fresh";
  if (age < months * MONTH_MS) return "aging";
  return "stale";
}

// Stamp a venue row with its derived freshness badge. Used by the public
// venue responses and the admin staleness list.
export function withFreshness<T extends { last_verified_at: Date | null }>(
  venue: T,
  months: number,
): T & { freshness: Freshness } {
  return { ...venue, freshness: freshness(venue, months) };
}

// Record one "is this menu still current?" vote. One vote per user per
// venue per UTC day: a repeat vote today updates the existing row (the
// hand-added UNIQUE expression index on date(created_at) is the race
// backstop — see migrations/0002_phase2.sql). A positive vote also bumps
// venues.last_verified_at, the freshness signal; a "not accurate" vote
// does not touch it — it feeds the admin staleness list instead.
export async function recordVerification(
  db: Db,
  venueId: string,
  userId: string,
  accurate: boolean,
): Promise<{ vote: Verification; created: boolean }> {
  try {
    return await recordVerificationOnce(db, venueId, userId, accurate);
  } catch (e) {
    // Same-day first-vote race: a concurrent request (a parallel /verify or
    // a check-in carrying menu_accurate) inserted today's row between our
    // read and insert, and verifications_daily_idx fired. One retry lands
    // on the ordinary same-day UPDATE path now that the row exists — the
    // loser's vote still applies instead of 500ing.
    if (e instanceof Error && /unique/i.test(e.message)) {
      return await recordVerificationOnce(db, venueId, userId, accurate);
    }
    throw e;
  }
}

async function recordVerificationOnce(
  db: Db,
  venueId: string,
  userId: string,
  accurate: boolean,
): Promise<{ vote: Verification; created: boolean }> {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [today] = await db
    .select()
    .from(verifications)
    .where(
      and(
        eq(verifications.venue_id, venueId),
        eq(verifications.user_id, userId),
        gte(verifications.created_at, dayStart),
      ),
    )
    .limit(1);

  let vote: Verification | undefined;
  let created = false;
  if (today) {
    [vote] = await db
      .update(verifications)
      .set({ accurate, created_at: now })
      .where(eq(verifications.id, today.id))
      .returning();
  } else {
    created = true;
    [vote] = await db
      .insert(verifications)
      .values({ venue_id: venueId, user_id: userId, accurate, created_at: now })
      .returning();
  }

  if (accurate) {
    await db.update(venues).set({ last_verified_at: now }).where(eq(venues.id, venueId));
  }
  return { vote: vote!, created };
}

export type StaleVenue = Venue & { freshness: Freshness; no_votes: number; possibly_closed: boolean };

// The admin staleness list: published venues needing reviewer attention.
// A venue is stale when it was never verified (last_verified_at NULL) or
// last verified more than STALE_MONTHS ago — OR when STALE_NO_VOTES or
// more distinct users voted "not accurate" at/after the last verification
// (a positive verify resets the clock, so older no-votes stop counting).
// A venue also surfaces — flagged possibly_closed — when it has had no
// check-in within the stale window (last_checkin_at NULL or older than
// STALE_MONTHS): a liveness hint for reviewers deciding whether the venue
// still exists at all. List-only by design: nothing here ever changes
// venues.status.
//
// Two queries rather than a correlated subquery: drizzle renders column
// refs inside select-field sql`` fragments unqualified, which silently
// mis-correlates ("id" resolves to the inner table's id). A group-by join
// keeps every reference qualified and D1-friendly.
export async function listStaleVenues(db: Db, env: Env): Promise<StaleVenue[]> {
  const months = staleMonths(env);
  const threshold = staleNoVotes(env);
  const cutoff = new Date(Date.now() - months * MONTH_MS);

  // Distinct recent no-votes per published venue — "recent" = cast at or
  // after the venue's last positive verification. count(DISTINCT user_id)
  // means one repeat voter can't stuff the ballot across days.
  const voteRows = await db
    .select({
      venue_id: verifications.venue_id,
      n: sql<number>`count(DISTINCT ${verifications.user_id})`,
    })
    .from(verifications)
    .innerJoin(venues, eq(verifications.venue_id, venues.id))
    .where(
      and(
        eq(venues.status, "published"),
        eq(verifications.accurate, false),
        sql`${verifications.created_at} >= coalesce(${venues.last_verified_at}, 0)`,
      ),
    )
    .groupBy(verifications.venue_id);
  const noVotes = new Map(voteRows.map((r) => [r.venue_id, Number(r.n)]));
  const flaggedIds = voteRows.filter((r) => Number(r.n) >= threshold).map((r) => r.venue_id);

  // A venue qualifies by age, by vote pressure, or by the check-in
  // liveness signal. The id list is chunked because D1 caps a query at
  // ~100 bound params — same discipline as the batched inArray writes in
  // publish.ts.
  const staleConds: SQL[] = [
    or(isNull(venues.last_verified_at), lt(venues.last_verified_at, cutoff))!,
    // "Possibly closed": nobody has checked in within the stale window.
    or(isNull(venues.last_checkin_at), lt(venues.last_checkin_at, cutoff))!,
  ];
  const ID_CHUNK = 90;
  for (let off = 0; off < flaggedIds.length; off += ID_CHUNK) {
    staleConds.push(inArray(venues.id, flaggedIds.slice(off, off + ID_CHUNK)));
  }
  const rows = await db
    .select()
    .from(venues)
    .where(and(eq(venues.status, "published"), or(...staleConds)))
    // Never-verified venues (NULL → 0) sort first, then oldest verified.
    .orderBy(asc(sql`coalesce(${venues.last_verified_at}, 0)`))
    .limit(LIMIT);

  return rows.map((v) => ({
    ...withFreshness(v, months),
    no_votes: noVotes.get(v.id) ?? 0,
    possibly_closed: v.last_checkin_at == null || v.last_checkin_at.getTime() < cutoff.getTime(),
  }));
}
