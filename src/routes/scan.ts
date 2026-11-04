import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { getDb } from "../db/client";
import { venues } from "../db/schema";
import type { Env } from "../env";
import { PublishError } from "../lib/publish";
import { trustedPublishScan, type ScanItem } from "../lib/trusted-publish";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";

const scanApi = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Same role set as every other write intake.
const SCAN_ROLES = ["submitter", "reviewer", "admin"];

// Server-side re-validation of the app-resolved scan payload (spec §3:
// the app submits lookup results; the worker never trusts their shape).
const scanItemSchema = z.object({
  // Trimming happens here at intake — the dedup set, lookup-cache check and
  // stored value all compare the normalized form (whitespace-only → 400).
  barcode: z.string().trim().min(1).max(64),
  name: z.string().min(1).max(500),
  brand: z.string().max(200).optional(),
  package_size: z.string().max(100).optional(),
  nutrition_estimate: z.record(z.string(), z.unknown()).optional(),
  // Which lookup providers supplied this item's data. The key is required;
  // [] parses fine but can never pass the trusted-publish gate (a provider
  // must have actually seen the code — see trustedPublishScan), so such
  // items queue for review rather than publish. Tags trim at intake.
  source_tags: z.array(z.string().trim().min(1).max(64)).max(20),
});
const scanSchema = z.object({
  venue_id: z.string().min(1),
  provenance: z.string().min(1).max(500),
  // 500 is a sane bound on one HTTP body; the daily trusted cap (100) is
  // enforced in trustedPublishScan, not here — overflow queues for review.
  items: z.array(scanItemSchema).min(1).max(500),
});

// POST /api/submissions/scan — JSON batch intake for the Scans tab. One
// venue, one provenance, N resolved items. Items whose barcode is already
// live at the venue count as freshness re-verifications (stale_lookup);
// items past the 100/day trusted cap queue into pending_review.
scanApi.post("/submissions/scan", rateLimit, requireAuth(SCAN_ROLES), async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "expected JSON body" }, 400);
  }
  const parsed = scanSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "invalid scan batch", issues: parsed.error.issues }, 400);
  }
  const { venue_id, provenance, items } = parsed.data;

  const db = getDb(c.env);
  // Scans attach to the public surface only — same published-venue rule as
  // check-ins and /verify.
  const [venue] = await db
    .select({ id: venues.id })
    .from(venues)
    .where(and(eq(venues.id, venue_id), eq(venues.status, "published")))
    .limit(1);
  if (!venue) return c.json({ error: "venue not found" }, 404);

  try {
    const result = await trustedPublishScan(db, {
      userId: c.get("user").id,
      venueId: venue.id,
      provenance,
      items: items as ScanItem[],
    });
    return c.json(result, 201);
  } catch (e) {
    if (e instanceof PublishError) {
      return c.json({ error: e.message }, e.status as ContentfulStatusCode);
    }
    throw e;
  }
});

export default scanApi;
