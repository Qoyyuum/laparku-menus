import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { food_items, submissions, submitters, venues, type Submitter } from "../db/schema";
import { resolveSubmitter } from "../routes/submissions";
import { recordVerification } from "./freshness";
import { PublishError } from "./publish";

// Blast-radius cap for the trusted path (spec §5, plan Global Constraints):
// at most this many items per user per UTC day may go live without review.
// Overflow is never an error and never silently dropped — it lands in a
// normal pending_review submission instead.
export const SCAN_DAILY_ITEM_CAP = 100;

// Provider names that count as the OFF family — matches
// src/lib/product-lookup.ts (OFF_FAMILY). When one contributed the scan
// item's data, off_barcode links the item to the OFF record.
const OFF_FAMILY = new Set(["openfoodfacts", "openbeautyfacts", "openpetfoodfacts", "openproductsfacts"]);

// One validated scan-batch item (shape enforced by the route's Zod schema).
export interface ScanItem {
  barcode: string;
  name: string;
  brand?: string;
  package_size?: string;
  nutrition_estimate?: Record<string, unknown>;
  source_tags: string[];
}

export interface ScanPublishResult {
  // The trusted_published submission when ≥1 item went live, else the
  // pending_review overflow submission, else null (every item was stale).
  submission_id: string | null;
  published: number;
  queued: number;
  // Re-scans of barcodes already is_current at this venue: no duplicate
  // item, just a freshness re-verification (spec §7).
  stale_lookup: number;
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
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

// Trusted-publish a validated scan batch. Ordering mirrors the cap pattern
// in check-ins: the per-item INSERT ... SELECT ... WHERE (count) < cap
// evaluates the 100/day budget atomically with each write, so concurrent
// batches can't overshoot; the first item that fails the guard means the
// budget is spent and the remainder queues for review.
//
// D1 has no interactive transactions; the trusted submission row is created
// optimistically (items reference it) and deleted if the cap ate the whole
// batch, so an over-cap retry can't accumulate empty submissions.
export async function trustedPublishScan(
  db: Db,
  input: { userId: string; venueId: string; provenance: string; items: ScanItem[] },
): Promise<ScanPublishResult> {
  const { userId, venueId, provenance, items } = input;
  const now = new Date();
  const dayStart = utcDayStart(now);

  // Freshness dedup: barcodes already is_current at THIS venue re-verify
  // rather than duplicate (spec §7). The same barcode at a different venue
  // is a different menu row — correct — so the lookup is venue-scoped.
  const barcodes = [...new Set(items.map((i) => i.barcode))];
  const current = new Set<string>(); // live barcodes at this venue
  for (let off = 0; off < barcodes.length; off += 90) {
    const rows = await db
      .select({ barcode: food_items.barcode })
      .from(food_items)
      .where(
        and(
          eq(food_items.venue_id, venueId),
          eq(food_items.is_current, true),
          eq(food_items.status, "published"),
          inArray(food_items.barcode, barcodes.slice(off, off + 90)),
        ),
      );
    for (const r of rows) if (r.barcode) current.add(r.barcode);
  }

  const publishable: ScanItem[] = [];
  const seen = new Set<string>();
  let stale = 0;
  for (const item of items) {
    // Within the same batch a repeated barcode is also a re-scan — count it
    // stale rather than inserting a duplicate row from one request.
    if (current.has(item.barcode) || seen.has(item.barcode)) stale += 1;
    else {
      seen.add(item.barcode);
      publishable.push(item);
    }
  }

  const { submitter, error } = await resolveSubmitter(db, { authUserId: userId });
  if (error) throw new PublishError(error.status, String(error.body.error ?? "submitter is blocked"));

  let trustedId: string | null = null;
  let published = 0;
  const overflow: ScanItem[] = [];
  if (publishable.length > 0) {
    trustedId = crypto.randomUUID();
    // Created up-front so items can reference it; removed below if the
    // daily cap ate the whole batch.
    await db.insert(submissions).values({
      id: trustedId,
      submitter_id: submitter?.id ?? null,
      user_id: userId,
      source_type: "barcode",
      provenance,
      image_keys: [],
      auto_flags: [],
      status: "trusted_published",
      scan_barcode: items[0]!.barcode,
      publish_mode: "trusted",
    });

    for (const [i, item] of publishable.entries()) {
      const id = crypto.randomUUID();
      const offHit = item.source_tags.some((t) => OFF_FAMILY.has(t));
      // Atomic per-item cap — the same counted-insert pattern as check-ins
      // (INSERT ... SELECT ... WHERE (count) < cap). Counts food_items rows
      // created today whose source submission is a trusted publish by this
      // user, so the budget is per *item* per day, not per submission.
      const inserted = (await db.get(sql`
        INSERT INTO food_items (
          id, venue_id, item_type, name, brand, barcode, package_size,
          nutrition_estimate, off_barcode, source_submission_id, tags,
          is_current, pending_verification, barcode_source, status,
          created_at, updated_at
        )
        SELECT
          ${id}, ${venueId}, 'product', ${item.name}, ${item.brand ?? null},
          ${item.barcode}, ${item.package_size ?? null},
          ${item.nutrition_estimate ? JSON.stringify(item.nutrition_estimate) : null},
          ${offHit ? item.barcode : null}, ${trustedId}, '[]',
          1, 1, ${JSON.stringify(item.source_tags)}, 'published',
          ${now.getTime()}, ${now.getTime()}
        WHERE (
          SELECT count(*) FROM food_items fi
          JOIN submissions s ON fi.source_submission_id = s.id
          WHERE s.user_id = ${userId} AND s.publish_mode = 'trusted'
            AND fi.created_at >= ${dayStart.getTime()}
        ) < ${SCAN_DAILY_ITEM_CAP}
        RETURNING id
      `)) as Record<string, unknown> | undefined;
      if (!inserted) {
        // Budget spent — the count only grows, so this item and every
        // later one fall back to the normal review queue.
        overflow.push(item, ...publishable.slice(i + 1));
        break;
      }
      published += 1;
    }
  }

  let queuedId: string | null = null;
  if (overflow.length > 0) {
    queuedId = crypto.randomUUID();
    await db.insert(submissions).values({
      id: queuedId,
      submitter_id: submitter?.id ?? null,
      user_id: userId,
      source_type: "barcode",
      provenance,
      image_keys: [],
      // Over-cap items keep their scan payload so reviewers see exactly
      // what would have published (source_tags ride along for provenance).
      raw_extraction: { items: overflow },
      auto_flags: [],
      status: "pending_review",
      scan_barcode: overflow[0]!.barcode,
      publish_mode: "reviewed",
    });
  }

  // Nothing actually went live → the optimistic submission row is empty
  // provenance noise; remove it.
  if (trustedId && published === 0) {
    await db.delete(food_items).where(eq(food_items.source_submission_id, trustedId));
    await db.delete(submissions).where(eq(submissions.id, trustedId));
    trustedId = null;
  }

  // Freshness semantics: a live publish vouches the menu is current (same
  // bump a reviewer approve applies, including stub graduation), and each
  // re-scan of an already-live barcode is an "accurate" verification vote —
  // one call covers the batch (votes are per user/venue/day and a positive
  // one bumps venues.last_verified_at).
  if (published > 0) {
    await db
      .update(venues)
      .set({ last_verified_at: now, is_stub: false })
      .where(eq(venues.id, venueId));
  }
  if (stale > 0) {
    try {
      await recordVerification(db, venueId, userId, true);
    } catch (e) {
      // Same-day vote race — the vote already landed, signal isn't lost.
      if (!(e instanceof Error) || !/unique/i.test(e.message)) throw e;
    }
  }

  // Reputation bookkeeping: each submission row counts once; the trusted
  // publish counts as an approval (its items are live) while the over-cap
  // queue submission is just filed.
  if (submitter) {
    const submissionRows = (trustedId ? 1 : 0) + (queuedId ? 1 : 0);
    if (submissionRows > 0) {
      await bumpSubmitterCounts(db, submitter, submissionRows, trustedId ? 1 : 0);
    }
  }

  return {
    submission_id: trustedId ?? queuedId,
    published,
    queued: overflow.length,
    stale_lookup: stale,
  };
}
