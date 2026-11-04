import { env, SELF } from "cloudflare:test";
import { and, eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import {
  food_items,
  product_lookup_cache,
  submissions,
  venue_revisions,
  venues,
} from "../src/db/schema";
import { normalizeBarcode } from "../src/lib/product-lookup";
import { forgeSession } from "./helpers/auth";

const db = () => getDb(env);

// --- fixtures ---------------------------------------------------------------

async function seedVenue() {
  const [v] = await db()
    .insert(venues)
    .values({ name: `Scan-${crypto.randomUUID().slice(0, 8)}`, type: "supermarket", area: "Brunei-Muara" })
    .returning();
  return v!;
}

// Distinct barcode per item index within a test — unique suffix keeps D1-persisted
// rows from earlier tests out of the freshness-dedup path.
let seq = 0;
function scanItem(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    barcode: `9550000${String(seq).padStart(6, "0")}`,
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
  items?: { barcode?: string; name?: string }[];
}

// POSTs the batch. Unless seedCache:false, every item's barcode is first
// seeded into product_lookup_cache (under the canonical code, like the
// real chain) as a found OFF hit — mirroring the real flow, where the app
// only submits items its /api/products/lookup resolved.
async function scan(body: ScanBody, cookie?: string, { seedCache = true } = {}) {
  if (seedCache && Array.isArray(body?.items)) {
    for (const it of body.items) {
      if (!it?.barcode) continue;
      const code = normalizeBarcode(String(it.barcode).trim())?.code ?? String(it.barcode).trim();
      await db()
        .insert(product_lookup_cache)
        .values({
          code,
          merged_payload: { name: it.name ?? "?" },
          sources: [{ provider: "openfoodfacts" }],
          found: true,
          fetched_at: new Date(),
        })
        .onConflictDoNothing();
    }
  }
  return SELF.fetch("https://x/api/submissions/scan", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

interface ScanResult {
  submission_id: string | null;
  review_submission_id: string | null;
  published: number;
  queued: number;
  stale_lookup: number;
}

// --- session gate ------------------------------------------------------------

it("POST /api/submissions/scan requires a session", async () => {
  const venue = await seedVenue();
  const res = await scan({ venue_id: venue.id, provenance: "Scanned at shop", items: [scanItem()] });
  expect(res.status).toBe(401);
});

// --- happy path: trusted publish ----------------------------------------------

it("found items publish trusted: submission + live pending_verification items", async () => {
  const venue = await seedVenue();
  const { cookie, userId } = await forgeSession("submitter");
  const items = [scanItem(), scanItem({ brand: "Other" })];

  const res = await scan({ venue_id: venue.id, provenance: "Scanned at shop", items }, cookie);
  expect(res.status).toBe(201);
  const body = (await res.json()) as ScanResult;
  expect(body.published).toBe(2);
  expect(body.queued).toBe(0);
  expect(body.stale_lookup).toBe(0);
  expect(body.submission_id).toBeTruthy();
  expect(body.review_submission_id).toBeNull();

  const [sub] = await db().select().from(submissions).where(eq(submissions.id, body.submission_id!));
  expect(sub).toBeTruthy();
  expect(sub!.status).toBe("trusted_published");
  expect(sub!.publish_mode).toBe("trusted");
  expect(sub!.source_type).toBe("barcode");
  expect(sub!.scan_barcode).toBe(items[0]!.barcode);
  expect(sub!.user_id).toBe(userId);

  const rows = await db()
    .select()
    .from(food_items)
    .where(and(eq(food_items.venue_id, venue.id), eq(food_items.source_submission_id, sub!.id)));
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.is_current).toBe(true);
    expect(row.status).toBe("published");
    expect(row.pending_verification).toBe(true);
    expect(row.item_type).toBe("product");
    expect(row.barcode_source).toEqual(["openfoodfacts"]);
  }
  const byBarcode = new Map(rows.map((r) => [r.barcode, r]));
  expect(byBarcode.get(items[0]!.barcode)?.name).toBe(items[0]!.name);
  expect(byBarcode.get(items[1]!.barcode)?.brand).toBe("Other");
  // OFF-family provenance wires the existing off_barcode linkage field.
  expect(byBarcode.get(items[0]!.barcode)?.off_barcode).toBe(items[0]!.barcode);
});

// --- trust gate: no provider provenance or no cache hit → review queue ---------

it("source_tags:[] routes the item to pending_review even with a cache hit", async () => {
  const venue = await seedVenue();
  const { cookie } = await forgeSession("submitter");
  // Cache-seeded (scan() seeds it) but no provider tags — nothing verified it.
  const res = await scan(
    { venue_id: venue.id, provenance: "s", items: [scanItem({ source_tags: [] })] },
    cookie,
  );
  const body = (await res.json()) as ScanResult;
  expect(body.published).toBe(0);
  expect(body.queued).toBe(1);
  expect(body.review_submission_id).toBeTruthy();

  const live = await db().select().from(food_items).where(eq(food_items.venue_id, venue.id));
  expect(live).toHaveLength(0);
});

it("a barcode with no product_lookup_cache hit routes to pending_review", async () => {
  const venue = await seedVenue();
  const { cookie } = await forgeSession("submitter");
  const res = await scan(
    { venue_id: venue.id, provenance: "s", items: [scanItem()] },
    cookie,
    { seedCache: false }, // tags claim OFF but the chain never saw this code
  );
  const body = (await res.json()) as ScanResult;
  expect(body.published).toBe(0);
  expect(body.queued).toBe(1);

  const live = await db().select().from(food_items).where(eq(food_items.venue_id, venue.id));
  expect(live).toHaveLength(0);
});

it("a cache-miss (found:false) barcode also fails the gate", async () => {
  const venue = await seedVenue();
  const { cookie } = await forgeSession("submitter");
  const item = scanItem();
  // The chain looked this code up and found nothing.
  await db().insert(product_lookup_cache).values({
    code: item.barcode,
    merged_payload: {},
    sources: [],
    found: false,
    fetched_at: new Date(),
  });
  const res = await scan({ venue_id: venue.id, provenance: "s", items: [item] }, cookie);
  const body = (await res.json()) as ScanResult;
  expect(body.published).toBe(0);
  expect(body.queued).toBe(1);
});

// --- Review Focus #1: same-venue+barcode is_current → freshness bump ----------

it("a re-scan of a barcode already current at the venue bumps freshness, no duplicate", async () => {
  const venue = await seedVenue();
  const { cookie } = await forgeSession("submitter");
  const item = scanItem();

  const first = await scan({ venue_id: venue.id, provenance: "s1", items: [item] }, cookie);
  const firstBody = (await first.json()) as ScanResult;
  expect(firstBody.published).toBe(1);

  // Re-scan same venue+barcode plus a new one. The batch head is stale, so
  // the submission's scan_barcode is the first *published* code.
  const fresh = scanItem();
  const second = await scan(
    { venue_id: venue.id, provenance: "s2", items: [scanItem({ barcode: item.barcode }), fresh] },
    cookie,
  );
  expect(second.status).toBe(201);
  const body = (await second.json()) as ScanResult;
  expect(body.stale_lookup).toBe(1);
  expect(body.published).toBe(1);
  const [sub2] = await db().select().from(submissions).where(eq(submissions.id, body.submission_id!));
  expect(sub2!.scan_barcode).toBe(fresh.barcode);

  // No duplicate: still exactly one item carrying that barcode at the venue.
  const dups = await db()
    .select()
    .from(food_items)
    .where(and(eq(food_items.venue_id, venue.id), eq(food_items.barcode, item.barcode)));
  expect(dups).toHaveLength(1);

  // Freshness bump: the re-scan counts as a positive verification.
  const [v] = await db().select().from(venues).where(eq(venues.id, venue.id));
  expect(v!.last_verified_at!.getTime()).toBeGreaterThan(Date.now() - 60_000);
});

it("barcode normalization: whitespace variants dedup instead of duplicating", async () => {
  const venue = await seedVenue();
  const { cookie } = await forgeSession("submitter");
  const item = scanItem();
  await scan({ venue_id: venue.id, provenance: "s1", items: [item] }, cookie);

  const res = await scan(
    { venue_id: venue.id, provenance: "s2", items: [scanItem({ barcode: `  ${item.barcode} ` })] },
    cookie,
  );
  const body = (await res.json()) as ScanResult;
  expect(body.stale_lookup).toBe(1);
  expect(body.published).toBe(0);

  const rows = await db()
    .select()
    .from(food_items)
    .where(eq(food_items.venue_id, venue.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.barcode).toBe(item.barcode);
});

it("a GTIN-14 scan of an already-live UPC-A dedups — canonical storage, one row", async () => {
  const venue = await seedVenue();
  const { cookie } = await forgeSession("submitter");
  // UPC-A "042100005264" ↔ GTIN-14 "0042100005264" — the same product.
  const upca = scanItem({ barcode: "042100005264" });
  await scan({ venue_id: venue.id, provenance: "s1", items: [upca] }, cookie);

  const res = await scan(
    { venue_id: venue.id, provenance: "s2", items: [scanItem({ barcode: "0042100005264" })] },
    cookie,
  );
  const body = (await res.json()) as ScanResult;
  expect(body.stale_lookup).toBe(1);
  expect(body.published).toBe(0);

  const rows = await db().select().from(food_items).where(eq(food_items.venue_id, venue.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.barcode).toBe("042100005264"); // canonical form stored
});

it("barcode_source + off_barcode come from the cache row's providers, not client tags", async () => {
  const venue = await seedVenue();
  const { cookie } = await forgeSession("submitter");
  const item = scanItem({ barcode: "042100006666", source_tags: [" madeup-store "] });
  // The chain saw this code through OFF + ean-search — the tag claim is noise.
  await db().insert(product_lookup_cache).values({
    code: item.barcode,
    merged_payload: { name: item.name },
    sources: [{ provider: "openfoodfacts" }, { provider: "eansearch" }],
    found: true,
    fetched_at: new Date(),
  });

  const res = await scan({ venue_id: venue.id, provenance: "s", items: [item] }, cookie);
  const body = (await res.json()) as ScanResult;
  expect(body.published).toBe(1);

  const [row] = await db()
    .select()
    .from(food_items)
    .where(and(eq(food_items.venue_id, venue.id), eq(food_items.barcode, item.barcode)));
  expect(row!.barcode_source).toEqual(["openfoodfacts", "eansearch"]);
  // OFF-family provider in the cache → the OFF linkage field is wired.
  expect(row!.off_barcode).toBe(item.barcode);
});

// --- revision audit: trusted publishes reach venue_revisions -------------------

it("a trusted publish writes a 'system' venue_revision; area-filtered boards count it", async () => {
  const venue = await seedVenue(); // Brunei-Muara
  const { cookie } = await forgeSession("submitter");
  const res = await scan({ venue_id: venue.id, provenance: "s", items: [scanItem()] }, cookie);
  const body = (await res.json()) as ScanResult;
  expect(body.submission_id).toBeTruthy();

  const [rev] = await db()
    .select()
    .from(venue_revisions)
    .where(eq(venue_revisions.submission_id, body.submission_id!));
  expect(rev).toBeTruthy();
  expect(rev!.venue_id).toBe(venue.id);
  expect(rev!.reviewer_id).toBe("system");

  // The contributions board joins through venue_revisions for area
  // filtering — without the row this publish silently dropped out.
  const board = await SELF.fetch(
    "https://x/api/leaderboards?kind=contributions&period=all&area=Brunei-Muara",
    { headers: { cookie } },
  );
  expect(board.status).toBe(200);
  const lb = (await board.json()) as { me: { rank: number; count: number } | null };
  expect(lb.me?.count).toBe(1);
});

// --- Review Focus #3: 100 items/user/day cap → overflow pending_review ---------

it("items beyond the 100/day cap fall back to a pending_review submission", { timeout: 30000 }, async () => {
  const venue = await seedVenue();
  const { cookie, userId } = await forgeSession("submitter");
  const items = Array.from({ length: 105 }, () => scanItem());

  const res = await scan({ venue_id: venue.id, provenance: "shelf sweep", items }, cookie);
  expect(res.status).toBe(201);
  const body = (await res.json()) as ScanResult;
  expect(body.published).toBe(100);
  expect(body.queued).toBe(5);
  expect(body.submission_id).toBeTruthy();
  expect(body.review_submission_id).toBeTruthy();

  // The 100 went live; the 5 wait in a normal pending_review submission.
  const live = await db()
    .select({ n: sql<number>`count(*)` })
    .from(food_items)
    .where(and(eq(food_items.venue_id, venue.id), eq(food_items.pending_verification, true)));
  expect(Number(live[0]!.n)).toBe(100);

  const [queued] = await db()
    .select()
    .from(submissions)
    .where(eq(submissions.id, body.review_submission_id!));
  expect(queued).toBeTruthy();
  expect(queued!.user_id).toBe(userId);
  // Nothing reached the menu through this row yet — publish_mode is NULL.
  expect(queued!.publish_mode).toBeNull();
  const queuedItems = queued!.raw_extraction?.items as { item_type?: string }[];
  expect(queuedItems).toHaveLength(5);
  // Approve-time default is "dish" — scan overflow must carry "product".
  expect(queuedItems.every((i) => i.item_type === "product")).toBe(true);

  // A follow-up batch queues entirely — the daily budget is spent.
  const res2 = await scan({ venue_id: venue.id, provenance: "more", items: [scanItem()] }, cookie);
  const body2 = (await res2.json()) as ScanResult;
  expect(body2.published).toBe(0);
  expect(body2.queued).toBe(1);
  expect(body2.submission_id).toBeNull();
});

// --- Review Focus #5: items are never silently dropped -------------------------

it("every submitted item lands somewhere: published, queued, or counted stale", async () => {
  const venue = await seedVenue();
  const { cookie } = await forgeSession("submitter");
  const existing = scanItem();
  await scan({ venue_id: venue.id, provenance: "s1", items: [existing] }, cookie);

  const res = await scan(
    {
      venue_id: venue.id,
      provenance: "s2",
      items: [scanItem({ barcode: existing.barcode }), scanItem(), scanItem()],
    },
    cookie,
  );
  const body = (await res.json()) as ScanResult;
  expect(body.published + body.queued + body.stale_lookup).toBe(3);
});

// --- validation ----------------------------------------------------------------

it("rejects malformed bodies with 400", async () => {
  const venue = await seedVenue();
  const { cookie } = await forgeSession("submitter");

  // Missing items, empty items, item without barcode/name, bad source_tags.
  expect((await scan({ venue_id: venue.id, provenance: "x" }, cookie)).status).toBe(400);
  expect((await scan({ venue_id: venue.id, provenance: "x", items: [] }, cookie)).status).toBe(400);
  expect(
    (await scan({ venue_id: venue.id, provenance: "x", items: [{ name: "No barcode" }] }, cookie)).status,
  ).toBe(400);
  expect(
    (await scan({ venue_id: venue.id, provenance: "x", items: [{ barcode: "123" }] }, cookie)).status,
  ).toBe(400);
  expect(
    (
      await scan(
        { venue_id: venue.id, provenance: "x", items: [scanItem({ source_tags: "off" })] },
        cookie,
      )
    ).status,
  ).toBe(400);
  expect((await scan({ provenance: "x", items: [scanItem()] }, cookie)).status).toBe(400);
  expect((await scan({ venue_id: venue.id, items: [scanItem()] }, cookie)).status).toBe(400);
  // Whitespace-only barcodes trim to empty → rejected, never stored.
  expect(
    (await scan({ venue_id: venue.id, provenance: "x", items: [scanItem({ barcode: "   " })] }, cookie)).status,
  ).toBe(400);
});

it("scan onto an unknown venue 404s", async () => {
  const { cookie } = await forgeSession("submitter");
  const res = await scan(
    { venue_id: crypto.randomUUID(), provenance: "x", items: [scanItem()] },
    cookie,
  );
  expect(res.status).toBe(404);
});

// --- badge fields on the public surface -----------------------------------------

it("GET /api/venues/:id/items exposes pending_verification and barcode", async () => {
  const venue = await seedVenue();
  const { cookie } = await forgeSession("submitter");
  const item = scanItem();
  await scan({ venue_id: venue.id, provenance: "s", items: [item] }, cookie);

  const res = await SELF.fetch(`https://x/api/venues/${venue.id}/items`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    items: { barcode: string; pending_verification: boolean; name: string }[];
  };
  const found = body.items.find((i) => i.barcode === item.barcode);
  expect(found).toBeTruthy();
  expect(found!.pending_verification).toBe(true);
});

// --- contribution counting (trusted_published counts as live content) ----------

it("a trusted publish counts as an approved contribution on /api/me", async () => {
  const venue = await seedVenue();
  const { cookie } = await forgeSession("submitter");
  await scan({ venue_id: venue.id, provenance: "s", items: [scanItem()] }, cookie);

  const res = await SELF.fetch("https://x/api/me", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { approved: number; submissions: number };
  expect(body.approved).toBe(1);
});
