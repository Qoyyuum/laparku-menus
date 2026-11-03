import { env, SELF } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { food_items, submissions, venue_revisions, venues, type FoodItem } from "../src/db/schema";
import { matchItems } from "../src/lib/match";
import { forgeSession } from "./helpers/auth";

const db = () => getDb(env);

// --- fixtures ---------------------------------------------------------------

async function seedSubmission(items: unknown[] = [{ name: "Nasi Lemak", price_bnd: 2.5, item_type: "dish" }]) {
  const [row] = await db()
    .insert(submissions)
    .values({
      source_type: "menu_photo",
      provenance: "photo of the physical menu",
      status: "pending_review",
      confidence: 0.9,
      raw_extraction: {
        has_food_content: true,
        confidence: 0.9,
        venue_guess: { name: "Kedai Test", type: "restaurant" },
        items,
        suspicion: [],
      },
    })
    .returning();
  return row!;
}

// A venue whose `count` items are all live (is_current) — the "old menu" a
// publish revises. Items are named `<prefix> 0..n-1` at B$1.00; the test DB
// persists across tests in this file, so tests that search by name pass a
// unique prefix.
async function seedVenueWithMenu(count: number, prefix = "Item") {
  const [venue] = await db()
    .insert(venues)
    .values({ name: "Big Menu", type: "restaurant", area: "Brunei-Muara" })
    .returning();
  const origin = await seedSubmission();
  await db().update(submissions).set({ status: "approved" }).where(eq(submissions.id, origin.id));
  // Batched: a single multi-row insert overflows D1's 100-bound-param cap
  // (each row binds ~11 params).
  const items: (typeof food_items.$inferSelect)[] = [];
  const rows = Array.from({ length: count }, (_, i) => ({
    venue_id: venue!.id,
    item_type: "dish" as const,
    name: `${prefix} ${i}`,
    price_bnd: 1.0,
    source_submission_id: origin.id,
    is_current: true,
  }));
  for (let off = 0; off < rows.length; off += 5) {
    items.push(...(await db().insert(food_items).values(rows.slice(off, off + 5)).returning()));
  }
  return { venue: venue!, items, origin };
}

async function approve(id: string, cookie: string, body: unknown) {
  return SELF.fetch(`https://x/api/admin/submissions/${id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

const liveItems = (venueId: string) =>
  db().select().from(food_items).where(and(eq(food_items.venue_id, venueId), eq(food_items.is_current, true)));

// --- matchItems -------------------------------------------------------------

const fakeItem = (name: string, price_bnd: number | null): FoodItem =>
  ({ id: crypto.randomUUID(), name, price_bnd }) as FoodItem;

it("matchItems matches on normalized name + price within 20%", () => {
  const existing = [fakeItem("nasi katok", 1.6), fakeItem("Teh Tarik", 1.0)];
  const [sug] = matchItems([{ name: "Nasi Katok", price_bnd: 1.5, item_type: "dish" }], existing);
  expect(sug).toEqual({ draftIndex: 0, existingItemId: existing[0]!.id });
});

it("matchItems does not match when the price gap exceeds 20%", () => {
  const existing = [fakeItem("Nasi Katok", 3.0)];
  const [sug] = matchItems([{ name: "Nasi Katok", price_bnd: 1.5, item_type: "dish" }], existing);
  expect(sug).toEqual({ draftIndex: 0, existingItemId: null });
});

it("matchItems leaves drafts unmatched when no existing item shares the name", () => {
  const existing = [fakeItem("Nasi Katok", 1.5)];
  const [sug] = matchItems([{ name: "Ambuyat", price_bnd: 1.5, item_type: "dish" }], existing);
  expect(sug).toEqual({ draftIndex: 0, existingItemId: null });
});

// --- replace mode (v1 semantics) ----------------------------------------------

it("replace mode supersedes the old menu and keeps only the new items current", async () => {
  const { venue } = await seedVenueWithMenu(2);
  const sub = await seedSubmission();
  const { cookie, userId } = await forgeSession("reviewer");

  const res = await approve(sub.id, cookie, {
    venue_id: venue.id,
    mode: "replace",
    items: [
      { source: "draft", draft_index: 0, name: "Nasi Lemak", price_bnd: 2.5, item_type: "dish" },
      { source: "draft", draft_index: 1, name: "Teh O", price_bnd: 1.0, item_type: "dish" },
    ],
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items_published: number; items_superseded: number; items_kept: number };
  expect(body.items_published).toBe(2);
  expect(body.items_superseded).toBe(2);
  expect(body.items_kept).toBe(0);

  const live = await liveItems(venue.id);
  expect(live.map((i) => i.name).sort()).toEqual(["Nasi Lemak", "Teh O"]);

  const all = await db().select().from(food_items).where(eq(food_items.venue_id, venue.id));
  for (const old of all.filter((i) => i.name.startsWith("Item "))) {
    expect(old.status).toBe("superseded");
    expect(old.superseded_by).toBe(sub.id);
    expect(old.is_current).toBe(false);
  }

  // The revision records who did what.
  const [rev] = await db().select().from(venue_revisions).where(eq(venue_revisions.submission_id, sub.id));
  expect(rev?.venue_id).toBe(venue.id);
  expect(rev?.reviewer_id).toBe(userId);
  expect(rev?.mode).toBe("replace");
});

it("the v1 body shape (no mode, plain draft items) still publishes as replace", async () => {
  const { venue } = await seedVenueWithMenu(1);
  const sub = await seedSubmission();
  const { cookie } = await forgeSession("reviewer");

  const res = await approve(sub.id, cookie, {
    venue_id: venue.id,
    items: [{ name: "New Dish", price_bnd: 3.0, item_type: "dish" }],
  });
  expect(res.status).toBe(200);

  const live = await liveItems(venue.id);
  expect(live.map((i) => i.name)).toEqual(["New Dish"]);

  const [rev] = await db().select().from(venue_revisions).where(eq(venue_revisions.submission_id, sub.id));
  expect(rev?.mode).toBe("replace");
});

// --- merge mode (Review Focus #1) ----------------------------------------------

it("Review Focus #1: merging a 3-item draft into a 40-item venue keeps 38 + adds 3 → 41 current, 2 dropped", async () => {
  const { venue, items } = await seedVenueWithMenu(40);
  const sub = await seedSubmission();
  const { cookie, userId } = await forgeSession("reviewer");

  const kept = items.slice(0, 38);
  const dropped = items.slice(38);

  const res = await approve(sub.id, cookie, {
    venue_id: venue.id,
    mode: "merge",
    items: [
      ...kept.map((i) => ({ source: "existing", item_id: i.id })),
      { source: "draft", draft_index: 0, name: "Nasi Katok", price_bnd: 1.5, item_type: "dish" },
      { source: "draft", draft_index: 1, name: "Teh Tarik", price_bnd: 1.0, item_type: "dish" },
      { source: "draft", draft_index: 2, name: "Roti Canai", price_bnd: 1.2, item_type: "dish" },
    ],
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items_published: number; items_superseded: number; items_kept: number };
  expect(body.items_published).toBe(3);
  expect(body.items_kept).toBe(38);
  expect(body.items_superseded).toBe(2);

  const live = await liveItems(venue.id);
  expect(live).toHaveLength(41);
  const liveIds = new Set(live.map((i) => i.id));
  for (const k of kept) expect(liveIds.has(k.id)).toBe(true);
  for (const name of ["Nasi Katok", "Teh Tarik", "Roti Canai"]) {
    expect(live.map((i) => i.name)).toContain(name);
  }

  // The 2 unselected items were superseded — not deleted.
  const droppedRows = await db()
    .select()
    .from(food_items)
    .where(and(eq(food_items.venue_id, venue.id), eq(food_items.status, "superseded")));
  expect(droppedRows.map((i) => i.id).sort()).toEqual(dropped.map((i) => i.id).sort());
  for (const d of droppedRows) {
    expect(d.superseded_by).toBe(sub.id);
    expect(d.is_current).toBe(false);
  }

  const [rev] = await db().select().from(venue_revisions).where(eq(venue_revisions.submission_id, sub.id));
  expect(rev?.mode).toBe("merge");
  expect(rev?.reviewer_id).toBe(userId);
});

it("an existing item not selected stays readable via source_submission_id", async () => {
  const { venue, items, origin } = await seedVenueWithMenu(3);
  const sub = await seedSubmission();
  const { cookie } = await forgeSession("reviewer");

  const res = await approve(sub.id, cookie, {
    venue_id: venue.id,
    mode: "merge",
    items: [
      { source: "existing", item_id: items[0]!.id },
      { source: "existing", item_id: items[1]!.id },
      { source: "draft", draft_index: 0, name: "Extra", price_bnd: 2.0, item_type: "dish" },
    ],
  });
  expect(res.status).toBe(200);

  const [droppedItem] = await db().select().from(food_items).where(eq(food_items.id, items[2]!.id));
  expect(droppedItem?.status).toBe("superseded");
  expect(droppedItem?.superseded_by).toBe(sub.id);
  // Provenance intact: the row still says which submission created it.
  expect(droppedItem?.source_submission_id).toBe(origin.id);
  expect(droppedItem?.name).toBe("Item 2");
});

// --- selection validation ------------------------------------------------------

it("merge validation: existing item_id must be a current item of the target venue", async () => {
  const { venue } = await seedVenueWithMenu(1);
  const other = await seedVenueWithMenu(1);
  const sub = await seedSubmission();
  const { cookie } = await forgeSession("reviewer");

  const res = await approve(sub.id, cookie, {
    venue_id: venue.id,
    mode: "merge",
    items: [
      { source: "existing", item_id: other.items[0]!.id },
      { source: "draft", draft_index: 0, name: "X", item_type: "dish" },
    ],
  });
  expect(res.status).toBe(400);
  // The bad approve must not claim the submission or touch the menus.
  const [row] = await db().select().from(submissions).where(eq(submissions.id, sub.id));
  expect(row?.status).toBe("pending_review");
  expect(await liveItems(venue.id)).toHaveLength(1);
});

it("replace mode rejects {source:'existing'} selections and bogus mode values", async () => {
  const { venue, items } = await seedVenueWithMenu(1);
  const { cookie } = await forgeSession("reviewer");

  const sub1 = await seedSubmission();
  expect(
    (
      await approve(sub1.id, cookie, {
        venue_id: venue.id,
        mode: "replace",
        items: [{ source: "existing", item_id: items[0]!.id }],
      })
    ).status,
  ).toBe(400);

  const sub2 = await seedSubmission();
  expect(
    (
      await approve(sub2.id, cookie, {
        venue_id: venue.id,
        mode: "overwrite",
        items: [{ name: "X", item_type: "dish" }],
      })
    ).status,
  ).toBe(400);
});

// --- admin venue-items endpoint -------------------------------------------------

it("GET /api/admin/venues/:id/items returns only current items, reviewer-gated", async () => {
  const { venue, items } = await seedVenueWithMenu(2);
  // One already-dead item for contrast.
  await db()
    .insert(food_items)
    .values({
      venue_id: venue.id,
      item_type: "dish",
      name: "Dead Dish",
      status: "superseded",
      superseded_by: "old-sub",
      is_current: false,
    });

  expect((await SELF.fetch(`https://x/api/admin/venues/${venue.id}/items`)).status).toBe(401);

  const { cookie } = await forgeSession("reviewer");
  const res = await SELF.fetch(`https://x/api/admin/venues/${venue.id}/items`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: { id: string; name: string }[] };
  expect(body.items.map((i) => i.id).sort()).toEqual(items.map((i) => i.id).sort());
  expect(body.items.map((i) => i.name)).not.toContain("Dead Dish");

  expect(
    (await SELF.fetch(`https://x/api/admin/venues/${crypto.randomUUID()}/items`, { headers: { cookie } })).status,
  ).toBe(404);
});

// --- public read now follows is_current -----------------------------------------

it("public venue items and search list only is_current rows after a merge", async () => {
  const { venue, items } = await seedVenueWithMenu(3, "PubMerge");
  const sub = await seedSubmission();
  const { cookie } = await forgeSession("reviewer");

  await approve(sub.id, cookie, {
    venue_id: venue.id,
    mode: "merge",
    items: [
      { source: "existing", item_id: items[0]!.id },
      { source: "existing", item_id: items[1]!.id },
    ],
  });

  const res = await SELF.fetch(`https://x/api/venues/${venue.id}/items`);
  const body = (await res.json()) as { items: { name: string }[] };
  expect(body.items.map((i) => i.name).sort()).toEqual(["PubMerge 0", "PubMerge 1"]);

  const res2 = await SELF.fetch(`https://x/api/search?q=${encodeURIComponent("PubMerge 2")}`);
  const body2 = (await res2.json()) as { items: { name: string }[] };
  expect(body2.items).toHaveLength(0);
});
