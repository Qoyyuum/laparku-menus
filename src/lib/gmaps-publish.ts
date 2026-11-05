// Trusted publish for gmaps_link structured menus — the same "externally
// verified data + bounded blast radius" model as trustedPublishScan
// (src/lib/trusted-publish.ts). Differences: items key on normalized
// name+price (not barcodes) and the submission row already exists — the
// import filed it at intake, so this updates it rather than inserting one.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { food_items, submissions, submitters, venues, type Submitter } from "../db/schema";
import type { Env } from "../env";
import { resolveSubmitter } from "../routes/submissions";
import { matchItems, normalizeItemName } from "./match";
import { recordVerification } from "./freshness";
import { notifyTrustedPublish } from "./notify";
import { PublishError } from "./publish";
import { recordRevision } from "./revisions";
import type { GmapsMenuSection } from "./gmaps-provider";

// Blast-radius cap — items per user per UTC day going live without review.
// The counted-insert counts ALL trusted-published items today (scan and
// import share the publish_mode='trusted' budget space), matching the
// semantics of SCAN_DAILY_ITEM_CAP.
const DEFAULT_DAILY_ITEM_CAP = 100;

export function gmapsItemCap(env: Env): number {
  const n = Number(env.GMAPS_DAILY_ITEM_CAP);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_ITEM_CAP;
}

export interface GmapsPublishResult {
  published: number;
  // Items that matched an existing live item — freshness re-verifications.
  matched: number;
  // Cap-overflow items filed into a pending_review submission (same row
  // when nothing published at all).
  review_submission_id: string | null;
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// Menu sections → DraftItem-shaped rows (item_type "dish" — Google menu
// items are venue dishes, not packaged products).
export function flattenSections(sections: GmapsMenuSection[]) {
  return sections.flatMap((section) =>
    section.items.map((item) => ({
      name: item.name,
      price_bnd: item.price,
      description: item.description,
      category: section.name,
      item_type: "dish" as const,
    })),
  );
}

async function bumpSubmitterCounts(db: Db, submitter: Submitter, filed: number, approved: number) {
  await db
    .update(submitters)
    .set({
      submissions_count: sql`${submitters.submissions_count} + ${filed}`,
      approved_count: sql`${submitters.approved_count} + ${approved}`,
    })
    .where(eq(submitters.id, submitter.id));
}

/**
 * Publish a structured-menu draft to a known venue without review. The
 * caller owns the venue-match decision (queue auto-match or the explicit
 * venue-attach endpoint); this function trusts it. `submissionId` is the
 * existing gmaps_link row — it flips to trusted_published, or to
 * pending_review when the daily cap means nothing could go live.
 */
export async function trustedPublishGmaps(
  db: Db,
  input: {
    userId: string;
    venueId: string;
    submissionId: string;
    sections: GmapsMenuSection[];
    googlePlaceId?: string;
  },
  env: Env,
): Promise<GmapsPublishResult> {
  const { userId, venueId, submissionId, googlePlaceId } = input;
  const items = flattenSections(input.sections);
  if (items.length === 0) {
    throw new PublishError(400, "no menu items to publish");
  }
  const now = new Date();
  const dayStart = utcDayStart(now);
  const cap = gmapsItemCap(env);

  // Name+price merge matching — a draft restating a live item is a
  // freshness re-verification, not a new row (same semantics as scan
  // re-scans).
  const existing = await db
    .select()
    .from(food_items)
    .where(
      and(
        eq(food_items.venue_id, venueId),
        eq(food_items.is_current, true),
        eq(food_items.status, "published"),
      ),
    );
  const suggestions = matchItems(
    items.map((i) => ({ ...i, item_type: "dish" as const })),
    existing,
  );

  const candidates: typeof items = [];
  const seen = new Set<string>();
  let matched = 0;
  for (const [i, item] of items.entries()) {
    const key = normalizeItemName(item.name);
    if (suggestions[i]?.existingItemId || seen.has(key)) {
      matched += 1;
      continue;
    }
    seen.add(key);
    candidates.push(item);
  }

  const { submitter, error } = await resolveSubmitter(db, { authUserId: userId });
  if (error) throw new PublishError(error.status, String(error.body.error ?? "submitter is blocked"));

  const overflow: typeof items = [];
  let published = 0;
  for (const [i, item] of candidates.entries()) {
    const id = crypto.randomUUID();
    // Atomic per-item cap — INSERT ... SELECT ... WHERE (count) < cap,
    // same pattern as scan items and check-ins. Counts all trusted items
    // this user published today regardless of source.
    const inserted = (await db.get(sql`
      INSERT INTO food_items (
        id, venue_id, item_type, name, description, price_bnd, category,
        source_submission_id, tags, is_current, pending_verification,
        status, created_at, updated_at
      )
      SELECT
        ${id}, ${venueId}, 'dish', ${item.name}, ${item.description ?? null},
        ${item.price_bnd ?? null}, ${item.category ?? null},
        ${submissionId}, '[]', 1, 1, 'published',
        ${now.getTime()}, ${now.getTime()}
      WHERE (
        SELECT count(*) FROM food_items fi
        JOIN submissions s ON fi.source_submission_id = s.id
        WHERE s.user_id = ${userId} AND s.publish_mode = 'trusted'
          AND fi.created_at >= ${dayStart.getTime()}
      ) < ${cap}
      RETURNING id
    `)) as Record<string, unknown> | undefined;
    if (!inserted) {
      overflow.push(item, ...candidates.slice(i + 1));
      break;
    }
    published += 1;
  }

  let reviewSubmissionId: string | null = null;
  if (published === 0) {
    // Nothing went live — this import row becomes the review row (the
    // cached draft is what the reviewer would see anyway).
    await db
      .update(submissions)
      .set({
        status: "pending_review",
        // Carry the draft AND the menu sections forward so a later
        // venue-attach can still publish from this row.
        raw_extraction: sql`json_set(
          COALESCE(${submissions.raw_extraction}, '{}'),
          '$.items', json(${JSON.stringify(items)}),
          '$.gmaps.sections', json(${JSON.stringify(input.sections)}))`,
      })
      .where(eq(submissions.id, submissionId));
    reviewSubmissionId = submissionId;
  } else {
    await db
      .update(submissions)
      .set({ status: "trusted_published", publish_mode: "trusted" })
      .where(eq(submissions.id, submissionId));

    if (overflow.length > 0) {
      const queuedId = crypto.randomUUID();
      await db.insert(submissions).values({
        id: queuedId,
        submitter_id: submitter?.id ?? null,
        user_id: userId,
        source_type: "gmaps_link",
        provenance: `gmaps overflow of ${submissionId}`,
        image_keys: [],
        raw_extraction: { items: overflow },
        auto_flags: ["trusted_cap_overflow"],
        status: "pending_review",
      });
      reviewSubmissionId = queuedId;
    }

    // Freshness semantics: a live publish vouches the menu is current and
    // graduates stubs — same bump a reviewer approve applies.
    await db
      .update(venues)
      .set({ last_verified_at: now, is_stub: false })
      .where(eq(venues.id, venueId));

    // Record the place id on the venue when we know it and it isn't
    // already claimed — future imports of the same place hard-match.
    if (googlePlaceId) {
      await db
        .update(venues)
        .set({ google_place_id: googlePlaceId })
        .where(and(eq(venues.id, venueId), isNull(venues.google_place_id)));
    }

    await recordRevision(db, {
      venueId,
      submissionId,
      reviewerId: "system",
      mode: "merge",
    });
  }

  if (matched > 0) {
    try {
      await recordVerification(db, venueId, userId, true);
    } catch (e) {
      // Same-day vote already landed — signal isn't lost.
      if (!(e instanceof Error) || !/unique/i.test(e.message)) throw e;
    }
  }

  if (submitter) {
    const submissionRows = (published > 0 ? 1 : 0) + (overflow.length > 0 && published > 0 ? 1 : 0);
    if (submissionRows > 0) {
      await bumpSubmitterCounts(db, submitter, submissionRows, published > 0 ? 1 : 0);
    }
  }

  // Trusted items went live without a reviewer — notify the reviewer pool
  // (best-effort; awaited so the send doesn't race a post-response freeze).
  if (published > 0) {
    const [venue] = await db
      .select({ name: venues.name })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    await notifyTrustedPublish(env, venue?.name ?? venueId, published);
  }

  return { published, matched, review_submission_id: reviewSubmissionId };
}
