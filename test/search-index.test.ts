import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { food_items, type FoodItem, type Venue } from "../src/db/schema";
import type { Env } from "../src/env";
import {
  embedTexts,
  indexItems,
  indexVenues,
  itemDoc,
  metadataFilter,
  minScore,
  reindexAll,
  searchEnabled,
  unindex,
  venueDoc,
} from "../src/lib/search-index";
import adminApi from "../src/routes/admin";
import { searchPublic } from "../src/routes/public";
import { forgeSession } from "./helpers/auth";
import { seed } from "./helpers/seed";

describe("search-index core", () => {
  it("itemDoc embeds bilingual name, description, tags and venue context", () => {
    const doc = itemDoc(
      {
        name: "Nasi Katok",
        name_ms: "ناسي کاتوق",
        description: "rice + sambal + chicken",
        category: "rice",
        tags: ["spicy"],
        item_type: "dish",
        price_bnd: 1.5,
      } as FoodItem,
      { name: "Kedai A", type: "restaurant", area: "Tutong" } as Venue,
    );
    expect(doc).toContain("Nasi Katok");
    expect(doc).toContain("Kedai A");
    expect(doc).toContain("Tutong");
    expect(doc).toContain("spicy");
  });

  it("itemDoc drops null fields without stray separators", () => {
    const doc = itemDoc(
      {
        name: "Fries",
        name_ms: null,
        description: null,
        category: null,
        tags: [],
        item_type: "dish",
      } as unknown as FoodItem,
      { name: "V", type: "stall", area: "Belait" } as Venue,
    );
    expect(doc).not.toMatch(/null|undefined/);
  });

  it("venueDoc embeds name, type, area, address, halal", () => {
    const doc = venueDoc({
      name: "Kedai A",
      name_ms: null,
      type: "restaurant",
      area: "Tutong",
      address: "Jalan X",
      halal_status: "halal-certified",
    } as Venue);
    expect(doc).toContain("Kedai A");
    expect(doc).toContain("restaurant");
    expect(doc).toContain("Tutong");
    expect(doc).toContain("halal-certified");
    expect(doc).not.toMatch(/null|undefined/);
  });

  it("metadataFilter maps filters; venue queries ignore item-only keys", () => {
    const f = {
      area: "Tutong",
      halal: "halal-certified",
      itemType: "dish",
      venueType: "restaurant",
      maxPrice: 5,
    };
    expect(metadataFilter("item", f)).toEqual({
      kind: "item",
      area: "Tutong",
      halal: "halal-certified",
      item_type: "dish",
      venue_type: "restaurant",
      price_bnd: { $lte: 5 },
    });
    expect(metadataFilter("venue", f)).toEqual({
      kind: "venue",
      area: "Tutong",
      halal: "halal-certified",
      venue_type: "restaurant",
    });
  });

  it("searchEnabled requires provider=vectorize AND the binding", () => {
    expect(
      searchEnabled({ SEARCH_PROVIDER: "like", SEARCH_INDEX: {} } as unknown as Env),
    ).toBe(false);
    expect(searchEnabled({ SEARCH_PROVIDER: "vectorize" } as unknown as Env)).toBe(false);
    expect(
      searchEnabled({ SEARCH_PROVIDER: "vectorize", SEARCH_INDEX: {} } as unknown as Env),
    ).toBe(true);
  });

  it("minScore parses the var, defaults 0.5", () => {
    expect(minScore({} as Env)).toBe(0.5);
    expect(minScore({ SEARCH_MIN_SCORE: "0.7" } as Env)).toBe(0.7);
    expect(minScore({ SEARCH_MIN_SCORE: "junk" } as Env)).toBe(0.5);
  });
});

// Wrapped-env fakes: spread the real test env so getDb/DB stay live, swap in
// a recording VectorizeIndex and a deterministic AI embedding stub.
const fakeIndex = () => {
  const calls = { upsert: [] as VectorizeVector[][], deleted: [] as string[][] };
  return {
    calls,
    index: {
      upsert: async (v: VectorizeVector[]) => {
        calls.upsert.push(v);
        return { ids: v.map((x) => x.id), count: v.length };
      },
      deleteByIds: async (ids: string[]) => {
        calls.deleted.push(ids);
        return { ids, count: ids.length };
      },
      query: async () => ({ matches: [], count: 0 }),
    } as unknown as VectorizeIndex,
  };
};
const fakeAi = {
  run: async (_m: string, input: { text: string[] }) => ({
    shape: [input.text.length, 3],
    data: input.text.map((t) => [t.length, 1, 0.5]),
  }),
} as unknown as Ai;
const semanticEnv = (fi: ReturnType<typeof fakeIndex>) =>
  ({ ...env, SEARCH_PROVIDER: "vectorize", SEARCH_INDEX: fi.index, AI: fakeAi }) as Env;

describe("indexing", () => {
  it("embedTexts batches through Workers AI", async () => {
    const texts = ["a", "bb", "ccc"];
    const vectors = await embedTexts(
      { ...env, AI: fakeAi, EMBEDDING_MODEL: "@cf/baai/bge-m3" } as Env,
      texts,
    );
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toEqual([1, 1, 0.5]);
  });

  it("indexItems embeds and upserts vectors with metadata", async () => {
    const { venue } = await seed(env);
    const db = getDb(env);
    const [item] = await db
      .select()
      .from(food_items)
      .where(eq(food_items.venue_id, venue.id))
      .limit(1);
    const fi = fakeIndex();
    await indexItems(semanticEnv(fi), db, [item!.id]);
    expect(fi.calls.upsert.flat().map((v) => v.id)).toEqual([item!.id]);
    const meta = fi.calls.upsert.flat()[0]!.metadata!;
    expect(meta).toMatchObject({
      kind: "item",
      venue_id: venue.id,
      venue_type: venue.type,
      area: venue.area,
    });
    expect(meta.price_bnd).toBe(1.5);
  });

  it("indexVenues upserts venue vectors", async () => {
    const { venue } = await seed(env);
    const fi = fakeIndex();
    await indexVenues(semanticEnv(fi), getDb(env), [venue.id]);
    const meta = fi.calls.upsert.flat()[0]!.metadata!;
    expect(meta).toMatchObject({
      kind: "venue",
      venue_type: "restaurant",
      area: "Brunei-Muara",
      halal: "muslim-owned",
    });
    expect(meta.price_bnd).toBeUndefined();
  });

  it("indexItems no-ops when provider is like", async () => {
    const fi = fakeIndex();
    let aiCalled = false;
    const w = {
      ...env,
      SEARCH_PROVIDER: "like",
      SEARCH_INDEX: fi.index,
      AI: {
        run: async () => {
          aiCalled = true;
          return { data: [] };
        },
      } as unknown as Ai,
    } as Env;
    await indexItems(w, getDb(env), ["anything"]);
    expect(aiCalled).toBe(false);
    expect(fi.calls.upsert).toHaveLength(0);
  });

  it("unindex deletes ids; reindexAll covers live rows and skips hidden", async () => {
    const { venue } = await seed(env);
    const db = getDb(env);
    const fi = fakeIndex();
    const w = semanticEnv(fi);
    await unindex(w, ["a", "b"]);
    expect(fi.calls.deleted).toEqual([["a", "b"]]);
    const counts = await reindexAll(w, db);
    const upserted = fi.calls.upsert.flat();
    expect(
      upserted.every((v) => v.metadata?.kind === "item" || v.metadata?.kind === "venue"),
    ).toBe(true);
    expect(counts.venues).toBeGreaterThanOrEqual(1);
    expect(counts.items).toBeGreaterThanOrEqual(1);
    const [hidden] = await db
      .insert(food_items)
      .values({
        venue_id: venue.id,
        item_type: "dish",
        name: "Ghost",
        status: "hidden",
        is_current: false,
      })
      .returning();
    fi.calls.upsert.length = 0;
    await reindexAll(w, db);
    expect(fi.calls.upsert.flat().map((v) => v.id)).not.toContain(hidden!.id);
  });
});

describe("POST /api/admin/search/reindex", () => {
  it("requires a reviewer session", async () => {
    const res = await SELF.fetch("https://x/api/admin/search/reindex", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("reindexes and reports counts", async () => {
    await seed(env);
    const { cookie } = await forgeSession("reviewer");
    const fi = fakeIndex();
    const res = await adminApi.request(
      "/search/reindex",
      { method: "POST", headers: { cookie } },
      semanticEnv(fi),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; items: number; venues: number };
    expect(body.ok).toBe(true);
    expect(body.venues).toBeGreaterThanOrEqual(1);
    expect(body.items).toBeGreaterThanOrEqual(1);
    expect(fi.calls.upsert.flat().length).toBeGreaterThanOrEqual(2);
  });
});

// Canned-recall env: the fake index returns `matches[kind]` for whatever
// vector it's queried with — exercises hydration/floor/fallback, not the
// embedding itself.
const recallEnv = (matches: Record<string, { id: string; score: number }[]>) => {
  const index = {
    query: async (_v: number[], o: { filter?: Record<string, unknown>; topK?: number }) => ({
      matches: matches[String((o.filter as { kind: string }).kind)] ?? [],
      count: 0,
    }),
    upsert: async () => ({ ids: [], count: 0 }),
    deleteByIds: async () => ({ ids: [], count: 0 }),
  } as unknown as VectorizeIndex;
  return { ...env, SEARCH_PROVIDER: "vectorize", SEARCH_INDEX: index, AI: fakeAi } as Env;
};

describe("semantic searchPublic", () => {
  it("hydrates D1 rows ordered by score", async () => {
    const { venue } = await seed(env);
    const db = getDb(env);
    const extra = await db
      .insert(food_items)
      .values([
        { venue_id: venue.id, item_type: "dish", name: "Kangkong Belacan", price_bnd: 3 },
        { venue_id: venue.id, item_type: "dish", name: "Ambuyat", price_bnd: 5 },
      ])
      .returning();
    const [nasik, kangkong, ambuyat] = [
      (await db.select().from(food_items).where(eq(food_items.name, "Nasi Katok")).limit(1))[0]!,
      extra[0]!,
      extra[1]!,
    ];
    const w = recallEnv({
      item: [
        { id: ambuyat.id, score: 0.9 },
        { id: nasik.id, score: 0.8 },
        { id: kangkong.id, score: 0.7 },
      ],
    });
    const r = await searchPublic(w, { q: "spicy rice" });
    expect(r.items.map((i) => i.id)).toEqual([ambuyat.id, nasik.id, kangkong.id]);
    expect((r.items[0] as { score?: number }).score).toBe(0.9);
  });

  it("score floor drops low-confidence matches; stale rows never leak", async () => {
    const { venue } = await seed(env);
    const db = getDb(env);
    const [live] = await db
      .select()
      .from(food_items)
      .where(eq(food_items.name, "Nasi Katok"))
      .limit(1);
    const [ghost] = await db
      .insert(food_items)
      .values({ venue_id: venue.id, item_type: "dish", name: "Ghost", status: "hidden", is_current: false })
      .returning();
    const w = recallEnv({
      item: [
        { id: live!.id, score: 0.9 },
        { id: ghost!.id, score: 0.95 },
        { id: live!.id, score: 0.3 },
      ],
    });
    const r = await searchPublic(w, { q: "anything" });
    const ids = r.items.map((i) => i.id);
    expect(ids).toEqual([live!.id]); // hidden row recalled but filtered; dup below floor dropped
  });

  it("whitespace q uses the browse path — no embedding call", async () => {
    let called = false;
    const w = {
      ...recallEnv({}),
      AI: {
        run: async () => {
          called = true;
          return { data: [] };
        },
      } as unknown as Ai,
    } as Env;
    await searchPublic(w, { q: "   " });
    expect(called).toBe(false);
  });

  it("recall failure falls back to LIKE", async () => {
    await seed(env);
    const w = {
      ...env,
      SEARCH_PROVIDER: "vectorize",
      AI: fakeAi,
      SEARCH_INDEX: {
        query: async () => {
          throw new Error("index down");
        },
        upsert: async () => ({ ids: [], count: 0 }),
        deleteByIds: async () => ({ ids: [], count: 0 }),
      } as unknown as VectorizeIndex,
    } as Env;
    const r = await searchPublic(w, { q: "katok" });
    expect(r.items.map((i) => i.name)).toContain("Nasi Katok"); // LIKE path still found it
  });
});
