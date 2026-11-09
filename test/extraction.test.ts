import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { SOURCE_TYPES, submissions } from "../src/db/schema";
import type { Env } from "../src/env";
import {
  resetStubExtractor,
  setStubExtractor,
  type ExtractionDraft,
} from "../src/lib/extractor";
import { handleQueueBatch, processSubmission, type SubmissionMessage } from "../src/queue";
import { AI_GENERATED_PNG, MENU_PNG } from "./fixtures/images";

// The model is never invoked in tests — wrap env so EXTRACTOR selects the
// `stub` provider (Workers AI is a remote binding and can't run locally).
function stubEnv(): Env {
  return new Proxy(env, {
    get(target, prop) {
      if (prop === "EXTRACTOR") return "stub";
      return Reflect.get(target, prop);
    },
  }) as Env;
}

const NO_FOOD_DRAFT: ExtractionDraft = {
  has_food_content: false,
  confidence: 0.97,
  venue_guess: null,
  items: [],
  suspicion: [],
};

const MENU_DRAFT: ExtractionDraft = {
  has_food_content: true,
  confidence: 0.86,
  venue_guess: null,
  items: [
    { name: "Nasi Lemak", price_bnd: 3.5, category: "Rice", item_type: "dish" },
    { name: "Teh Tarik", price_bnd: 1.0, item_type: "dish" },
  ],
  suspicion: [],
};

async function seedSubmission(image: Uint8Array | null = MENU_PNG, sourceType: (typeof SOURCE_TYPES)[number] = "menu_photo", mime = "image/png"): Promise<string> {
  const id = crypto.randomUUID();
  const keys: string[] = [];
  if (image) {
    const key = `submissions/${id}/0`;
    await env.SUBMISSIONS.put(key, image, { httpMetadata: { contentType: mime } });
    keys.push(key);
  }
  await getDb(env)
    .insert(submissions)
    .values({
      id,
      source_type: sourceType,
      provenance: "photo of the physical menu",
      image_keys: keys,
      auto_flags: [],
      status: "pending",
    });
  return id;
}

async function getRow(id: string) {
  const [row] = await getDb(env).select().from(submissions).where(eq(submissions.id, id));
  return row;
}

afterEach(() => resetStubExtractor());

it("Review Focus #1: no food content → auto_rejected/no_food_content, R2 objects retained", async () => {
  setStubExtractor(NO_FOOD_DRAFT);
  const id = await seedSubmission();
  await processSubmission(stubEnv(), id);

  const row = await getRow(id);
  expect(row?.status).toBe("auto_rejected");
  expect(row?.rejection_reason).toBe("no_food_content");
  // Source bytes are kept in R2 — an auto-rejected submission is still evidence.
  expect(await env.SUBMISSIONS.get(`submissions/${id}/0`)).not.toBeNull();
});

it("PNG with a generator text chunk → auto_rejected/generator_signature, extractor never reached", async () => {
  let extractorCalls = 0;
  setStubExtractor(() => {
    extractorCalls++;
    return MENU_DRAFT;
  });
  const id = await seedSubmission(AI_GENERATED_PNG);
  await processSubmission(stubEnv(), id);

  const row = await getRow(id);
  expect(row?.status).toBe("auto_rejected");
  expect(row?.rejection_reason).toBe("generator_signature");
  expect(row?.auto_flags).toContain("generator_signature");
  // Forensics run before the model — conclusive signatures cost no AI calls.
  expect(extractorCalls).toBe(0);
});

it("happy path → draft stored in raw_extraction, confidence, status pending_review", async () => {
  setStubExtractor(MENU_DRAFT);
  const id = await seedSubmission();
  await processSubmission(stubEnv(), id);

  const row = await getRow(id);
  expect(row?.status).toBe("pending_review");
  expect(row?.rejection_reason).toBeNull();
  expect(row?.confidence).toBe(0.86);
  expect(row?.raw_extraction?.items).toHaveLength(2);
  expect((row?.raw_extraction?.items as { name: string }[])[0]?.name).toBe("Nasi Lemak");
  expect(row?.phash).toMatch(/^[0-9a-f]{16}$/);
  // venue_guess:null can't be verified against the venues table → flagged for
  // the bottom of the review queue. Flags never auto-reject.
  expect(row?.auto_flags).toContain("venue_unverified");
});

it("consumer invoked twice → second run no-ops (at-least-once delivery)", async () => {
  let extractorCalls = 0;
  setStubExtractor(() => {
    extractorCalls++;
    return MENU_DRAFT;
  });
  const id = await seedSubmission();
  const e = stubEnv();
  await processSubmission(e, id);
  await processSubmission(e, id);

  expect(extractorCalls).toBe(1);
  const row = await getRow(id);
  expect(row?.status).toBe("pending_review");
});

it("same image resubmitted → phash_dup flag, still pending_review (flags never auto-reject)", async () => {
  setStubExtractor(MENU_DRAFT);
  const e = stubEnv();
  const first = await seedSubmission();
  await processSubmission(e, first);
  const second = await seedSubmission();
  await processSubmission(e, second);

  const row = await getRow(second);
  expect(row?.phash).toBeTruthy();
  expect(row?.auto_flags).toContain("phash_dup");
  expect(row?.status).toBe("pending_review");
});

// Simulates a queue delivery: `attempts` mirrors Cloudflare's per-message
// counter; ack/retry are recorded so the test can assert which ran.
function fakeBatch(id: string, attempts: number) {
  const calls = { ack: 0, retry: 0 };
  const batch = {
    queue: "laparku-menus-submissions",
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    messages: [
      {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        body: { submissionId: id } satisfies SubmissionMessage,
        attempts,
        ack: () => calls.ack++,
        retry: () => calls.retry++,
      },
    ],
    retryAll: () => {},
    ackAll: () => {},
  } as unknown as MessageBatch<SubmissionMessage>;
  return { batch, calls };
}

it("final-attempt failure → auto_rejected/extraction_failed, acked not retried (no stranding)", async () => {
  setStubExtractor(() => {
    throw new Error("model blew up");
  });
  const id = await seedSubmission();
  const { batch, calls } = fakeBatch(id, 3); // attempts >= max_retries in wrangler.toml

  await handleQueueBatch(batch, stubEnv());

  expect(calls.ack).toBe(1);
  expect(calls.retry).toBe(0);
  const row = await getRow(id);
  expect(row?.status).toBe("auto_rejected");
  expect(row?.rejection_reason).toBe("extraction_failed");
});

it("earlier-attempt failure → retried, row stays pending", async () => {
  setStubExtractor(() => {
    throw new Error("model blew up");
  });
  const id = await seedSubmission();
  const { batch, calls } = fakeBatch(id, 1);

  await handleQueueBatch(batch, stubEnv());

  expect(calls.retry).toBe(1);
  expect(calls.ack).toBe(0);
  const row = await getRow(id);
  expect(row?.status).toBe("pending");
});

it("submission with no images (manual_entry/url) → pending_review without extraction", async () => {
  let extractorCalls = 0;
  setStubExtractor(() => {
    extractorCalls++;
    return MENU_DRAFT;
  });
  const id = await seedSubmission(null, "manual_entry");
  await processSubmission(stubEnv(), id);

  const row = await getRow(id);
  expect(row?.status).toBe("pending_review");
  expect(extractorCalls).toBe(0);
});

// A menu_pdf submission stores real files, but none of them are raster — the
// vision model has nothing to see, so the row must reach reviewers like the
// file-less path (they open the stored PDF via /api/admin/images/*) instead
// of feeding the model an empty prompt and eating an auto-reject.
it("PDF-only submission → pending_review without extraction", async () => {
  let extractorCalls = 0;
  setStubExtractor(() => {
    extractorCalls++;
    return NO_FOOD_DRAFT; // would auto_reject if reached — proves it's skipped
  });
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
  const id = await seedSubmission(PDF, "menu_pdf", "application/pdf");
  await processSubmission(stubEnv(), id);

  const row = await getRow(id);
  expect(row?.status).toBe("pending_review");
  expect(extractorCalls).toBe(0);
});
