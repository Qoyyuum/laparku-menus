import { env, SELF } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { food_items, submissions, venue_requests, venues, type Venue } from "../src/db/schema";
import { forgeSession } from "./helpers/auth";

const db = () => getDb(env);

// --- fixtures ---------------------------------------------------------------

async function seedVenue(opts: { name?: string; area?: Venue["area"]; stub?: boolean; status?: Venue["status"] } = {}) {
  const [v] = await db()
    .insert(venues)
    .values({
      name: opts.name ?? `Venue-${crypto.randomUUID().slice(0, 8)}`,
      type: "restaurant",
      area: opts.area ?? "Brunei-Muara",
      status: opts.status ?? "published",
      is_stub: opts.stub ?? false,
    })
    .returning();
  return v!;
}

async function seedSubmission() {
  const [row] = await db()
    .insert(submissions)
    .values({
      source_type: "menu_photo",
      provenance: "photo of the physical menu",
      status: "pending_review",
      raw_extraction: { has_food_content: true, items: [{ name: "Nasi Katok", price_bnd: 1.5, item_type: "dish" }] },
    })
    .returning();
  return row!;
}

function postRequest(body: unknown, cookie?: string) {
  return SELF.fetch("https://x/api/requests", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

interface PublicVenue {
  id: string;
  name: string;
  is_stub: boolean;
}

interface PublicRequest {
  id: string;
  venue_id: string | null;
  venue_name: string | null;
  free_text_name: string | null;
  area: string;
  note: string | null;
  status: string;
  fulfilled_submission_id: string | null;
}

interface CoverageArea {
  area: string;
  venues: number;
  stubs: number;
  open_requests: number;
  items: number;
}

async function approve(submissionId: string, cookie: string, body: unknown) {
  return SELF.fetch(`https://x/api/admin/submissions/${submissionId}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

// --- (a) stubs ride the public venue payloads --------------------------------

it("a seeded stub appears in GET /api/venues and /api/search with is_stub:true", async () => {
  const stub = await seedVenue({ name: "Stubby Stall", stub: true });
  const normal = await seedVenue({ name: "Normal Nasi" });

  const res = await SELF.fetch("https://x/api/venues");
  expect(res.status).toBe(200);
  const { venues: list } = (await res.json()) as { venues: PublicVenue[] };
  expect(list.find((v) => v.id === stub.id)?.is_stub).toBe(true);
  expect(list.find((v) => v.id === normal.id)?.is_stub).toBe(false);

  // The ?stub=true filter lists just the "menu needed" places.
  const stubsRes = await SELF.fetch("https://x/api/venues?stub=true");
  const { venues: stubs } = (await stubsRes.json()) as { venues: PublicVenue[] };
  expect(stubs.map((v) => v.id)).toContain(stub.id);
  expect(stubs.map((v) => v.id)).not.toContain(normal.id);
  expect((await SELF.fetch("https://x/api/venues?stub=maybe")).status).toBe(400);

  // Search payloads carry the flag too.
  const search = await SELF.fetch("https://x/api/search?q=Stubby");
  const { venues: hits } = (await search.json()) as { venues: PublicVenue[] };
  expect(hits.find((v) => v.id === stub.id)?.is_stub).toBe(true);
});

// --- (b) Review Focus #6: approving onto a stub clears it + fills missions ---

it("approving a submission for a stub venue clears is_stub and fulfills matching requests", async () => {
  const stub = await seedVenue({ name: "Mission Cafe", area: "Tutong", stub: true });
  const { cookie: submitter } = await forgeSession("submitter");

  // A stub-attached mission.
  const r1 = await postRequest({ venue_id: stub.id, note: "heard the ambuyat is great" }, submitter);
  expect(r1.status).toBe(201);
  const { request: attached } = (await r1.json()) as { request: PublicRequest };
  // The venue's area rides along on the stored row.
  expect(attached.area).toBe("Tutong");

  // A free-text mission naming the same venue + area (case-insensitive).
  const r2 = await postRequest({ free_text_name: "mission cafe", area: "Tutong" }, submitter);
  expect(r2.status).toBe(201);
  const { request: freeText } = (await r2.json()) as { request: PublicRequest };

  // Missions that must NOT be fulfilled: different name, wrong area.
  const r3 = await postRequest({ free_text_name: "Elsewhere Eats", area: "Tutong" }, submitter);
  const r4 = await postRequest({ free_text_name: "Mission Cafe", area: "Belait" }, submitter);
  const { request: otherName } = (await r3.json()) as { request: PublicRequest };
  const { request: wrongArea } = (await r4.json()) as { request: PublicRequest };

  const sub = await seedSubmission();
  const { cookie: reviewer } = await forgeSession("reviewer");
  const res = await approve(sub.id, reviewer, {
    venue_id: stub.id,
    items: [{ name: "Ambuyat Set", price_bnd: 8.0, item_type: "dish" }],
  });
  expect(res.status).toBe(200);

  const [venue] = await db().select().from(venues).where(eq(venues.id, stub.id));
  expect(venue?.is_stub).toBe(false);

  const rows = await db().select().from(venue_requests).where(eq(venue_requests.venue_id, stub.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("fulfilled");
  expect(rows[0]?.fulfilled_submission_id).toBe(sub.id);

  const freeTextRows = await db().select().from(venue_requests).where(eq(venue_requests.id, freeText.id));
  expect(freeTextRows[0]?.status).toBe("fulfilled");
  expect(freeTextRows[0]?.fulfilled_submission_id).toBe(sub.id);

  for (const id of [otherName.id, wrongArea.id]) {
    const [still] = await db().select().from(venue_requests).where(eq(venue_requests.id, id));
    expect(still?.status).toBe("open");
    expect(still?.fulfilled_submission_id).toBeNull();
  }
});

it("a publish creating a venue that matches a free-text request fulfills it", async () => {
  const { cookie: submitter } = await forgeSession("submitter");
  const r = await postRequest({ free_text_name: "New Place", area: "Belait" }, submitter);
  const { request } = (await r.json()) as { request: PublicRequest };

  const sub = await seedSubmission();
  const { cookie: reviewer } = await forgeSession("reviewer");
  const res = await approve(sub.id, reviewer, {
    venue: { name: "New Place", type: "stall", area: "Belait" },
    items: [{ name: "Satay", price_bnd: 1.0, item_type: "dish" }],
  });
  expect(res.status).toBe(200);

  const [row] = await db().select().from(venue_requests).where(eq(venue_requests.id, request.id));
  expect(row?.status).toBe("fulfilled");
  expect(row?.fulfilled_submission_id).toBe(sub.id);
});

// --- (c) POST /api/requests: session + validation + listing -------------------

it("POST /api/requests files an open mission for an unknown venue, listed by GET /api/requests", async () => {
  // Writes ride the session.
  expect((await postRequest({ free_text_name: "Ghost Cafe", area: "Belait" })).status).toBe(401);

  const { cookie } = await forgeSession("submitter");
  const res = await postRequest({ free_text_name: "Ghost Cafe", area: "Belait", note: "night market row" }, cookie);
  expect(res.status).toBe(201);
  const { request } = (await res.json()) as { request: PublicRequest };
  expect(request.status).toBe("open");
  expect(request.free_text_name).toBe("Ghost Cafe");
  expect(request.area).toBe("Belait");
  expect(request.note).toBe("night market row");
  expect(request.venue_id).toBeNull();

  const list = await SELF.fetch("https://x/api/requests?status=open&area=Belait");
  expect(list.status).toBe(200);
  const { requests } = (await list.json()) as { requests: PublicRequest[] };
  expect(requests.map((r) => r.id)).toContain(request.id);
});

it("POST /api/requests validates the venue_id | free_text_name + area shape", async () => {
  const venue = await seedVenue();
  const { cookie } = await forgeSession("submitter");

  // Neither target → 400; both targets → 400.
  expect((await postRequest({ note: "nothing" }, cookie)).status).toBe(400);
  expect((await postRequest({ venue_id: venue.id, free_text_name: "X", area: "Tutong" }, cookie)).status).toBe(400);
  // Free-text without a valid area → 400.
  expect((await postRequest({ free_text_name: "X" }, cookie)).status).toBe(400);
  expect((await postRequest({ free_text_name: "X", area: "Narnia" }, cookie)).status).toBe(400);
  // Unknown or unpublished venue → 404.
  expect((await postRequest({ venue_id: crypto.randomUUID() }, cookie)).status).toBe(404);
  const draft = await seedVenue({ status: "draft" });
  expect((await postRequest({ venue_id: draft.id }, cookie)).status).toBe(404);
  // Bad field types → 400.
  expect((await postRequest({ venue_id: 42 }, cookie)).status).toBe(400);
  expect((await postRequest({ venue_id: venue.id, note: 5 }, cookie)).status).toBe(400);

  // A sane venue-attached request still lands after all the rejections.
  expect((await postRequest({ venue_id: venue.id }, cookie)).status).toBe(201);
});

it("GET /api/requests filters by status and area; invalid params are 400", async () => {
  const { cookie } = await forgeSession("submitter");
  const a = await postRequest({ free_text_name: "Filt A", area: "Temburong" }, cookie);
  const { request: reqA } = (await a.json()) as { request: PublicRequest };
  await postRequest({ free_text_name: "Filt B", area: "Brunei-Muara" }, cookie);

  const temburong = (await (await SELF.fetch("https://x/api/requests?status=open&area=Temburong")).json()) as {
    requests: PublicRequest[];
  };
  expect(temburong.requests.map((r) => r.id)).toContain(reqA.id);
  expect(temburong.requests.every((r) => r.area === "Temburong")).toBe(true);

  expect((await SELF.fetch("https://x/api/requests?status=bogus")).status).toBe(400);
  expect((await SELF.fetch("https://x/api/requests?area=Narnia")).status).toBe(400);
});

// --- (d) GET /api/coverage: per-area counts -----------------------------------

it("GET /api/coverage returns per-area venue/stub/request/item counts", async () => {
  // The test file shares one D1 — earlier tests already seeded requests and
  // venues — so expectations are deltas over this baseline, not absolutes.
  const before = (await (await SELF.fetch("https://x/api/coverage")).json()) as { areas: CoverageArea[] };
  const beforeTemburong = before.areas.find((a) => a.area === "Temburong")!;

  // All fixtures land in Temburong.
  const withMenu = await seedVenue({ name: "Cov Resto", area: "Temburong" });
  await db()
    .insert(food_items)
    .values([
      { venue_id: withMenu.id, item_type: "dish", name: "Dish One", price_bnd: 2.0 },
      { venue_id: withMenu.id, item_type: "dish", name: "Dish Two", price_bnd: 3.0 },
      {
        venue_id: withMenu.id,
        item_type: "dish",
        name: "Dead Dish",
        price_bnd: 1.0,
        status: "superseded",
        is_current: false,
        superseded_by: "x",
      },
    ]);
  const stub = await seedVenue({ name: "Cov Stub", area: "Temburong", stub: true });
  // A draft venue and its item count for nothing.
  const draft = await seedVenue({ name: "Cov Draft", area: "Temburong", status: "draft" });
  await db().insert(food_items).values({ venue_id: draft.id, item_type: "dish", name: "Ghost", price_bnd: 1 });

  const { cookie } = await forgeSession("submitter");
  await postRequest({ venue_id: stub.id }, cookie);
  await postRequest({ free_text_name: "Cov Free", area: "Temburong" }, cookie);

  const res = await SELF.fetch("https://x/api/coverage");
  expect(res.status).toBe(200);
  const { areas } = (await res.json()) as { areas: CoverageArea[] };
  expect(areas.map((a) => a.area)).toEqual(["Brunei-Muara", "Tutong", "Belait", "Temburong"]);

  const temburong = areas.find((a) => a.area === "Temburong")!;
  // Published venues only — the stub counts as a venue AND as a stub; the
  // draft and its item are invisible.
  expect(temburong.venues).toBe(beforeTemburong.venues + 2);
  expect(temburong.stubs).toBe(beforeTemburong.stubs + 1);
  expect(temburong.items).toBe(beforeTemburong.items + 2); // current published items only
  expect(temburong.open_requests).toBe(beforeTemburong.open_requests + 2);
});
