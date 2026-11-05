import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/db/client";
import { food_items, submissions, venues } from "../src/db/schema";
import type { Env } from "../src/env";
import { setStubExtractor, type ExtractionDraft } from "../src/lib/extractor";
import { extractMapsUrl, resolveGmapsUrl } from "../src/lib/gmaps";
import {
  parseMenuLines,
  resetStubGmapsProvider,
  setStubGmapsProvider,
  type GmapsFetchResult,
} from "../src/lib/gmaps-provider";
import { flattenSections } from "../src/lib/gmaps-publish";
import { processSubmission } from "../src/queue";
import { forgeSession } from "./helpers/auth";
import { MENU_PNG } from "./fixtures/images";

// GMaps provider chain and the vision model are never real in tests —
// EXTRACTOR=stub controls extraction, GMAPS_PROVIDER=stub controls imports.
function stubEnv(): Env {
  return new Proxy(env, {
    get(target, prop) {
      if (prop === "EXTRACTOR") return "stub";
      if (prop === "GMAPS_PROVIDER") return "stub";
      return Reflect.get(target, prop);
    },
  }) as Env;
}

const PLACE_URL =
  "https://www.google.com/maps/place/Kaizen+Sushi/@4.903,114.917,17z/data=!3m1!4b1!4m5!3m4!1s0x321d6b2f2b7a4b75:0x6a7d4f7c1d0f8b9f!8m2!3d4.903!4d114.917";
const PLACE_ID_URL =
  "https://www.google.com/maps/place/Some+Cafe/@4.9,114.9,17z/data=!4m2!3m1!1sChIJN1t_tDeuEmsRUsoyG83frY4";
const CID_URL = "https://maps.google.com/?cid=3545819340560108778";

const MENU_DRAFT: ExtractionDraft = {
  has_food_content: true,
  confidence: 0.9,
  venue_guess: null,
  items: [{ name: "Nasi Katok", price_bnd: 1.5, item_type: "dish" }],
  suspicion: [],
};

function okResult(): GmapsFetchResult {
  return {
    kind: "ok",
    data: {
      provider: "stub",
      place: { name: "Kaizen Sushi", lat: 4.903, lng: 114.917, address: "1 Jalan Test" },
      sections: [
        {
          name: "Mains",
          items: [
            { name: "Sushi Platter", price: 12.5, description: "12 pcs" },
            { name: "Miso Soup", price: 2.0 },
          ],
        },
      ],
      photo_urls: [],
    },
  };
}

// File a gmaps_link submission row directly (the route's resolve step is
// tested separately — the queue only needs raw_extraction.gmaps).
async function seedImport(
  userId: string | null,
  gmaps: Record<string, unknown> = { resolved_url: PLACE_URL, place_id: "ChIJtest", place: { name: "Kaizen Sushi", lat: 4.903, lng: 114.917 } },
): Promise<string> {
  const id = crypto.randomUUID();
  await getDb(env)
    .insert(submissions)
    .values({
      id,
      user_id: userId,
      source_type: "gmaps_link",
      provenance: "https://maps.app.goo.gl/xyz",
      image_keys: [],
      raw_extraction: { gmaps },
      auto_flags: [],
      status: "pending",
    });
  return id;
}

async function getRow(id: string) {
  const [row] = await getDb(env).select().from(submissions).where(eq(submissions.id, id));
  return row;
}

// vitest-pool-workers 0.23 has no fetchMock — the test file shares the
// workerd isolate's global, so a plain fetch stub intercepts the worker's
// outbound calls (short-link expansion, photo downloads). Restore per test.
const realFetch = globalThis.fetch;
function stubFetch(handler: (url: string) => Response | null): void {
  const stub = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const mocked = handler(url);
    if (mocked) return mocked;
    return realFetch(input as never, init);
  };
  vi.stubGlobal("fetch", stub);
}

afterEach(() => {
  resetStubGmapsProvider();
  vi.unstubAllGlobals();
});

describe("resolveGmapsUrl", () => {
  it("parses data_id, name and coords from a /place URL", async () => {
    const r = await resolveGmapsUrl(PLACE_URL);
    expect(r.data_id).toBe("0x321d6b2f2b7a4b75:0x6a7d4f7c1d0f8b9f");
    expect(r.name).toBe("Kaizen Sushi");
    expect(r.lat).toBeCloseTo(4.903);
    expect(r.lng).toBeCloseTo(114.917);
  });

  it("parses a ChIJ place_id", async () => {
    const r = await resolveGmapsUrl(PLACE_ID_URL);
    expect(r.place_id).toBe("ChIJN1t_tDeuEmsRUsoyG83frY4");
  });

  it("parses a ?cid= link", async () => {
    const r = await resolveGmapsUrl(CID_URL);
    expect(r.data_cid).toBe("3545819340560108778");
  });

  it("extracts a URL from share-sheet text", async () => {
    const r = await resolveGmapsUrl(`Try this place: ${PLACE_URL} so good`);
    expect(r.name).toBe("Kaizen Sushi");
  });

  it("rejects non-Maps links", async () => {
    await expect(resolveGmapsUrl("https://example.com/x")).rejects.toMatchObject({ code: "not_a_venue" });
    await expect(resolveGmapsUrl("https://www.google.com/search?q=cats")).rejects.toMatchObject({ code: "not_a_venue" });
  });

  it("rejects a bare pin with no place identifiers", async () => {
    await expect(resolveGmapsUrl("https://www.google.com/maps/@4.9,114.9,15z")).rejects.toMatchObject({
      code: "not_a_venue",
    });
  });

  it("rejects text without a URL", async () => {
    await expect(resolveGmapsUrl("no link here")).rejects.toMatchObject({ code: "unresolvable_link" });
  });

  it("expands a maps.app.goo.gl short link", async () => {
    stubFetch((url) => {
      if (!url.startsWith("https://maps.app.goo.gl/")) return null;
      // A real fetch with redirect:"follow" reports the final URL on
      // res.url — Response.url is a read-only getter, so shadow it.
      const res = new Response("ok", { status: 200 });
      Object.defineProperty(res, "url", { value: PLACE_URL });
      return res;
    });
    const r = await resolveGmapsUrl("https://maps.app.goo.gl/abc123");
    expect(r.data_id).toBe("0x321d6b2f2b7a4b75:0x6a7d4f7c1d0f8b9f");
    expect(r.resolved_url).toBe(PLACE_URL);
  });
});

describe("extractMapsUrl", () => {
  it("finds the first URL in prose", () => {
    expect(extractMapsUrl("check https://x.co/a and https://y.co/b")).toBe("https://x.co/a");
    expect(extractMapsUrl("nothing")).toBeNull();
  });
});

describe("parseMenuLines", () => {
  it("groups names and prices into items", () => {
    const sections = parseMenuLines(["Nasi Katok", "B$1.50", "Teh Tarik", "B$1.00", "Roti", "with egg", "B$2.00"]);
    expect(sections).toHaveLength(1);
    const items = sections[0]!.items;
    expect(items[0]).toMatchObject({ name: "Nasi Katok", price: 1.5 });
    expect(items[1]).toMatchObject({ name: "Teh Tarik", price: 1.0 });
    expect(items[2]).toMatchObject({ name: "Roti", price: 2.0, description: "with egg" });
  });
});

describe("POST /api/submissions/gmaps", () => {
  it("requires auth", async () => {
    const res = await SELF.fetch("https://x/api/submissions/gmaps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: PLACE_URL }),
    });
    expect(res.status).toBe(401);
  });

  it("files a pending gmaps_link submission", async () => {
    const { cookie, userId } = await forgeSession("submitter");
    const res = await SELF.fetch("https://x/api/submissions/gmaps", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ url: PLACE_URL }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { submission_id: string };
    const row = await getRow(body.submission_id);
    expect(row?.status).toBe("pending");
    expect(row?.source_type).toBe("gmaps_link");
    expect(row?.user_id).toBe(userId);
    expect(row?.raw_extraction?.gmaps?.place?.name).toBe("Kaizen Sushi");
    expect(row?.raw_extraction?.gmaps?.data_id).toBe("0x321d6b2f2b7a4b75:0x6a7d4f7c1d0f8b9f");
  });

  it("rejects non-Maps links", async () => {
    const { cookie } = await forgeSession("submitter");
    const res = await SELF.fetch("https://x/api/submissions/gmaps", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ url: "https://example.com/menu" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("not_a_venue");
  });
});

describe("queue: gmaps_link outcomes", () => {
  it("structured menu + venue match → trusted publish behind pending_verification", async () => {
    const { userId } = await forgeSession("submitter");
    const db = getDb(env);
    const [venue] = await db
      .insert(venues)
      .values({
        name: "Kaizen Sushi",
        type: "restaurant",
        area: "Brunei-Muara",
        geo: { lat: 4.9031, lng: 114.9171 },
      })
      .returning();
    setStubGmapsProvider(okResult());
    const id = await seedImport(userId);
    await processSubmission(stubEnv(), id);

    const row = await getRow(id);
    expect(row?.status).toBe("trusted_published");
    expect(row?.publish_mode).toBe("trusted");
    const items = await db.select().from(food_items).where(eq(food_items.source_submission_id, id));
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.pending_verification && i.is_current)).toBe(true);
    const [v] = await db.select().from(venues).where(eq(venues.id, venue!.id));
    expect(v?.google_place_id).toBe("ChIJtest");
  });

  it("structured menu + no match → pending_review with items and candidates", async () => {
    const { userId } = await forgeSession("submitter");
    setStubGmapsProvider({
      kind: "ok",
      data: {
        provider: "stub",
        place: { name: "Nowhere Cafe", lat: 4.5, lng: 114.5 },
        sections: [{ name: "Mains", items: [{ name: "Soup", price: 3 }] }],
        photo_urls: [],
      },
    });
    const id = await seedImport(userId, {
      resolved_url: PLACE_URL,
      place_id: "ChIJnomatch",
      place: { name: "Nowhere Cafe", lat: 4.5, lng: 114.5 },
    });
    await processSubmission(stubEnv(), id);

    const row = await getRow(id);
    expect(row?.status).toBe("pending_review");
    expect(row?.auto_flags).toContain("venue_unverified");
    expect(row?.raw_extraction?.items).toHaveLength(1);
    expect(row?.raw_extraction?.venue_guess?.name).toBe("Nowhere Cafe");
  });

  it("venue attach endpoint publishes the cached menu to a picked venue", async () => {
    const { cookie, userId } = await forgeSession("submitter");
    const db = getDb(env);
    const [venue] = await db
      .insert(venues)
      .values({ name: "Nearby Place", type: "restaurant", area: "Brunei-Muara", geo: { lat: 4.903, lng: 114.9 } })
      .returning();
    setStubGmapsProvider({
      kind: "ok",
      data: {
        provider: "stub",
        place: { name: "Attach Cafe", lat: 4.5, lng: 114.5 },
        sections: [{ name: "Mains", items: [{ name: "Special Laksa", price: 4.5 }] }],
        photo_urls: [],
      },
    });
    const id = await seedImport(userId, {
      resolved_url: PLACE_URL,
      place_id: "ChIJattach",
      place: { name: "Attach Cafe", lat: 4.5, lng: 114.5 },
    });
    await processSubmission(stubEnv(), id);
    const before = await getRow(id);
    expect(before?.status).toBe("pending_review");

    const res = await SELF.fetch(`https://x/api/submissions/gmaps/${id}/venue`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ venue_id: venue!.id }),
    });
    const resBody = (await res.json()) as { status?: string; error?: string };
    expect(resBody.error ?? res.status).toBe(200);
    expect(resBody.status).toBe("imported");
    const row = await getRow(id);
    expect(row?.status).toBe("trusted_published");
    const items = await db.select().from(food_items).where(eq(food_items.source_submission_id, id));
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.venue_id === venue!.id)).toBe(true);
  });

  it("empty provider verdict → auto_rejected gmaps_no_data", async () => {
    const { userId } = await forgeSession("submitter");
    setStubGmapsProvider({ kind: "empty" });
    const id = await seedImport(userId);
    await processSubmission(stubEnv(), id);
    const row = await getRow(id);
    expect(row?.status).toBe("auto_rejected");
    expect(row?.rejection_reason).toBe("gmaps_no_data");
  });

  it("photo-only result → downloads to R2 and runs the vision pipeline", async () => {
    const { userId } = await forgeSession("submitter");
    setStubExtractor(MENU_DRAFT);
    setStubGmapsProvider({
      kind: "ok",
      data: {
        provider: "stub",
        place: { name: "Photo Only Eatery", lat: 4.9, lng: 114.9 },
        sections: [],
        photo_urls: ["https://lh3.googleusercontent.com/p/fake1", "https://lh3.googleusercontent.com/p/fake2"],
      },
    });
    stubFetch((url) =>
      url.includes("googleusercontent.com/p/fake")
        ? new Response(MENU_PNG, { headers: { "content-type": "image/png" } })
        : null,
    );
    const id = await seedImport(userId);
    await processSubmission(stubEnv(), id);

    const row = await getRow(id);
    expect(row?.status).toBe("pending_review");
    expect(row?.image_keys).toHaveLength(2);
    expect(row?.raw_extraction?.items).toHaveLength(1);
    // Venue hint fallback: place name fills the empty vision guess.
    expect(row?.raw_extraction?.venue_guess?.name).toBe("Photo Only Eatery");
    const obj = await env.SUBMISSIONS.get(row!.image_keys[0]!);
    expect(obj).not.toBeNull();
  });
});

describe("flattenSections", () => {
  it("flattens section items into draft dishes", () => {
    const items = flattenSections([
      { name: "Mains", items: [{ name: "A", price: 1.5 }, { name: "B" }] },
      { name: "Drinks", items: [{ name: "C", price: 0.5 }] },
    ]);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ name: "A", price_bnd: 1.5, category: "Mains", item_type: "dish" });
    expect(items[2]).toMatchObject({ name: "C", category: "Drinks" });
  });
});
