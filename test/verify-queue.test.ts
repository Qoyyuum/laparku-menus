import { env, SELF } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import {
  food_items,
  product_lookup_cache,
  submissions,
  submitters,
  venues,
  type LookupProduct,
} from "../src/db/schema";
import { normalizeBarcode } from "../src/lib/product-lookup";
import { forgeSession } from "./helpers/auth";

const db = () => getDb(env);

// --- fixtures ---------------------------------------------------------------

async function seedVenue() {
  const [v] = await db()
    .insert(venues)
    .values({ name: `Verify-${crypto.randomUUID().slice(0, 8)}`, type: "supermarket", area: "Brunei-Muara" })
    .returning();
  return v!;
}

let seq = 0;
function scanItem(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    barcode: `9551000${String(seq).padStart(6, "0")}`,
    name: `Scanned Product ${seq}`,
    brand: "TestBrand",
    package_size: "100g",
    source_tags: ["openfoodfacts"],
    ...overrides,
  } as { barcode: string; name: string; source_tags: string[] } & Record<string, unknown>;
}

interface ScanBody {
  venue_id?: string;
  provenance?: string;
  items?: Record<string, unknown>[];
}

// Same contract as the app's Scans tab: only barcodes the lookup chain
// resolved (a found cache row) may trusted-publish, so every item's code is
// seeded into product_lookup_cache first — with a caller-supplied merged
// payload when the test wants lookup-vs-item deltas to assert on.
async function scan(
  body: ScanBody,
  cookie: string,
  { cachePayload }: { cachePayload?: (it: Record<string, unknown>) => LookupProduct } = {},
) {
  for (const it of body.items ?? []) {
    const code = normalizeBarcode(String(it.barcode))?.code ?? String(it.barcode);
    await db()
      .insert(product_lookup_cache)
      .values({
        code,
        merged_payload: cachePayload?.(it) ?? { name: String(it.name ?? "?") },
        sources: [{ provider: "openfoodfacts", url: "https://world.openfoodfacts.org/product/x" }],
        found: true,
        fetched_at: new Date(),
      })
      .onConflictDoNothing();
  }
  return SELF.fetch("https://x/api/submissions/scan", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

interface ScanResult {
  submission_id: string | null;
  review_submission_id: string | null;
  published: number;
  queued: number;
  stale_lookup: number;
}

interface QueueRow {
  id: string;
  name: string;
  barcode: string | null;
  venue_id: string;
  venue_name: string;
  pending_verification: boolean;
  submission: { id: string; publish_mode: string | null; submitter_id: string | null } | null;
  lookup: { code: string; merged_payload: LookupProduct; sources: { provider: string }[]; found: boolean }[];
  overrides: Record<string, { lookup: unknown; submitted: unknown }>;
}

const queue = (cookie: string) =>
  SELF.fetch("https://x/api/admin/pending-verification", { headers: { cookie } });

const verify = (id: string, cookie: string, body?: unknown) =>
  SELF.fetch(`https://x/api/admin/items/${id}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const unpublish = (id: string, cookie: string, body?: unknown) =>
  SELF.fetch(`https://x/api/admin/items/${id}/unpublish`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

// Trusted-publishes one scan item and returns its live food_items row.
async function trustedItem(overrides: Record<string, unknown> = {}, cachePayload?: (it: Record<string, unknown>) => LookupProduct) {
  const venue = await seedVenue();
  const { cookie, userId } = await forgeSession("submitter");
  const item = scanItem(overrides);
  const res = await scan({ venue_id: venue.id, provenance: "shelf", items: [item] }, cookie, { cachePayload });
  const body = (await res.json()) as ScanResult;
  expect(body.published).toBe(1);
  const [row] = await db()
    .select()
    .from(food_items)
    .where(and(eq(food_items.venue_id, venue.id), eq(food_items.barcode, item.barcode)));
  return { venue, submitterUserId: userId, item, row: row!, submissionId: body.submission_id! };
}

// --- role gate ---------------------------------------------------------------

it("all three routes reject non-reviewers: 401 anonymous, 403 submitter", async () => {
  const id = crypto.randomUUID();
  expect((await SELF.fetch("https://x/api/admin/pending-verification")).status).toBe(401);
  const { cookie: submitter } = await forgeSession("submitter");
  expect((await queue(submitter)).status).toBe(403);
  expect((await verify(id, submitter)).status).toBe(403);
  expect((await unpublish(id, submitter)).status).toBe(403);
});

// --- GET /api/admin/pending-verification --------------------------------------

it("GET returns only live pending_verification items, newest-first, with venue + submission + lookup provenance", async () => {
  const { cookie: reviewer } = await forgeSession("reviewer");

  // Two trusted items at two venues. created_at is pinned after publish so
  // the newest-first assertion never flakes on same-ms timestamps.
  const older = await trustedItem({}, () => ({ name: "OFF Older", brand: "TestBrand" }));
  const newer = await trustedItem(
    { name: "Submitter Renamed", package_size: "500g" },
    () => ({ name: "OFF Original", brand: "TestBrand", package_size: "300g" }),
  );
  await db().update(food_items).set({ created_at: new Date(Date.now() - 60_000) }).where(eq(food_items.id, older.row.id));
  await db().update(food_items).set({ created_at: new Date() }).where(eq(food_items.id, newer.row.id));

  // Excluded rows: a plain reviewer-published item (no badge) and a
  // pending-flagged item that is already off the public menu.
  await db().insert(food_items).values({
    venue_id: older.venue.id,
    item_type: "product",
    name: "Normal Item",
    barcode: "1111111111111",
    is_current: true,
    pending_verification: false,
    status: "published",
  });
  await db().insert(food_items).values({
    venue_id: older.venue.id,
    item_type: "product",
    name: "Hidden Pending",
    barcode: "2222222222222",
    is_current: false,
    pending_verification: true,
    status: "hidden",
  });

  const res = await queue(reviewer);
  expect(res.status).toBe(200);
  const { items } = (await res.json()) as { items: QueueRow[] };
  const ours = items.filter((i) => [older.row.id, newer.row.id, "Normal Item", "Hidden Pending"].includes(i.id) || ["Normal Item", "Hidden Pending"].includes(i.name));
  const ids = items.map((i) => i.id);
  expect(ids).toContain(older.row.id);
  expect(ids).toContain(newer.row.id);
  expect(ours.every((i) => i.pending_verification)).toBe(true);
  // The two excluded rows never appear.
  expect(items.some((i) => i.name === "Normal Item")).toBe(false);
  expect(items.some((i) => i.name === "Hidden Pending")).toBe(false);
  // Newest first.
  expect(ids.indexOf(newer.row.id)).toBeLessThan(ids.indexOf(older.row.id));

  const row = items.find((i) => i.id === newer.row.id)!;
  expect(row.venue_id).toBe(newer.venue.id);
  expect(row.venue_name).toBe(newer.venue.name);
  expect(row.submission?.id).toBe(newer.submissionId);
  expect(row.submission?.publish_mode).toBe("trusted");
  expect(row.submission?.submitter_id).toBeTruthy();
  // Lookup provenance: the cache row's merged payload + sources ride along.
  expect(row.lookup.length).toBeGreaterThan(0);
  expect(row.lookup[0]!.merged_payload.name).toBe("OFF Original");
  expect(row.lookup[0]!.sources[0]!.provider).toBe("openfoodfacts");
  // Submitter overrides: the lookup said "OFF Original"/"300g", the item
  // went live as "Submitter Renamed"/"500g" — the deltas are exposed.
  expect(row.overrides.name).toEqual({ lookup: "OFF Original", submitted: "Submitter Renamed" });
  expect(row.overrides.package_size).toEqual({ lookup: "300g", submitted: "500g" });
  // brand matched the lookup — not an override.
  expect(row.overrides.brand).toBeUndefined();
});

// --- POST /api/admin/items/:id/verify ------------------------------------------

it("verify clears pending_verification and the public badge", async () => {
  const { cookie: reviewer } = await forgeSession("reviewer");
  const t = await trustedItem();

  const res = await verify(t.row.id, reviewer);
  expect(res.status).toBe(200);

  const [row] = await db().select().from(food_items).where(eq(food_items.id, t.row.id));
  expect(row!.pending_verification).toBe(false);
  expect(row!.is_current).toBe(true);
  expect(row!.status).toBe("published");

  // The public item payload no longer carries the badge …
  const pub = await SELF.fetch(`https://x/api/venues/${t.venue.id}/items`);
  const { items: pubItems } = (await pub.json()) as { items: { id: string; pending_verification: boolean }[] };
  expect(pubItems.find((i) => i.id === t.row.id)!.pending_verification).toBe(false);
  // … and the item drops out of the reviewer queue.
  const { items } = (await (await queue(reviewer)).json()) as { items: QueueRow[] };
  expect(items.some((i) => i.id === t.row.id)).toBe(false);
});

it("verify flips nutrition_estimate.status to verified when asked", async () => {
  const { cookie: reviewer } = await forgeSession("reviewer");
  const t = await trustedItem({ nutrition_estimate: { status: "estimated", calories_kcal: 250 } });

  const res = await verify(t.row.id, reviewer, { verify_nutrition: true });
  expect(res.status).toBe(200);

  const [row] = await db().select().from(food_items).where(eq(food_items.id, t.row.id));
  expect(row!.nutrition_estimate?.status).toBe("verified");
  expect(row!.nutrition_estimate?.calories_kcal).toBe(250);
});

it("verify is idempotent — a second verify returns 200, not an error", async () => {
  const { cookie: reviewer } = await forgeSession("reviewer");
  const t = await trustedItem();
  expect((await verify(t.row.id, reviewer)).status).toBe(200);
  expect((await verify(t.row.id, reviewer)).status).toBe(200);
});

// --- POST /api/admin/items/:id/unpublish ---------------------------------------

it("unpublish hides the item, rejects the source submission, and dents submitter reputation", async () => {
  const { cookie: reviewer, userId: reviewerId } = await forgeSession("reviewer");
  const t = await trustedItem();

  // The trusted publish already credited the submitter an approval.
  const [before] = await db().select().from(submitters).where(eq(submitters.auth_user_id, t.submitterUserId));
  expect(before!.approved_count).toBe(1);

  const res = await unpublish(t.row.id, reviewer, { reason: "wrong product for this barcode" });
  expect(res.status).toBe(200);

  const [row] = await db().select().from(food_items).where(eq(food_items.id, t.row.id));
  expect(row!.is_current).toBe(false);
  expect(row!.status).toBe("hidden");
  expect(row!.pending_verification).toBe(false);

  const [sub] = await db().select().from(submissions).where(eq(submissions.id, t.submissionId));
  expect(sub!.status).toBe("rejected");
  expect(sub!.reviewer_id).toBe(reviewerId);
  expect(sub!.rejection_reason).toBe("wrong product for this barcode");

  // A rejected trusted publish nets like a plain rejection: the approval
  // credit is clawed back AND the rejection counts.
  const [s] = await db().select().from(submitters).where(eq(submitters.auth_user_id, t.submitterUserId));
  expect(s!.rejected_count).toBe(1);
  expect(s!.approved_count).toBe(0);

  // Off the public menu and out of the queue.
  const pub = await SELF.fetch(`https://x/api/venues/${t.venue.id}/items`);
  const { items: pubItems } = (await pub.json()) as { items: { id: string }[] };
  expect(pubItems.some((i) => i.id === t.row.id)).toBe(false);
  const { items } = (await (await queue(reviewer)).json()) as { items: QueueRow[] };
  expect(items.some((i) => i.id === t.row.id)).toBe(false);

  // A second unpublish is a conflict, not a silent no-op — and it must not
  // double-decrement the submitter's reputation.
  expect((await unpublish(t.row.id, reviewer)).status).toBe(409);
  const [s2] = await db().select().from(submitters).where(eq(submitters.auth_user_id, t.submitterUserId));
  expect(s2!.rejected_count).toBe(1);
  expect(s2!.approved_count).toBe(0);
});

it("unpublish floors approved_count at 0 — an already-zero counter can't go negative", async () => {
  const { cookie: reviewer } = await forgeSession("reviewer");
  const t = await trustedItem();

  // Simulate a counter correction elsewhere (e.g. a prior unpublish of a
  // different submission already zeroed it — the decrement must floor).
  await db()
    .update(submitters)
    .set({ approved_count: 0 })
    .where(eq(submitters.auth_user_id, t.submitterUserId));

  expect((await unpublish(t.row.id, reviewer)).status).toBe(200);
  const [s] = await db().select().from(submitters).where(eq(submitters.auth_user_id, t.submitterUserId));
  expect(s!.approved_count).toBe(0);
  expect(s!.rejected_count).toBe(1);
});

// --- 404s ----------------------------------------------------------------------

it("verify and unpublish on an unknown item id return 404", async () => {
  const { cookie: reviewer } = await forgeSession("reviewer");
  const missing = crypto.randomUUID();
  expect((await verify(missing, reviewer)).status).toBe(404);
  expect((await unpublish(missing, reviewer)).status).toBe(404);
});
