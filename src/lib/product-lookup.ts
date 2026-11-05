import { eq } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import {
  product_lookup_cache,
  type LookupProduct,
  type LookupSource,
  type NutritionEstimate,
} from "../db/schema";
import type { Env } from "../env";
import { spendBudget } from "./budget";

// Task 1 — multi-source barcode lookup (spec §2, plan Task 1).
//
// Pipeline: normalize → product_lookup_cache read (TTL below) → ordered
// provider chain (OFF family → commercial fallbacks) with per-field
// first-provider-wins merge → cache write. GEPIR is out of scope for v1 —
// it verifies the brand-owner registrant only, no product data.
//
// Cache TTL is recomputed at read time from `found` + `sources` (no TTL
// column): OFF-family-only payloads 30d (ODbL permits redistribution),
// anything containing a commercial source 24h (merged answer only, never
// republished raw), negatives 7d (retry-storm protection).
//
// Provider budgets are counted in provider_budget(provider, day, calls) —
// a separate table, NOT derived from cache `sources`, because sources
// records only providers that *recognized* the code; misses and timeouts
// would undercount the commercial spend. Every outbound attempt consumes
// one unit before the request goes out.

const USER_AGENT = "laparku-menus/1.0";
const PROVIDER_TIMEOUT_MS = 5_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const OFF_TTL_MS = 30 * DAY_MS;
const COMMERCIAL_TTL_MS = 1 * DAY_MS;
const NEGATIVE_TTL_MS = 7 * DAY_MS;

const OFF_FAMILY = new Set(["openfoodfacts", "openbeautyfacts", "openpetfoodfacts", "openproductsfacts"]);

export interface LookupResult {
  found: boolean;
  product?: LookupProduct;
  sources: LookupSource[];
}

export interface NormalizedCode {
  /** Canonical cache key + first query candidate. */
  code: string;
  /** Ordered codes to try per provider (first = canonical). */
  candidates: string[];
}

/**
 * Validates 8–14 digits and normalizes: leading zeros are stripped down to
 * a minimum width of 8 (GTIN-14/ITF-14 padding and zero-padded UPC-As
 * collapse onto the same EAN/UPC). An 8-digit code may be EAN-8 or UPC-E —
 * when it expands to a check-digit-valid UPC-A that form is appended as a
 * second query candidate (scanners usually expand UPC-E themselves, but a
 * typed code may not be).
 */
export function normalizeBarcode(raw: string): NormalizedCode | null {
  const digits = raw.trim();
  if (!/^\d{8,14}$/.test(digits)) return null;
  // Leading-zero collapse applies only to 13–14 digit inputs (GTIN-14 /
  // zero-padded EAN-13), and never below the 12-digit UPC-A width — an
  // actual 8- or 12-digit code (EAN-8, UPC-E, UPC-A) is already canonical
  // and must keep a leading number-system 0.
  const code = digits.length >= 13 ? digits.replace(/^0+(?=\d{12})/, "") : digits;
  const candidates = [code];
  if (code.length === 8) {
    const upcA = upcEToUpcA(code);
    if (upcA) candidates.push(upcA);
  }
  return { code, candidates };
}

// UPC-E → UPC-A expansion. Returns the 12-digit UPC-A only when the
// expanded body's computed check digit equals the UPC-E's own check digit;
// otherwise the input is treated as a plain EAN-8 (no alternate).
function upcEToUpcA(upce: string): string | null {
  const ns = upce[0]!;
  if (ns !== "0" && ns !== "1") return null;
  const d = upce.slice(1, 7);
  const check = upce[7]!;
  const last = d[5]!;
  let body: string;
  if (last <= "2") body = ns + d[0] + d[1] + last + "0000" + d[2] + d[3] + d[4];
  else if (last === "3") body = ns + d[0] + d[1] + d[2] + "00000" + d[3] + d[4];
  else if (last === "4") body = ns + d[0] + d[1] + d[2] + d[3] + "00000" + d[4];
  else body = ns + d[0] + d[1] + d[2] + d[3] + d[4] + "0000" + last;
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += (body.charCodeAt(i) - 48) * (i % 2 === 0 ? 3 : 1);
  return String((10 - (sum % 10)) % 10) === check ? body + check : null;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(+v)) return +v;
  return undefined;
};

const MERGE_FIELDS = ["name", "brand", "package_size", "nutrition_estimate", "image_url"] as const;

interface ProviderHit extends LookupProduct {
  /** Public product page for provenance — never contains secrets. */
  url?: string;
}

interface Provider {
  name: string;
  /** Env secret required to call; provider is skipped when unset. */
  secret?: "EAN_SEARCH_TOKEN" | "UPCITEMDB_KEY" | "BARCODELookup_KEY";
  /** Outbound calls allowed per UTC day; undefined = unlimited (OFF family). */
  dailyBudget?: number;
  fetch: (code: string, env: Env) => Promise<ProviderHit | null>;
}

// Transport for every provider call. Returns null only for a definitive
// HTTP 404 ("no such product"). Everything else non-ok — 5xx, provider-side
// 429s — plus network failures, timeouts and unparseable bodies propagate
// as thrown errors: the chain treats them as non-answers (provider skipped,
// and never counted toward a negative cache write).
async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`provider HTTP ${res.status} for ${url}`);
  return await res.json();
}

// Open Food Facts and its sister DBs share the same API shape and ODbL
// license: {host}/api/v0/product/{code}.json → {status:1, product:{...}}.
// Each project lives at world.<project>.org — the food DB is
// world.openfoodfacts.org; the sisters are world.openbeautyfacts.org,
// world.openpetfoodfacts.org, world.openproductsfacts.org (the
// <country>.openfoodfacts.org subdomain pattern is food-only).
function offFetch(providerName: string) {
  const host = `world.${providerName}.org`;
  return async (code: string): Promise<ProviderHit | null> => {
    const data = (await fetchJson(`https://${host}/api/v0/product/${code}.json`)) as {
      status?: number;
      product?: Record<string, unknown>;
    } | null;
    if (!data || data.status !== 1 || typeof data.product !== "object" || data.product === null) return null;
    const p = data.product;
    const n = (p.nutriments ?? {}) as Record<string, unknown>;
    const nutrition: NutritionEstimate = { status: "estimated", source: providerName };
    let hasNutrition = false;
    for (const [nutriment, field] of [
      ["energy-kcal_100g", "calories_kcal"],
      ["proteins_100g", "protein_g"],
      ["carbohydrates_100g", "carbs_g"],
      ["fat_100g", "fat_g"],
    ] as const) {
      const v = num(n[nutriment]);
      if (v !== undefined) {
        (nutrition as Record<string, unknown>)[field] = v;
        hasNutrition = true;
      }
    }
    return {
      name: str(p.product_name) ?? str(p.product_name_en),
      brand: str(p.brands),
      package_size: str(p.quantity),
      nutrition_estimate: hasNutrition ? nutrition : undefined,
      image_url: str(p.image_front_url) ?? str(p.image_url),
      url: `https://${host}/product/${code}`,
    };
  };
}

// EAN-Search.org `op=barcode-lookup`. Assumed response shape (free tier):
// { product: [{ barcodeNumber, productName, categoryName, ... }] } — a bare
// { product: {...} } object is tolerated too. Only the name is reliable;
// the API doesn't carry brand/size/nutrition in the free response.
async function eansearchFetch(code: string, env: Env): Promise<ProviderHit | null> {
  const data = (await fetchJson(
    `https://www.ean-search.org/api?op=barcode-lookup&format=json&ean=${encodeURIComponent(code)}` +
      `&token=${encodeURIComponent(env.EAN_SEARCH_TOKEN!)}`,
  )) as { product?: Record<string, unknown> | Record<string, unknown>[] } | null;
  const product = Array.isArray(data?.product) ? data.product[0] : data?.product;
  if (!product || typeof product !== "object") return null;
  const name = str(product.productName) ?? str(product.name);
  if (!name) return null;
  return { name, url: `https://www.ean-search.org/?q=${encodeURIComponent(code)}` };
}

// UPCitemdb. Assumed response shape: { items: [{ title, brand, size,
// images: [url], ean, upc }] }. The key is sent as a `key` param (paid
// tier convention; the trial endpoint ignores it) — the provider is
// simply gated on the secret's presence per the plan.
async function upcitemdbFetch(code: string, env: Env): Promise<ProviderHit | null> {
  const data = (await fetchJson(
    `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}` +
      `&key=${encodeURIComponent(env.UPCITEMDB_KEY!)}`,
  )) as { items?: Record<string, unknown>[] } | null;
  const item = Array.isArray(data?.items) ? data.items[0] : undefined;
  if (!item || typeof item !== "object") return null;
  const image = Array.isArray(item.images) ? str(item.images[0]) : undefined;
  return {
    name: str(item.title),
    brand: str(item.brand),
    package_size: str(item.size),
    image_url: image,
    url: `https://www.upcitemdb.com/upc/${encodeURIComponent(code)}`,
  };
}

// BarcodeLookup.com v3. Assumed response shape: { products: [{
// product_name|title, brand, size, images: [url] }] }.
async function barcodelookupFetch(code: string, env: Env): Promise<ProviderHit | null> {
  const data = (await fetchJson(
    `https://api.barcodelookup.com/v3/products?barcode=${encodeURIComponent(code)}&formatted=y` +
      `&key=${encodeURIComponent(env.BARCODELookup_KEY!)}`,
  )) as { products?: Record<string, unknown>[] } | null;
  const product = Array.isArray(data?.products) ? data.products[0] : undefined;
  if (!product || typeof product !== "object") return null;
  const image = Array.isArray(product.images) ? str(product.images[0]) : undefined;
  return {
    name: str(product.product_name) ?? str(product.title),
    brand: str(product.brand),
    package_size: str(product.size),
    image_url: image,
    url: `https://www.barcodelookup.com/${encodeURIComponent(code)}`,
  };
}

// Ordered by license freedom + completeness (spec §2): free ODbL sources
// first; commercial free tiers (~200/~100/~50 calls/day) only as fallback,
// each behind its daily budget so a scan storm can't burn the trial.
const PROVIDERS: Provider[] = [
  { name: "openfoodfacts", fetch: offFetch("openfoodfacts") },
  { name: "openbeautyfacts", fetch: offFetch("openbeautyfacts") },
  { name: "openpetfoodfacts", fetch: offFetch("openpetfoodfacts") },
  { name: "openproductsfacts", fetch: offFetch("openproductsfacts") },
  { name: "eansearch", secret: "EAN_SEARCH_TOKEN", dailyBudget: 190, fetch: eansearchFetch },
  { name: "upcitemdb", secret: "UPCITEMDB_KEY", dailyBudget: 90, fetch: upcitemdbFetch },
  { name: "barcodelookup", secret: "BARCODELookup_KEY", dailyBudget: 45, fetch: barcodelookupFetch },
];

function cacheTtlMs(found: boolean, sources: LookupSource[]): number {
  if (!found) return NEGATIVE_TTL_MS;
  return sources.every((s) => OFF_FAMILY.has(s.provider)) ? OFF_TTL_MS : COMMERCIAL_TTL_MS;
}

// Provider budgets counted via the shared helper in src/lib/budget.ts
// (spend is recorded before the request — a timeout still consumed the
// attempt).

/**
 * Resolves a barcode to a merged product. Returns null for invalid input
 * (route maps it to 400). Cache-first; on miss walks the provider chain in
 * order, filling each field from the first provider that offers it and
 * accumulating every provider that recognized the code into `sources`.
 * A provider that errors or times out is skipped; the chain continues.
 */
export async function lookupProduct(rawCode: string, env: Env): Promise<LookupResult | null> {
  const normalized = normalizeBarcode(rawCode);
  if (!normalized) return null;
  const { code, candidates } = normalized;
  const db = getDb(env);
  const now = Date.now();

  const [cached] = await db
    .select()
    .from(product_lookup_cache)
    .where(eq(product_lookup_cache.code, code))
    .limit(1);
  if (cached && now - cached.fetched_at.getTime() < cacheTtlMs(cached.found, cached.sources)) {
    return {
      found: cached.found,
      ...(cached.found ? { product: cached.merged_payload } : {}),
      sources: cached.sources,
    };
  }

  const product: LookupProduct = {};
  const sources: LookupSource[] = [];
  const complete = () => MERGE_FIELDS.every((f) => product[f] !== undefined);
  const day = new Date(now).toISOString().slice(0, 10);
  // Whether ≥1 provider call completed with a definitive answer (hit OR
  // miss). An error/timeout is a non-answer: an all-down burst must not
  // write a 7-day negative, nor clobber an expired-but-good row below.
  let responded = false;

  for (const provider of PROVIDERS) {
    if (complete()) break;
    if (provider.secret && !env[provider.secret]) continue;
    let hit: ProviderHit | null = null;
    for (const candidate of candidates) {
      if (provider.dailyBudget !== undefined && !(await spendBudget(db, provider.name, provider.dailyBudget, day))) {
        break; // daily budget spent — provider is done for today
      }
      try {
        hit = await provider.fetch(candidate, env);
        responded = true;
      } catch {
        hit = null;
      }
      if (hit) break;
    }
    if (!hit) continue;
    sources.push(hit.url ? { provider: provider.name, url: hit.url } : { provider: provider.name });
    for (const field of MERGE_FIELDS) {
      if (product[field] === undefined && hit[field] !== undefined) {
        (product as Record<string, unknown>)[field] = hit[field];
      }
    }
  }

  if (!responded) {
    // Total outage — no provider gave an answer. Serve the stale row if we
    // have one (stale-if-error), never write a cache row, and report a miss
    // to the caller so the app falls back to the photo flow.
    if (cached) {
      return {
        found: cached.found,
        ...(cached.found ? { product: cached.merged_payload } : {}),
        sources: cached.sources,
      };
    }
    return { found: false, sources: [] };
  }

  const found = sources.length > 0;
  await db
    .insert(product_lookup_cache)
    .values({
      code,
      merged_payload: found ? product : {},
      sources,
      found,
      fetched_at: new Date(now),
    })
    .onConflictDoUpdate({
      target: product_lookup_cache.code,
      set: {
        merged_payload: found ? product : {},
        sources,
        found,
        fetched_at: new Date(now),
      },
    });

  return { found, ...(found ? { product } : {}), sources };
}
