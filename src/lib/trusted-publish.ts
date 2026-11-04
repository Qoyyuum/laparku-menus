import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  food_items,
  product_lookup_cache,
  submissions,
  submitters,
  venues,
  type Submitter,
} from "../db/schema";
import type { Env } from "../env";
import { resolveSubmitter } from "../routes/submissions";
import { recordVerification } from "./freshness";
import { notifyTrustedPublish } from "./notify";
import { normalizeBarcode } from "./product-lookup";
import { PublishError } from "./publish";
import { recordRevision } from "./revisions";

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
  // The trusted_published submission when ≥1 item went live, else null.
  submission_id: string | null;
  // The pending_review submission created for over-cap / unverifiable
  // items, else null — lets the client say "N queued for review".
  review_submission_id: string | null;
  published: number;
  queued: number;
  // Re-scans of barcodes already is_current at this venue: no duplicate
  // item, just a freshness re-verification (spec §7).
  stale_lookup: number;
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// Canonical storage form for a scanned code — same normalization the
// lookup chain applies to its cache keys, so dedup, storage and the merge
// matcher all compare one form (a GTIN-14 scan and a UPC-A scan of the
// same product are ONE row). Non-digit codes (Code 128/QR payloads) pass
// through trimmed.
function canonicalBarcode(barcode: string): string {
  return normalizeBarcode(barcode)?.code ?? barcode;
}

// Stored-barcode forms a pre-canonicalization row might carry: the code
// itself plus leading-zero GTIN paddings. Used only to *find* candidate
// duplicates — the comparison itself is done canonically in JS below.
function storedForms(canonical: string): string[] {
  const forms = [canonical];
  if (canonical.length < 13) forms.push(canonical.padStart(13, "0"));
  if (canonical.length < 14) forms.push(canonical.padStart(14, "0"));
  return forms;
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
  env: Env,
): Promise<ScanPublishResult> {
  const { userId, venueId, provenance } = input;
  // Normalize barcodes once at intake (canonical form — see
  // canonicalBarcode) — the dedup set, the lookup-cache check, the merge
  // matcher and the stored column all compare the same form, so " 123",
  // "123" and a GTIN-14 pad can't bypass dedup into duplicate rows.
  const items = input.items.map((i) => ({ ...i, barcode: canonicalBarcode(i.barcode.trim()) }));
  const now = new Date();
  const dayStart = utcDayStart(now);

  // Freshness dedup: barcodes already is_current at THIS venue re-verify
  // rather than duplicate (spec §7). The same barcode at a different venue
  // is a different menu row — correct — so the lookup is venue-scoped.
  // Existing rows may hold any stored form (canonical or a GTIN pad from
  // before canonical storage), so the fetch widens to those forms and the
  // comparison re-canonicalizes each row.
  const forms = [...new Set(items.flatMap((i) => storedForms(i.barcode)))];
  const current = new Set<string>(); // live barcodes at this venue, canonical
  for (let off = 0; off < forms.length; off += 90) {
    const rows = await db
      .select({ barcode: food_items.barcode })
      .from(food_items)
      .where(
        and(
          eq(food_items.venue_id, venueId),
          eq(food_items.is_current, true),
          eq(food_items.status, "published"),
          inArray(food_items.barcode, forms.slice(off, off + 90)),
        ),
      );
    for (const r of rows) if (r.barcode) current.add(canonicalBarcode(r.barcode.trim()));
  }

  const candidates: ScanItem[] = [];
  const seen = new Set<string>();
  let stale = 0;
  for (const item of items) {
    // Within the same batch a repeated barcode is also a re-scan — count it
    // stale rather than inserting a duplicate row from one request.
    if (current.has(item.barcode) || seen.has(item.barcode)) stale += 1;
    else {
      seen.add(item.barcode);
      candidates.push(item);
    }
  }

  // Trust gate: an item may skip review only if a provider actually
  // vouched for the code — it must declare ≥1 source tag AND the lookup
  // chain must have a `found` cache row for the barcode. Declaring tags
  // alone isn't enough (a client could claim "openfoodfacts" for
  // anything); the cache row is server-side proof the chain saw the code,
  // and its `sources` — not the client's tags — become the item's stored
  // provenance. The check runs against the code's normalized candidates
  // (canonical form + UPC-E expansion). Items failing either check aren't
  // rejected — they queue for review.
  const cacheKeysOf = (barcode: string): string[] =>
    normalizeBarcode(barcode)?.candidates ?? [barcode];
  // cache code → provider names that recognized it.
  const foundProviders = new Map<string, string[]>();
  const allKeys = [...new Set(candidates.flatMap((i) => cacheKeysOf(i.barcode)))];
  for (let off = 0; off < allKeys.length; off += 90) {
    const rows = await db
      .select({ code: product_lookup_cache.code, sources: product_lookup_cache.sources })
      .from(product_lookup_cache)
      .where(
        and(
          eq(product_lookup_cache.found, true),
          inArray(product_lookup_cache.code, allKeys.slice(off, off + 90)),
        ),
      );
    for (const r of rows) foundProviders.set(r.code, (r.sources ?? []).map((s) => s.provider));
  }

  const publishable: { item: ScanItem; providers: string[] }[] = [];
  const overflow: ScanItem[] = [];
  for (const item of candidates) {
    // Providers across every candidate key that hit — e.g. a code cached
    // under both its canonical and expanded forms merges provenance.
    const providers = [
      ...new Set(cacheKeysOf(item.barcode).flatMap((k) => foundProviders.get(k) ?? [])),
    ];
    if (item.source_tags.length > 0 && providers.length > 0) publishable.push({ item, providers });
    else overflow.push(item);
  }

  const { submitter, error } = await resolveSubmitter(db, { authUserId: userId });
  if (error) throw new PublishError(error.status, String(error.body.error ?? "submitter is blocked"));

  let trustedId: string | null = null;
  let published = 0;
  if (publishable.length > 0) {
    trustedId = crypto.randomUUID();
    // Created up-front so items can reference it; removed below if the
    // daily cap ate the whole batch. scan_barcode is the first code that
    // will actually publish — the batch head may have been stale.
    await db.insert(submissions).values({
      id: trustedId,
      submitter_id: submitter?.id ?? null,
      user_id: userId,
      source_type: "barcode",
      provenance,
      image_keys: [],
      auto_flags: [],
      status: "trusted_published",
      scan_barcode: publishable[0]!.item.barcode,
      publish_mode: "trusted",
    });

    for (const [i, entry] of publishable.entries()) {
      const { item, providers } = entry;
      const id = crypto.randomUUID();
      const offHit = providers.some((t) => OFF_FAMILY.has(t));
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
          1, 1, ${JSON.stringify(providers)}, 'published',
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
        overflow.push(item, ...publishable.slice(i + 1).map((e) => e.item));
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
      // Over-cap and unverifiable items keep their scan payload so
      // reviewers see exactly what would have published. item_type is set
      // explicitly — approve-time validation defaults a missing item_type
      // to "dish", which a scanned product is not. publish_mode stays NULL:
      // these items haven't reached the menu yet, so there is no mode.
      raw_extraction: {
        items: overflow.map((i) => ({ item_type: "product", ...i })),
      },
      auto_flags: [],
      status: "pending_review",
      scan_barcode: overflow[0]!.barcode,
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
    // Audit row, same shape publishSubmission writes — "system" stands in
    // for a human reviewer: the trusted path published this, honestly
    // recorded. Without it the submission falls out of every read that
    // reaches venues through venue_revisions (area/venue_type-filtered
    // contribution boards, pioneer badges). mode "merge" — the batch added
    // items without superseding anything.
    await recordRevision(db, {
      venueId,
      submissionId: trustedId!,
      reviewerId: "system",
      mode: "merge",
    });
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
  // publish counts as an approval (its items are live) while the queue
  // submission is just filed.
  if (submitter) {
    const submissionRows = (trustedId ? 1 : 0) + (queuedId ? 1 : 0);
    if (submissionRows > 0) {
      await bumpSubmitterCounts(db, submitter, submissionRows, trustedId ? 1 : 0);
    }
  }

  // Spec §6: trusted items went live without a reviewer — email the
  // reviewer/admin pool so the pending-verification queue gets eyes.
  // Best-effort (failures are swallowed inside); awaited like the approval
  // email in publish.ts so the send doesn't race a post-response freeze.
  if (published > 0) {
    const [venue] = await db
      .select({ name: venues.name })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    await notifyTrustedPublish(env, venue?.name ?? "a venue", published);
  }

  return {
    submission_id: trustedId,
    review_submission_id: queuedId,
    published,
    queued: overflow.length,
    stale_lookup: stale,
  };
}
