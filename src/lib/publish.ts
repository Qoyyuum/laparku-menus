import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  AREAS,
  food_items,
  HALAL_STATUSES,
  ITEM_TYPES,
  REVISION_MODES,
  submissions,
  submitters,
  venues,
  VENUE_TYPES,
  type NewFoodItem,
  type RevisionMode,
  type Submission,
} from "../db/schema";
import type { DraftItem } from "./extractor";
import { clearRevisionsForSubmission, recordRevision } from "./revisions";

// Thrown for caller-facing failures; `status` maps straight onto the HTTP
// response so routes don't re-derive it.
export class PublishError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

// Reviewer-supplied venue draft for approving into a brand-new venue row.
export interface VenueDraft {
  name: string;
  name_ms?: string;
  type?: string;
  area?: string;
  address?: string;
  instagram?: string;
  website?: string;
  halal_status?: string;
}

// A draft row the reviewer chose to add — the edited fields ride along (the
// review screen sends the reviewer's corrections, not the raw extraction);
// draft_index points back at the extraction draft it came from, for
// provenance in the merge UI.
export interface DraftItemSelection extends DraftItem {
  source: "draft";
  draft_index: number;
}

// An existing venue item the reviewer chose to keep through a merge.
export interface ExistingItemSelection {
  source: "existing";
  item_id: string;
}

// A selected publish item. v1 bodies sent plain DraftItem objects (no
// `source` key) — still accepted, each treated as a selected draft.
export type PublishItemSelection = DraftItem | DraftItemSelection | ExistingItemSelection;

// POST /api/admin/submissions/:id/approve body.
export interface PublishEdits {
  venue_id?: string;
  venue?: VenueDraft;
  // replace = v1 semantics (whole old menu superseded); merge = the
  // reviewer-selected set becomes the menu. Omitted → replace.
  mode?: RevisionMode;
  items: PublishItemSelection[];
}

export interface PublishResult {
  venue_id: string;
  revision_id: string;
  mode: RevisionMode;
  // New rows inserted from drafts.
  items_published: number;
  // Existing items kept current through a merge.
  items_kept: number;
  items_superseded: number;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function oneOf<const T extends readonly string[]>(v: unknown, allowed: T): T[number] | undefined {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T[number]) : undefined;
}

// Reviewer-edited items get a light sanity pass before they become the
// public menu — the vision model's draft shape is a suggestion, not a
// guarantee.
function validateDraftItem(raw: unknown, i: number): DraftItem {
  const item = raw as DraftItem;
  const name = str(item.name);
  if (!name) throw new PublishError(400, `items[${i}].name is required`);
  const itemType = oneOf(item.item_type, ITEM_TYPES) ?? "dish";
  if (item.item_type !== undefined && item.item_type !== null && !oneOf(item.item_type, ITEM_TYPES)) {
    throw new PublishError(400, `items[${i}].item_type must be one of ${ITEM_TYPES.join(", ")}`);
  }
  if (item.price_bnd !== undefined && item.price_bnd !== null) {
    if (typeof item.price_bnd !== "number" || !Number.isFinite(item.price_bnd) || item.price_bnd < 0) {
      throw new PublishError(400, `items[${i}].price_bnd must be a non-negative number`);
    }
  }
  return { ...item, name, item_type: itemType };
}

interface ParsedSelection {
  drafts: DraftItem[];
  existingIds: string[];
}

// Split the approve body's per-item selection into drafts-to-insert and
// existing-items-to-keep. Entries without a `source` key are v1-style plain
// draft items. Structural validation only — whether an `existing` id is
// actually a current item of the venue is checked post-claim against the DB.
function parseSelection(items: unknown, mode: RevisionMode): ParsedSelection {
  if (!Array.isArray(items)) throw new PublishError(400, "items must be an array");
  // An empty approve would silently supersede every live item (venue_id) or
  // create a permanently-empty published venue (draft). Emptying a menu is
  // not a supported action — reject with a different submission or flag it.
  if (items.length === 0) {
    throw new PublishError(400, "items must contain at least one item");
  }
  const drafts: DraftItem[] = [];
  const existingIds: string[] = [];
  for (const [i, raw] of items.entries()) {
    if (typeof raw !== "object" || raw === null) {
      throw new PublishError(400, `items[${i}] must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    if (entry.source === "existing") {
      // Keeping an existing item is meaningless under replace — the whole
      // old menu goes. Almost always a client bug; surface it as one.
      if (mode !== "merge") {
        throw new PublishError(400, `items[${i}]: {source:"existing"} requires mode "merge"`);
      }
      const itemId = str(entry.item_id);
      if (!itemId) throw new PublishError(400, `items[${i}].item_id is required`);
      if (!existingIds.includes(itemId)) existingIds.push(itemId);
      continue;
    }
    if (entry.source !== undefined && entry.source !== null && entry.source !== "draft") {
      throw new PublishError(400, `items[${i}].source must be "draft" or "existing"`);
    }
    if (entry.source === "draft") {
      const idx = entry.draft_index;
      if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) {
        throw new PublishError(400, `items[${i}].draft_index must be a non-negative integer`);
      }
    }
    drafts.push(validateDraftItem(raw, i));
  }
  return { drafts, existingIds };
}

// Resolves the publish target: an existing venue (venue_id) or a new row
// created from the reviewer's draft. venue_id wins when both are present —
// the draft is then treated as stale UI state, not applied. `created` marks
// rows this call inserted so a mid-publish rollback can remove them.
async function resolveVenue(db: Db, edits: PublishEdits): Promise<{ id: string; created: boolean }> {
  if (edits.venue_id !== undefined) {
    const id = str(edits.venue_id);
    if (!id) throw new PublishError(400, "venue_id must be a non-empty string");
    const [venue] = await db.select({ id: venues.id }).from(venues).where(eq(venues.id, id)).limit(1);
    if (!venue) throw new PublishError(404, "venue not found");
    return { id: venue.id, created: false };
  }
  if (!edits.venue) {
    throw new PublishError(400, "provide venue_id (existing venue) or venue (new venue draft)");
  }
  const draft = edits.venue;
  const name = str(draft.name);
  if (!name) throw new PublishError(400, "venue.name is required");
  const type = oneOf(draft.type, VENUE_TYPES);
  if (draft.type !== undefined && draft.type !== null && !type) {
    throw new PublishError(400, `venue.type must be one of ${VENUE_TYPES.join(", ")}`);
  }
  const area = oneOf(draft.area, AREAS);
  if (draft.area !== undefined && draft.area !== null && !area) {
    throw new PublishError(400, `venue.area must be one of ${AREAS.join(", ")}`);
  }
  const halal = oneOf(draft.halal_status, HALAL_STATUSES);
  if (draft.halal_status !== undefined && draft.halal_status !== null && !halal) {
    throw new PublishError(400, `venue.halal_status must be one of ${HALAL_STATUSES.join(", ")}`);
  }
  const [venue] = await db
    .insert(venues)
    .values({
      name,
      name_ms: str(draft.name_ms) ?? null,
      type: type ?? "restaurant",
      area: area ?? "Brunei-Muara",
      address: str(draft.address) ?? null,
      instagram: str(draft.instagram) ?? null,
      website: str(draft.website) ?? null,
      halal_status: halal ?? "unknown",
      verification: "unverified",
      status: "published",
    })
    .returning({ id: venues.id });
  return { id: venue!.id, created: true };
}

async function loadSubmission(db: Db, submissionId: string): Promise<Submission> {
  const [sub] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1);
  if (!sub) throw new PublishError(404, "submission not found");
  return sub;
}

// Approve a pending_review submission: resolve/create the venue, apply the
// reviewer's item selection as the venue's new current menu, supersede every
// current item the selection didn't keep, and record the decision + a
// venue_revisions row. The submission row and superseded items are kept —
// the item history is the audit trail.
//
// The selected set is exactly what becomes current: merge lets the reviewer
// name existing items to keep plus draft items to add; replace is the
// degenerate case (no keeps) and reproduces v1 wholesale-swap behavior.
// Dropped items are superseded, never deleted.
//
// D1 has no interactive transactions, so ordering does the safety work:
// the row is *claimed* first (pending_review → approved is conditional, so
// two reviewers can't race a double-publish), then validate-against-DB →
// supersede → insert → revision. Any publish failure rolls every step back
// so a retry works.
export async function publishSubmission(
  db: Db,
  submissionId: string,
  reviewerId: string,
  edits: PublishEdits,
): Promise<PublishResult> {
  const sub = await loadSubmission(db, submissionId);
  const mode = edits.mode === undefined ? "replace" : oneOf(edits.mode, REVISION_MODES);
  if (!mode) {
    throw new PublishError(400, `mode must be one of ${REVISION_MODES.join(", ")}`);
  }
  const selection = parseSelection(edits.items, mode);

  const claimed = await db
    .update(submissions)
    .set({ status: "approved", reviewer_id: reviewerId })
    .where(and(eq(submissions.id, submissionId), eq(submissions.status, "pending_review")))
    .returning({ id: submissions.id });
  if (claimed.length === 0) {
    throw new PublishError(409, `submission is ${sub.status}, only pending_review can be decided`);
  }

  let venue: { id: string; created: boolean } | undefined;
  let prevVerifiedAt: Date | null | undefined;
  try {
    venue = await resolveVenue(db, edits);
    // Approving a menu is itself a verification event — the reviewer just
    // confirmed the items are current — so publish bumps
    // venues.last_verified_at (same signal as a positive verify vote).
    // The prior value is kept for the rollback below.
    const [prior] = await db
      .select({ at: venues.last_verified_at })
      .from(venues)
      .where(eq(venues.id, venue.id))
      .limit(1);
    prevVerifiedAt = prior?.at ?? null;
    await db.update(venues).set({ last_verified_at: new Date() }).where(eq(venues.id, venue.id));

    // TODO(p2-task-6): stub + venue_request linkage — once those tables
    // land, approving onto a stub venue must clear venues.is_stub and mark
    // the matching open venue_request fulfilled. venue.id + submissionId
    // here are the hook point.

    // Load the venue's current menu once: the {source:"existing"} selection
    // must name only items in this set (no keeping another venue's item, no
    // resurrecting a dead row) — and its complement is the drop set below.
    const current = await db
      .select({ id: food_items.id })
      .from(food_items)
      .where(
        and(
          eq(food_items.venue_id, venue.id),
          eq(food_items.is_current, true),
          eq(food_items.status, "published"),
        ),
      );
    const keepIds = new Set(selection.existingIds);
    const bad = selection.existingIds.find((id) => !current.some((i) => i.id === id));
    if (bad) {
      throw new PublishError(400, `items: item ${bad} is not a current item of this venue`);
    }

    // Drop the current items the selection didn't keep — computed as an id
    // set rather than a `NOT IN (keep-ids)` clause because D1 caps a query
    // at ~100 bound parameters: a merge keeping ≥99 items (realistic for
    // supermarket/grocer menus, exactly where merge matters) would have
    // blown that cap binding one param per kept id. The UPDATE itself is
    // chunked for the same reason (a replace on a large venue drops all).
    const dropIds = current.map((i) => i.id).filter((id) => !keepIds.has(id));
    let supersededCount = 0;
    const DROP_CHUNK = 90; // + venue_id param stays under the 100-param cap
    for (let off = 0; off < dropIds.length; off += DROP_CHUNK) {
      const updated = await db
        .update(food_items)
        .set({ superseded_by: submissionId, status: "superseded", is_current: false })
        .where(
          and(
            eq(food_items.venue_id, venue.id),
            eq(food_items.is_current, true),
            eq(food_items.status, "published"),
            inArray(food_items.id, dropIds.slice(off, off + DROP_CHUNK)),
          ),
        )
        .returning({ id: food_items.id });
      supersededCount += updated.length;
    }

    const rows: NewFoodItem[] = selection.drafts.map((item) => ({
      venue_id: venue!.id,
      item_type: item.item_type,
      name: item.name,
      name_ms: str(item.name_ms) ?? null,
      description: str(item.description) ?? null,
      price_bnd: item.price_bnd ?? null,
      category: str(item.category) ?? null,
      nutrition_estimate: item.nutrition_estimate ?? null,
      brand: str(item.brand) ?? null,
      barcode: str(item.barcode) ?? null,
      source_submission_id: submissionId,
      status: "published",
      is_current: true,
    }));
    // Batched like the supersede above: each row binds 17 params, so ≥6
    // rows in one VALUES clause would overflow D1's ~100 bound-param cap —
    // and a real menu extraction routinely exceeds 6 draft items.
    const INSERT_CHUNK = 5; // 5×17 = 85 bound params
    for (let off = 0; off < rows.length; off += INSERT_CHUNK) {
      await db.insert(food_items).values(rows.slice(off, off + INSERT_CHUNK));
    }

    const revisionId = await recordRevision(db, {
      venueId: venue.id,
      submissionId,
      reviewerId,
      mode,
    });

    if (sub.submitter_id) {
      await db
        .update(submitters)
        .set({ approved_count: sql`${submitters.approved_count} + 1` })
        .where(eq(submitters.id, sub.submitter_id));
    }

    return {
      venue_id: venue.id,
      revision_id: revisionId,
      mode,
      items_published: rows.length,
      items_kept: selection.existingIds.length,
      items_superseded: supersededCount,
    };
  } catch (e) {
    // Undo everything this call did, newest first — otherwise a retry would
    // leave an empty published venue, pile up duplicate venue rows, and keep
    // the venue's real menu superseded in the meantime. Kept existing items
    // were never touched (their source_submission_id is an older
    // submission), so the delete only removes drafts this call inserted.
    await db.delete(food_items).where(eq(food_items.source_submission_id, submissionId));
    await db
      .update(food_items)
      .set({ superseded_by: null, status: "published", is_current: true })
      .where(eq(food_items.superseded_by, submissionId));
    await clearRevisionsForSubmission(db, submissionId);
    if (venue?.created) {
      await db.delete(venues).where(eq(venues.id, venue.id));
    } else if (venue && prevVerifiedAt !== undefined) {
      // Undo the verification bump — a failed publish vouches for nothing.
      // prevVerifiedAt stays undefined if the bump never ran (the select
      // above threw), in which case the stored value is already correct.
      await db
        .update(venues)
        .set({ last_verified_at: prevVerifiedAt })
        .where(eq(venues.id, venue.id));
    }
    await db
      .update(submissions)
      .set({ status: "pending_review", reviewer_id: null })
      .where(eq(submissions.id, submissionId));
    throw e;
  }
}

// Reject a pending_review submission with a reviewer-supplied reason
// (surfaced to the submitter and kept for abuse analysis).
export async function rejectSubmission(
  db: Db,
  submissionId: string,
  reviewerId: string,
  reason: string,
): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) throw new PublishError(400, "reason is required");
  const sub = await loadSubmission(db, submissionId);

  const claimed = await db
    .update(submissions)
    .set({ status: "rejected", rejection_reason: trimmed, reviewer_id: reviewerId })
    .where(and(eq(submissions.id, submissionId), eq(submissions.status, "pending_review")))
    .returning({ id: submissions.id });
  if (claimed.length === 0) {
    throw new PublishError(409, `submission is ${sub.status}, only pending_review can be decided`);
  }

  if (sub.submitter_id) {
    await db
      .update(submitters)
      .set({ rejected_count: sql`${submitters.rejected_count} + 1` })
      .where(eq(submitters.id, sub.submitter_id));
  }
}
