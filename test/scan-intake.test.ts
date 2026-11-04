import { env, SELF } from "cloudflare:test";
import { and, eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { food_items, submissions, venues } from "../src/db/schema";
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
  };
}

function scan(body: unknown, cookie?: string) {
  return SELF.fetch("https://x/api/submissions/scan", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
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
  const body = (await res.json()) as {
    submission_id: string;
    published: number;
    queued: number;
    stale_lookup: number;
  };
  expect(body.published).toBe(2);
  expect(body.queued).toBe(0);
  expect(body.stale_lookup).toBe(0);
  expect(body.submission_id).toBeTruthy();

  const [sub] = await db().select().from(submissions).where(eq(submissions.id, body.submission_id));
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

// --- Review Focus #1: same-venue+barcode is_current → freshness bump ----------

it("a re-scan of a barcode already current at the venue bumps freshness, no duplicate", async () => {
  const venue = await seedVenue();
  const { cookie } = await forgeSession("submitter");
  const item = scanItem();

  const first = await scan({ venue_id: venue.id, provenance: "s1", items: [item] }, cookie);
  const firstBody = (await first.json()) as { published: number };
  expect(firstBody.published).toBe(1);

  // Re-scan same venue+barcode plus a new one.
  const second = await scan(
    { venue_id: venue.id, provenance: "s2", items: [scanItem({ barcode: item.barcode }), scanItem()] },
    cookie,
  );
  expect(second.status).toBe(201);
  const body = (await second.json()) as { published: number; stale_lookup: number };
  expect(body.stale_lookup).toBe(1);
  expect(body.published).toBe(1);

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

// --- Review Focus #3: 100 items/user/day cap → overflow pending_review ---------

it("items beyond the 100/day cap fall back to a pending_review submission", { timeout: 30000 }, async () => {
  const venue = await seedVenue();
  const { cookie, userId } = await forgeSession("submitter");
  const items = Array.from({ length: 105 }, () => scanItem());

  const res = await scan({ venue_id: venue.id, provenance: "shelf sweep", items }, cookie);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { published: number; queued: number };
  expect(body.published).toBe(100);
  expect(body.queued).toBe(5);

  // The 100 went live; the 5 wait in a normal pending_review submission.
  const live = await db()
    .select({ n: sql<number>`count(*)` })
    .from(food_items)
    .where(and(eq(food_items.venue_id, venue.id), eq(food_items.pending_verification, true)));
  expect(Number(live[0]!.n)).toBe(100);

  const [queued] = await db()
    .select()
    .from(submissions)
    .where(and(eq(submissions.user_id, userId), eq(submissions.status, "pending_review")));
  expect(queued).toBeTruthy();
  expect(queued!.publish_mode).toBe("reviewed");
  expect(queued!.raw_extraction?.items).toHaveLength(5);

  // A follow-up batch queues entirely — the daily budget is spent.
  const res2 = await scan({ venue_id: venue.id, provenance: "more", items: [scanItem()] }, cookie);
  const body2 = (await res2.json()) as { published: number; queued: number };
  expect(body2.published).toBe(0);
  expect(body2.queued).toBe(1);
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
  const body = (await res.json()) as { published: number; queued: number; stale_lookup: number };
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
