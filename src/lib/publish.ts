import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  AREAS,
  food_items,
  HALAL_STATUSES,
  ITEM_TYPES,
  submissions,
  submitters,
  venues,
  VENUE_TYPES,
  type NewFoodItem,
  type Submission,
} from "../db/schema";
import type { DraftItem } from "./extractor";

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

// POST /api/admin/submissions/:id/approve body.
export interface PublishEdits {
  venue_id?: string;
  venue?: VenueDraft;
  items: DraftItem[];
}

export interface PublishResult {
  venue_id: string;
  items_published: number;
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
function validateItems(items: unknown): DraftItem[] {
  if (!Array.isArray(items)) throw new PublishError(400, "items must be an array");
  return items.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new PublishError(400, `items[${i}] must be an object`);
    }
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
  });
}

// Resolves the publish target: an existing venue (venue_id) or a new row
// created from the reviewer's draft. venue_id wins when both are present —
// the draft is then treated as stale UI state, not applied.
async function resolveVenue(db: Db, edits: PublishEdits): Promise<string> {
  if (edits.venue_id !== undefined) {
    const id = str(edits.venue_id);
    if (!id) throw new PublishError(400, "venue_id must be a non-empty string");
    const [venue] = await db.select({ id: venues.id }).from(venues).where(eq(venues.id, id)).limit(1);
    if (!venue) throw new PublishError(404, "venue not found");
    return venue.id;
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
  return venue!.id;
}

async function loadSubmission(db: Db, submissionId: string): Promise<Submission> {
  const [sub] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1);
  if (!sub) throw new PublishError(404, "submission not found");
  return sub;
}

// Approve a pending_review submission: resolve/create the venue, mark the
// venue's currently-live items superseded by this submission, insert the
// reviewer-edited items as published, and record the decision. The
// submission row and superseded items are kept — the item history is the
// audit trail.
//
// D1 has no interactive transactions, so ordering does the safety work:
// the row is *claimed* first (pending_review → approved is conditional, so
// two reviewers can't race a double-publish), then supersede → insert. Any
// publish failure rolls the claim back to pending_review so a retry works.
export async function publishSubmission(
  db: Db,
  submissionId: string,
  reviewerId: string,
  edits: PublishEdits,
): Promise<PublishResult> {
  const sub = await loadSubmission(db, submissionId);
  const items = validateItems(edits.items);

  const claimed = await db
    .update(submissions)
    .set({ status: "approved", reviewer_id: reviewerId })
    .where(and(eq(submissions.id, submissionId), eq(submissions.status, "pending_review")))
    .returning({ id: submissions.id });
  if (claimed.length === 0) {
    throw new PublishError(409, `submission is ${sub.status}, only pending_review can be decided`);
  }

  try {
    const venueId = await resolveVenue(db, edits);

    const superseded = await db
      .update(food_items)
      .set({ superseded_by: submissionId, status: "superseded" })
      .where(
        and(
          eq(food_items.venue_id, venueId),
          eq(food_items.status, "published"),
          isNull(food_items.superseded_by),
        ),
      )
      .returning({ id: food_items.id });

    const rows: NewFoodItem[] = items.map((item) => ({
      venue_id: venueId,
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
    }));
    if (rows.length > 0) await db.insert(food_items).values(rows);

    if (sub.submitter_id) {
      await db
        .update(submitters)
        .set({ approved_count: sql`${submitters.approved_count} + 1` })
        .where(eq(submitters.id, sub.submitter_id));
    }

    return { venue_id: venueId, items_published: rows.length, items_superseded: superseded.length };
  } catch (e) {
    // Roll the claim back — the venue/items published so far stay (the row
    // is reviewable again), but the submission must not sit at `approved`
    // when nothing was fully published.
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
