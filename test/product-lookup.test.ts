import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDb } from "../src/db/client";
import { product_lookup_cache, provider_budget } from "../src/db/schema";

// Every test uses a distinct barcode — D1 persists for the whole file, and
// the lookup cache would otherwise leak hits between tests.
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const OFF_MISS = () => json({ status: 0, status_verbose: "product not found" }, 404);

// Stubs the one outbound channel lookupProduct uses — globalThis.fetch.
// Returns the requested URLs so tests can assert exactly which providers
// were consulted (and which were skipped).
function mockProviders(respond: (url: string) => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return respond(url);
    }),
  );
  return calls;
}

const KEY_PROPS = ["EAN_SEARCH_TOKEN", "UPCITEMDB_KEY", "BARCODELookup_KEY"] as const;

beforeEach(() => {
  for (const k of KEY_PROPS) (env as unknown as Record<string, unknown>)[k] = undefined;
});
afterEach(() => {
  for (const k of KEY_PROPS) (env as unknown as Record<string, unknown>)[k] = undefined;
  vi.unstubAllGlobals();
});

const lookup = (code: string) => SELF.fetch(`https://x/api/products/lookup/${code}`);
const providersOf = (body: { sources: { provider: string }[] }) => body.sources.map((s) => s.provider);

it("rejects non-digit and wrong-length codes with 400", async () => {
  for (const bad of ["abc", "1234567", "123456789012345", "1234abc890123"]) {
    expect((await lookup(bad)).status).toBe(400);
  }
});

it("accepts an 8–14 digit code; a complete OFF hit answers 200 with the product", async () => {
  mockProviders(() => json({ status: 1, product: { product_name: "Test Chips" } }));
  const res = await lookup("8888000000013");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { found: boolean; product?: { name?: string } };
  expect(body.found).toBe(true);
  expect(body.product?.name).toBe("Test Chips");
});

it("caches a hit: the second lookup for the same code makes no provider calls", async () => {
  const code = "8888000000020";
  const calls = mockProviders((url) =>
    url.includes("world.openfoodfacts.org")
      ? json({
          status: 1,
          product: {
            product_name: "Nasi Chips",
            brands: "Mister",
            quantity: "60g",
            nutriments: {
              "energy-kcal_100g": 500,
              proteins_100g: 7,
              fat_100g: 25,
              carbohydrates_100g: 60,
            },
            image_front_url: "https://img.off/chips.jpg",
          },
        })
      : OFF_MISS(),
  );

  const first = (await (await lookup(code)).json()) as {
    found: boolean;
    product?: Record<string, unknown>;
    sources: { provider: string; url?: string }[];
  };
  expect(first.found).toBe(true);
  expect(first.product).toMatchObject({
    name: "Nasi Chips",
    brand: "Mister",
    package_size: "60g",
    image_url: "https://img.off/chips.jpg",
  });
  expect(first.product?.nutrition_estimate).toMatchObject({
    calories_kcal: 500,
    protein_g: 7,
    fat_g: 25,
    carbs_g: 60,
  });
  expect(providersOf(first)).toEqual(["openfoodfacts"]);
  expect(first.sources[0]?.url).toContain(code);

  const callsAfterFirst = calls.length;
  const second = await (await lookup(code)).json();
  expect(second).toEqual(first);
  expect(calls.length).toBe(callsAfterFirst);

  const [row] = await getDb(env)
    .select()
    .from(product_lookup_cache)
    .where(eq(product_lookup_cache.code, code));
  expect(row?.found).toBe(true);
});

it("merges per-field first-provider-wins; sources accumulates every provider that recognized the code", async () => {
  env.EAN_SEARCH_TOKEN = "t";
  env.UPCITEMDB_KEY = "u";
  env.BARCODELookup_KEY = "b";
  const code = "8888000000037";
  mockProviders((url) => {
    if (url.includes("world.openfoodfacts.org")) {
      return json({ status: 1, product: { product_name: "Mystery Snack" } });
    }
    if (url.includes("petfood.openfoodfacts.org")) {
      return json({ status: 1, product: { brands: "PetBrand", quantity: "500g" } });
    }
    if (url.includes("ean-search.org")) {
      // Recognizes the code but offers nothing new (name already filled).
      return json({ product: [{ productName: "Ean Search Snack" }] });
    }
    if (url.includes("upcitemdb.com")) {
      return json({ items: [{ title: "Upc Snack", images: ["https://img.upc/x.jpg"] }] });
    }
    return OFF_MISS();
  });

  const body = (await (await lookup(code)).json()) as {
    found: boolean;
    product?: Record<string, unknown>;
    sources: { provider: string }[];
  };
  expect(body.found).toBe(true);
  expect(body.product?.name).toBe("Mystery Snack"); // first provider wins
  expect(body.product?.brand).toBe("PetBrand"); // gaps filled downstream
  expect(body.product?.package_size).toBe("500g");
  expect(body.product?.image_url).toBe("https://img.upc/x.jpg");
  // barcodelookup missed (empty products) → not in sources.
  expect(providersOf(body)).toEqual(["openfoodfacts", "openpetfoodfacts", "eansearch", "upcitemdb"]);
});

it("skips commercial providers whose secret is unset", async () => {
  env.UPCITEMDB_KEY = "u"; // EAN_SEARCH_TOKEN + BARCODELookup_KEY stay unset
  const code = "8888000000044";
  const calls = mockProviders((url) =>
    url.includes("upcitemdb.com") ? json({ items: [{ title: "UPC Only", brand: "Ub" }] }) : OFF_MISS(),
  );

  const body = (await (await lookup(code)).json()) as {
    found: boolean;
    product?: { name?: string; brand?: string };
    sources: { provider: string }[];
  };
  expect(body.found).toBe(true);
  expect(body.product?.name).toBe("UPC Only");
  expect(body.product?.brand).toBe("Ub");
  expect(providersOf(body)).toEqual(["upcitemdb"]);
  expect(calls.some((u) => u.includes("ean-search.org"))).toBe(false);
  expect(calls.some((u) => u.includes("barcodelookup.com"))).toBe(false);
});

it("OFF-family 404 → found:false, cached as a negative (no refetch)", async () => {
  const code = "8888000000051";
  const calls = mockProviders(() => OFF_MISS());

  const first = await (await lookup(code)).json();
  expect(first).toEqual({ found: false, sources: [] });
  const callsAfterFirst = calls.length; // 4 OFF-family hosts; no keys → commercials skipped

  const second = await (await lookup(code)).json();
  expect(second).toEqual({ found: false, sources: [] });
  expect(calls.length).toBe(callsAfterFirst);

  const [row] = await getDb(env)
    .select()
    .from(product_lookup_cache)
    .where(eq(product_lookup_cache.code, code));
  expect(row?.found).toBe(false);
});

it("hard-stops a commercial provider once its daily budget is spent", async () => {
  env.BARCODELookup_KEY = "b";
  const day = new Date().toISOString().slice(0, 10);
  // Earlier tests may already have burned calls today — set, don't insert.
  await getDb(env)
    .insert(provider_budget)
    .values({ provider: "barcodelookup", day, calls: 45 })
    .onConflictDoUpdate({
      target: [provider_budget.provider, provider_budget.day],
      set: { calls: 45 },
    });
  const code = "8888000000068";
  const calls = mockProviders((url) =>
    url.includes("barcodelookup.com") ? json({ products: [{ product_name: "BL Hit" }] }) : OFF_MISS(),
  );

  const body = await (await lookup(code)).json();
  expect(body).toEqual({ found: false, sources: [] });
  expect(calls.some((u) => u.includes("barcodelookup.com"))).toBe(false);
});

it("a provider that errors is skipped; the chain continues", async () => {
  const code = "8888000000075";
  mockProviders((url) => {
    if (url.includes("world.openfoodfacts.org")) throw new Error("off down");
    if (url.includes("beauty.openfoodfacts.org")) {
      return json({ status: 1, product: { product_name: "Beauty Bar" } });
    }
    return OFF_MISS();
  });

  const body = (await (await lookup(code)).json()) as {
    found: boolean;
    product?: { name?: string };
    sources: { provider: string }[];
  };
  expect(body.found).toBe(true);
  expect(body.product?.name).toBe("Beauty Bar");
  expect(providersOf(body)).toEqual(["openbeautyfacts"]);
});
