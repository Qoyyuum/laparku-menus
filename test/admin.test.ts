import { env, SELF } from "cloudflare:test";
import { and, eq, isNull } from "drizzle-orm";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { food_items, submissions, submitters, venues } from "../src/db/schema";
import { forgeSession } from "./helpers/auth";

const db = () => getDb(env);

interface SeedSubOpts {
  status?: (typeof submissions.$inferInsert)["status"];
  submitterId?: string;
  confidence?: number;
  autoFlags?: string[];
  imageKeys?: string[];
  items?: unknown[];
}

// A submission already through the extraction pipeline: pending_review with a
// raw_extraction draft the reviewer can edit/approve.
async function seedSubmission(opts: SeedSubOpts = {}) {
  const [row] = await db()
    .insert(submissions)
    .values({
      source_type: "menu_photo",
      provenance: "photo of the physical menu",
      status: opts.status ?? "pending_review",
      submitter_id: opts.submitterId ?? null,
      confidence: opts.confidence ?? 0.9,
      auto_flags: opts.autoFlags ?? [],
      image_keys: opts.imageKeys ?? [],
      raw_extraction: {
        has_food_content: true,
        confidence: opts.confidence ?? 0.9,
        venue_guess: { name: "Kedai Test", type: "restaurant" },
        items: opts.items ?? [{ name: "Nasi Lemak", price_bnd: 2.5, item_type: "dish" }],
        suspicion: [],
      },
    })
    .returning();
  return row!;
}

async function seedSubmitter(trustTier: "anonymous" | "new" | "trusted") {
  const [row] = await db().insert(submitters).values({ trust_tier: trustTier }).returning();
  return row!;
}

async function approve(id: string, cookie: string, body: unknown) {
  return SELF.fetch(`https://x/api/admin/submissions/${id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function reject(id: string, cookie: string, body: unknown) {
  return SELF.fetch(`https://x/api/admin/submissions/${id}/reject`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

// --- queue list ------------------------------------------------------------

it("GET /api/admin/submissions sorts trusted submitters first, then confidence DESC, and includes auto_flags", async () => {
  const anon = await seedSubmitter("anonymous");
  const trusted = await seedSubmitter("trusted");
  // Trusted-but-low-confidence must outrank anonymous-high-confidence.
  await seedSubmission({ submitterId: trusted.id, confidence: 0.4, autoFlags: ["venue_unverified"] });
  await seedSubmission({ submitterId: anon.id, confidence: 0.95, autoFlags: [] });
  await seedSubmission({ confidence: 0.7, autoFlags: ["phash_dup"] });
  // Decided submissions never appear in the review queue.
  await seedSubmission({ status: "approved" });
  await seedSubmission({ status: "auto_rejected" });

  const { cookie } = await forgeSession("reviewer");
  const res = await SELF.fetch("https://x/api/admin/submissions?status=pending_review", {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const { submissions: list } = (await res.json()) as { submissions: { id: string; confidence: number; auto_flags: string[]; submitter_trust_tier: string | null }[] };
  expect(list).toHaveLength(3);
  expect(list[0]!.submitter_trust_tier).toBe("trusted");
  expect(list[0]!.confidence).toBe(0.4);
  expect(list[0]!.auto_flags).toContain("venue_unverified");
  // Remaining two are anonymous-tier: confidence DESC.
  expect(list[1]!.confidence).toBe(0.95);
  expect(list[2]!.confidence).toBe(0.7);
  expect(list[2]!.auto_flags).toContain("phash_dup");
});

it("admin endpoints reject non-reviewers: 401 anonymous, 403 submitter", async () => {
  const sub = await seedSubmission();
  expect((await SELF.fetch("https://x/api/admin/submissions")).status).toBe(401);

  const { cookie: submitter } = await forgeSession("submitter");
  expect((await SELF.fetch("https://x/api/admin/submissions", { headers: { cookie: submitter } })).status).toBe(403);
  expect((await approve(sub.id, submitter, { items: [] })).status).toBe(403);
  expect((await reject(sub.id, submitter, { reason: "nope" })).status).toBe(403);
  expect((await SELF.fetch(`https://x/api/admin/images/submissions/${sub.id}/0`, { headers: { cookie: submitter } })).status).toBe(403);
});

// --- approve → publish ------------------------------------------------------

it("approve creates venue + items and the public API serves them", async () => {
  const sub = await seedSubmission({
    items: [
      { name: "Nasi Lemak", price_bnd: 2.5, item_type: "dish", category: "Mains" },
      { name: "Teh Tarik", price_bnd: 1.0, item_type: "dish" },
    ],
  });
  const { cookie, userId } = await forgeSession("reviewer");
  const res = await approve(sub.id, cookie, {
    venue: { name: "Kedai Test", type: "restaurant", area: "Tutong" },
    items: [
      { name: "Nasi Lemak", price_bnd: 3.0, item_type: "dish", category: "Mains" }, // reviewer edited price
      { name: "Teh Tarik", price_bnd: 1.0, item_type: "dish" },
    ],
  });
  expect(res.status).toBe(200);
  const { venue_id } = (await res.json()) as { venue_id: string };

  const [row] = await db().select().from(submissions).where(eq(submissions.id, sub.id));
  expect(row?.status).toBe("approved");
  expect(row?.reviewer_id).toBe(userId);

  const venueRes = await SELF.fetch(`https://x/api/venues/${venue_id}/items`);
  expect(venueRes.status).toBe(200);
  const { items } = (await venueRes.json()) as { items: { name: string; price_bnd: number; status: string; source_submission_id: string }[] };
  expect(items).toHaveLength(2);
  expect(items.map((i) => i.name).sort()).toEqual(["Nasi Lemak", "Teh Tarik"]);
  expect(items.find((i) => i.name === "Nasi Lemak")?.price_bnd).toBe(3.0);
  expect(items.every((i) => i.source_submission_id === sub.id)).toBe(true);
});

it("Review Focus #3: approving a second submission for the same venue supersedes the old menu", async () => {
  const { cookie } = await forgeSession("reviewer");

  const first = await seedSubmission({ items: [{ name: "Old Burger", price_bnd: 4.0, item_type: "dish" }] });
  const res1 = await approve(first.id, cookie, {
    venue: { name: "Burger Place", type: "restaurant", area: "Belait" },
    items: [{ name: "Old Burger", price_bnd: 4.0, item_type: "dish" }],
  });
  const { venue_id } = (await res1.json()) as { venue_id: string };

  const second = await seedSubmission({ items: [{ name: "New Burger", price_bnd: 5.5, item_type: "dish" }] });
  const res2 = await approve(second.id, cookie, {
    venue_id,
    items: [{ name: "New Burger", price_bnd: 5.5, item_type: "dish" }],
  });
  expect(res2.status).toBe(200);

  // Old item is out of `published`, superseded_by points at the second submission.
  const old = await db()
    .select()
    .from(food_items)
    .where(and(eq(food_items.venue_id, venue_id), eq(food_items.name, "Old Burger")));
  expect(old[0]?.status).toBe("superseded");
  expect(old[0]?.superseded_by).toBe(second.id);
  // The submission row itself is preserved history — nothing was deleted.
  const [firstRow] = await db().select().from(submissions).where(eq(submissions.id, first.id));
  expect(firstRow?.status).toBe("approved");

  const { items } = (await (await SELF.fetch(`https://x/api/venues/${venue_id}/items`)).json()) as {
    items: { name: string; superseded_by: string | null }[];
  };
  expect(items).toHaveLength(1);
  expect(items[0]!.name).toBe("New Burger");
  expect(items[0]!.superseded_by).toBeNull();
});

it("approve targets the raw_extraction items by default and works from a venue guess-less draft", async () => {
  const sub = await seedSubmission({
    items: [{ name: "Ambuyat Set", price_bnd: 12.0, item_type: "dish" }],
  });
  const { cookie } = await forgeSession("reviewer");
  // Approving with only a venue draft + items (no venue_id) creates the venue.
  const res = await approve(sub.id, cookie, {
    venue: { name: "Ambuyat House", type: "restaurant", area: "Temburong" },
    items: [{ name: "Ambuyat Set", price_bnd: 12.0, item_type: "dish" }],
  });
  expect(res.status).toBe(200);
  const { venue_id } = (await res.json()) as { venue_id: string };
  const [v] = await db().select().from(venues).where(eq(venues.id, venue_id));
  expect(v?.name).toBe("Ambuyat House");
});

it("approve rejects malformed bodies and decided submissions", async () => {
  const { cookie } = await forgeSession("reviewer");
  const sub = await seedSubmission();

  expect((await approve(sub.id, cookie, { items: "nope" })).status).toBe(400);
  // No venue at all — nowhere to publish to.
  expect((await approve(sub.id, cookie, { items: [{ name: "X", item_type: "dish" }] })).status).toBe(400);
  // Unknown existing venue id.
  expect((await approve(sub.id, cookie, { venue_id: crypto.randomUUID(), items: [] })).status).toBe(404);

  const res = await approve(sub.id, cookie, {
    venue: { name: "V", type: "stall", area: "Tutong" },
    items: [{ name: "X", price_bnd: 1, item_type: "dish" }],
  });
  expect(res.status).toBe(200);
  // Second decision on the same submission → 409, no double-publish.
  expect((await approve(sub.id, cookie, { venue: { name: "V2", type: "stall", area: "Tutong" }, items: [] })).status).toBe(409);
});

// --- reject -----------------------------------------------------------------

it("reject sets status=rejected with the reviewer-supplied reason", async () => {
  const sub = await seedSubmission();
  const { cookie, userId } = await forgeSession("reviewer");
  const res = await reject(sub.id, cookie, { reason: "menu photo too blurry to read" });
  expect(res.status).toBe(200);
  const [row] = await db().select().from(submissions).where(eq(submissions.id, sub.id));
  expect(row?.status).toBe("rejected");
  expect(row?.rejection_reason).toBe("menu photo too blurry to read");
  expect(row?.reviewer_id).toBe(userId);
  // Second decision → 409.
  expect((await reject(sub.id, cookie, { reason: "again" })).status).toBe(409);
});

it("reject requires a reason", async () => {
  const sub = await seedSubmission();
  const { cookie } = await forgeSession("reviewer");
  expect((await reject(sub.id, cookie, {})).status).toBe(400);
  expect((await reject(sub.id, cookie, { reason: "   " })).status).toBe(400);
});

// --- submitter counts --------------------------------------------------------

it("approve and reject bump the submitter's approved/rejected counts", async () => {
  const submitter = await seedSubmitter("new");
  const okSub = await seedSubmission({ submitterId: submitter.id });
  const badSub = await seedSubmission({ submitterId: submitter.id });
  const { cookie } = await forgeSession("admin");

  await approve(okSub.id, cookie, {
    venue: { name: "Counted", type: "grocer", area: "Brunei-Muara" },
    items: [{ name: "Item", price_bnd: 1, item_type: "dish" }],
  });
  await reject(badSub.id, cookie, { reason: "duplicate of an existing menu" });

  const [s] = await db().select().from(submitters).where(eq(submitters.id, submitter.id));
  expect(s?.approved_count).toBe(1);
  expect(s?.rejected_count).toBe(1);
});

// --- image serving -----------------------------------------------------------

it("GET /api/admin/images/* streams the R2 object for reviewers only", async () => {
  const sub = await seedSubmission({ imageKeys: [`submissions/${crypto.randomUUID()}/0`] });
  const key = sub.image_keys![0]!;
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  await env.SUBMISSIONS.put(key, bytes, { httpMetadata: { contentType: "image/png" } });

  const { cookie } = await forgeSession("reviewer");
  const res = await SELF.fetch(`https://x/api/admin/images/${key}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
});

it("image route rejects keys outside the submissions/ prefix and missing objects", async () => {
  const { cookie } = await forgeSession("reviewer");
  const traversal = await SELF.fetch("https://x/api/admin/images/..%2F..%2Fsecret", { headers: { cookie } });
  expect(traversal.status).toBe(400);
  const outside = await SELF.fetch("https://x/api/admin/images/public/logo.png", { headers: { cookie } });
  expect(outside.status).toBe(400);
  const missing = await SELF.fetch(`https://x/api/admin/images/submissions/${crypto.randomUUID()}/0`, {
    headers: { cookie },
  });
  expect(missing.status).toBe(404);
});
