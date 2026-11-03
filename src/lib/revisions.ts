import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { venue_revisions, type RevisionMode } from "../db/schema";

export interface RevisionInput {
  venueId: string;
  submissionId: string;
  reviewerId: string;
  mode: RevisionMode;
}

// Append the audit row for one approved publish. Every publishSubmission
// call writes exactly one — replace or merge — so venue history answers
// "which submission/reviewer produced this menu, and how".
export async function recordRevision(db: Db, input: RevisionInput): Promise<string> {
  const [row] = await db
    .insert(venue_revisions)
    .values({
      venue_id: input.venueId,
      submission_id: input.submissionId,
      reviewer_id: input.reviewerId,
      mode: input.mode,
    })
    .returning({ id: venue_revisions.id });
  return row!.id;
}

// Publish rollback: the revision a failed publish wrote is removed with the
// rest of its side effects so a retry doesn't double-record.
export async function clearRevisionsForSubmission(db: Db, submissionId: string): Promise<void> {
  await db.delete(venue_revisions).where(eq(venue_revisions.submission_id, submissionId));
}
