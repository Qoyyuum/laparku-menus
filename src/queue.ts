import { and, eq, isNotNull, ne } from "drizzle-orm";
import { getDb, schema } from "./db/client";
import type { Env } from "./env";
import {
  extractContent,
  MIN_EXTRACTION_CONFIDENCE,
  type ExtractionImage,
} from "./lib/extractor";
import { inspectImageMetadata } from "./lib/forensics";
import { processGmapsImport } from "./lib/gmaps-import";
import { computePHash, hammingDistance, PHASH_DUP_THRESHOLD } from "./lib/phash";

const { submissions, venues } = schema;

export interface SubmissionMessage {
  submissionId?: unknown;
}

// `suspicion` entries the extractor may name verbatim; anything else collapses
// to `extractor_suspicion`. `phash_dup`/`venue_unverified` are deliberately
// absent — deterministic flags must come from real checks, not model output.
const KNOWN_SUSPICION_FLAGS = new Set(["price_outlier", "extractor_suspicion"]);

// Must match [[queues.consumers]] max_retries in wrangler.toml — there is no
// dead-letter queue, so the final delivery must settle the row itself or it
// would strand in `pending` forever. Compared with >= so an attempt-count
// off-by-one can only cost one retry, never strand the row.
const QUEUE_MAX_RETRIES = 3;

// The extraction pipeline doubles as the content filter. Order follows the
// spec's "cheap checks first" rule: metadata forensics (conclusive, free) →
// pHash dedup (cheap) → vision model (the expensive step that also filters).
//
// Status transitions: pending → pending_review, or pending → auto_rejected
// with a rejection_reason. Only `generator_signature`, `no_food_content` and
// `low_confidence` auto-reject; every other flag only affects queue rank.
export async function processSubmission(env: Env, id: string): Promise<void> {
  const db = getDb(env);
  let [sub] = await db.select().from(submissions).where(eq(submissions.id, id)).limit(1);

  // Queue delivery is at-least-once — a retried or duplicated message must
  // not re-run extraction on an already-processed row.
  if (!sub || sub.status !== "pending") return;

  const flags = new Set(sub.auto_flags ?? []);

  // gmaps_link intake: the row was filed with only the link — the provider
  // chain resolves it here. "settled" means the import reached a terminal
  // or review state on its own; "photos" means downloaded images now wait
  // in R2 and the normal pipeline below reads them.
  if (sub.source_type === "gmaps_link" && (sub.image_keys ?? []).length === 0) {
    const outcome = await processGmapsImport(env, db, sub, flags);
    if (outcome === "settled") return;
    // The import may have rewritten the row (image_keys + the cached
    // provider payload the venue-hint fallback reads) — reload both.
    const [fresh] = await db
      .select({ image_keys: submissions.image_keys, raw_extraction: submissions.raw_extraction })
      .from(submissions)
      .where(eq(submissions.id, id))
      .limit(1);
    sub = { ...sub, image_keys: fresh?.image_keys ?? [], raw_extraction: fresh?.raw_extraction ?? null };
  }

  const images: ExtractionImage[] = [];
  for (const key of sub.image_keys ?? []) {
    const object = await env.SUBMISSIONS.get(key);
    if (!object) continue;
    images.push({
      key,
      bytes: await object.arrayBuffer(),
      mime: object.httpMetadata?.contentType ?? "application/octet-stream",
    });
  }

  // Nothing to inspect or extract — manual_entry text (items already sit in
  // raw_extraction) or file-less url submissions go straight to reviewers.
  if (images.length === 0) {
    await db
      .update(submissions)
      .set({ status: "pending_review", auto_flags: [...flags] })
      .where(eq(submissions.id, id));
    return;
  }

  // 1. Metadata forensics — conclusive generator signatures auto-reject
  //    before a cent is spent on the vision model.
  for (const image of images) {
    const { generatorSignature } = inspectImageMetadata(new Uint8Array(image.bytes));
    if (generatorSignature) {
      flags.add("generator_signature");
      await db
        .update(submissions)
        .set({
          status: "auto_rejected",
          rejection_reason: "generator_signature",
          auto_flags: [...flags],
        })
        .where(eq(submissions.id, id));
      return;
    }
  }

  // 2. pHash dedup against existing submissions. Undecodable files (PDFs)
  //    simply have no hash — never penalized for that.
  const phashes: string[] = [];
  for (const image of images) {
    if (!image.mime.startsWith("image/")) continue;
    try {
      phashes.push(await computePHash(new Uint8Array(image.bytes)));
    } catch {
      // undecodable image bytes — no hash contributes to dedup
    }
  }
  const phash = phashes[0] ?? null;
  if (phashes.length > 0) {
    const existing = await db
      .select({ phash: submissions.phash })
      .from(submissions)
      .where(and(ne(submissions.id, id), isNotNull(submissions.phash)));
    const isDup = phashes.some((hash) =>
      existing.some((row) => row.phash && hammingDistance(hash, row.phash) <= PHASH_DUP_THRESHOLD),
    );
    if (isDup) flags.add("phash_dup");
  }

  // 3. Vision-model extraction — doubles as the content filter.
  const draft = await extractContent(images, env);
  for (const tag of draft.suspicion ?? []) {
    flags.add(KNOWN_SUSPICION_FLAGS.has(tag) ? tag : "extractor_suspicion");
  }

  // Fail closed: missing/NaN confidence is treated as 0.
  const confidence =
    typeof draft.confidence === "number" && Number.isFinite(draft.confidence) ? draft.confidence : 0;

  if (!draft.has_food_content) {
    flags.add("no_food_content");
    await db
      .update(submissions)
      .set({
        status: "auto_rejected",
        rejection_reason: "no_food_content",
        raw_extraction: { ...(sub.raw_extraction?.gmaps ? { gmaps: sub.raw_extraction.gmaps } : {}), ...draft },
        confidence,
        phash,
        auto_flags: [...flags],
      })
      .where(eq(submissions.id, id));
    return;
  }
  if (confidence < MIN_EXTRACTION_CONFIDENCE) {
    flags.add("low_confidence");
    await db
      .update(submissions)
      .set({
        status: "auto_rejected",
        rejection_reason: "low_confidence",
        raw_extraction: { ...(sub.raw_extraction?.gmaps ? { gmaps: sub.raw_extraction.gmaps } : {}), ...draft },
        confidence,
        phash,
        auto_flags: [...flags],
      })
      .where(eq(submissions.id, id));
    return;
  }

  // Venue hint fallback for imported photos: when the vision model can't
  // guess the venue, the resolved Google place name is usually right.
  if (!draft.venue_guess && sub.source_type === "gmaps_link") {
    const gmapsName = sub.raw_extraction?.gmaps?.place?.name;
    if (gmapsName) draft.venue_guess = { name: gmapsName, type: "restaurant" };
  }

  // 4. Venue plausibility — a venue guess that matches nothing in the DB (or
  //    no guess at all) means provenance can't be verified → bottom of queue.
  if (!(await venueVerified(db, draft.venue_guess))) flags.add("venue_unverified");

  await db
    .update(submissions)
    .set({
      status: "pending_review",
      raw_extraction: { ...(sub.raw_extraction?.gmaps ? { gmaps: sub.raw_extraction.gmaps } : {}), ...draft },
      confidence,
      phash,
      auto_flags: [...flags],
    })
    .where(eq(submissions.id, id));
}

// A guess verifies if some venue name contains it or it contains a venue name
// (case-insensitive substring match either way handles "Warung XX" vs
// "Warung XX Serusop").
async function venueVerified(
  db: ReturnType<typeof getDb>,
  guess: { name: string } | null,
): Promise<boolean> {
  const name = guess?.name?.trim().toLowerCase();
  // <3 chars is too weak for a substring match either way.
  if (!name || name.length < 3) return false;
  const rows = await db.select({ name: venues.name }).from(venues);
  return rows.some((row) => {
    const known = row.name.trim().toLowerCase();
    return known.length >= 3 && (known.includes(name) || name.includes(known));
  });
}

// Last-chance settle for a submission whose extraction keeps throwing: reject
// it with a reviewable reason. Only touches rows still `pending` so a late
// retry can't clobber a row another delivery already processed.
async function markExtractionFailed(env: Env, id: string): Promise<void> {
  const db = getDb(env);
  await db
    .update(submissions)
    .set({ status: "auto_rejected", rejection_reason: "extraction_failed" })
    .where(and(eq(submissions.id, id), eq(submissions.status, "pending")));
}

export async function handleQueueBatch(
  batch: MessageBatch<SubmissionMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const id = message.body?.submissionId;
    if (typeof id !== "string") {
      message.ack(); // poison message — retrying can't fix a malformed body
      continue;
    }
    try {
      await processSubmission(env, id);
      message.ack();
    } catch (error) {
      console.error(`extraction failed for submission ${id}`, error);
      if (message.attempts >= QUEUE_MAX_RETRIES) {
        // Retries are exhausted — a deterministic failure must not strand
        // the row in `pending`; reject it and ack.
        await markExtractionFailed(env, id);
        message.ack();
      } else {
        message.retry();
      }
    }
  }
}
