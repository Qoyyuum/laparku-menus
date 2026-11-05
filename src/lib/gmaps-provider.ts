// Google Maps place-data provider chain for the gmaps_link import.
//
// Ordered providers — same chain semantics as product-lookup.ts: providers
// registered in GMAPS_PROVIDER (comma-separated) are tried in order, skipped
// on missing secret/binding or a spent daily budget; a thrown error moves
// to the next provider. The first definitive answer wins; a provider's
// "empty" verdict only settles the import when nothing else answers better.
//
// Providers:
//   browser  — Cloudflare Browser Run headless Chrome (env.BROWSER).
//              Budget counted in session-seconds vs GMAPS_DAILY_BROWSER_SECONDS.
//   serpfast — serpfast.com Maps API (env.SERPFAST_API_KEY). Budget counted
//              in calls vs SERPFAST_DAILY_CALL_CAP.
//   stub     — tests; setStubGmapsProvider() controls the answer, no network.

import { getDb, type Db } from "../db/client";
import type { Env } from "../env";
import { budgetAvailable, recordSpend, spendBudget, utcDay } from "./budget";
import { sniffMagic, SNIFFED_MIME, MAX_FILES } from "./files";
import type { GmapsResolved } from "./gmaps";

// --- shared shape -----------------------------------------------------------

export interface GmapsMenuItem {
  name: string;
  price?: number;
  description?: string;
}

export interface GmapsMenuSection {
  name: string;
  items: GmapsMenuItem[];
}

export interface GmapsPlaceData {
  // Which provider produced the answer — recorded on raw_extraction.gmaps.
  provider: string;
  place: {
    name?: string;
    address?: string;
    lat?: number;
    lng?: number;
    categories?: string[];
  };
  // [] = the provider checked and the place has no structured menu.
  sections: GmapsMenuSection[];
  photo_urls: string[];
}

// "ok" = a definitive place answer (sections may be empty — "no menu" is an
// answer). "empty" = the provider saw the place/equivalent but found nothing
// usable — the chain may still try the next provider for a richer answer.
// A thrown error = provider unavailable → try the next one.
export type GmapsFetchResult = { kind: "ok"; data: GmapsPlaceData } | { kind: "empty" };

interface GmapsProviderImpl {
  name: string;
  ready(env: Env): boolean;
  // `db` is threaded through for per-provider budget accounting.
  fetch(resolved: GmapsResolved, env: Env, db: Db): Promise<GmapsFetchResult>;
}

const DEFAULT_BROWSER_SECONDS = 1_200;
const DEFAULT_SERPFAST_CALLS = 60;

function browserSecondsCap(env: Env): number {
  const n = Number(env.GMAPS_DAILY_BROWSER_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BROWSER_SECONDS;
}

function serpfastCallCap(env: Env): number {
  const n = Number(env.SERPFAST_DAILY_CALL_CAP);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SERPFAST_CALLS;
}

// --- browser provider (Cloudflare Browser Run) ------------------------------
//
// The place page embeds the full record in APP_INITIALIZATION_STATE; the
// Menu tab additionally renders item rows in the DOM. We do both: read the
// serialized state for place identity + photo URLs, and click the Menu tab
// for structured items. Text-block parsing of the rendered menu is the
// brittle-but-workable v1; the serpfast provider is the chain fallback.

const CONSENT_HOST_RE = /consent\.google\./;
const PHOTO_URL_RE = /https:\/\/(?:lh3|lh\d|streetviewpixels-pa|geo\d)\.googleusercontent\.com\/[^\s"'\\)\]]+/g;
// "B$12.50" / "BND 12" / "$8" price tokens on a rendered menu line.
const PRICE_LINE_RE = /^(?:B\$|BND\s?|\$)\s?(\d+(?:\.\d{1,2})?)\s*$/;

interface BrowserEvalResult {
  place?: { name?: string; address?: string; categories?: string[] };
  menu_lines?: string[];
  photo_urls?: string[];
  has_menu_tab?: boolean;
}

// Everything DOM/page-state reading lives inside one evaluate so the queue
// worker holds exactly one browser round-trip after the tab click.
const EXTRACT_FN = `(() => {
  const text = (el) => (el && el.textContent ? el.textContent.trim() : undefined);
  const out = { place: {}, menu_lines: [], photo_urls: [], has_menu_tab: false };
  out.place.name = text(document.querySelector("h1"));
  // Address carries a stable data-item-id in the place panel.
  out.place.address = text(document.querySelector('[data-item-id="address"]'));
  const catBtn = document.querySelector('button[jsaction*="category"], button.DkEaL');
  const cat = text(catBtn);
  if (cat) out.place.categories = [cat];
  // Menu tab — active state after the caller's click.
  const tabs = [...document.querySelectorAll('[role="tab"], button')];
  const menuTab = tabs.find((t) => /(^|\\s)menu(\\s|$)/i.test(t.textContent || ""));
  out.has_menu_tab = !!menuTab;
  // Rendered menu items live in a scrollable panel; grab its text lines and
  // let the worker-side parser group them into items. The panel is the
  // last tabpanel/main region visible.
  const panel = document.querySelector('[role="main"], [role="tabpanel"], #mapp') || document.body;
  out.menu_lines = (panel.innerText || "").split("\\n").map((s) => s.trim()).filter(Boolean).slice(0, 400);
  // Photo URLs from page images + serialized state.
  const urls = new Set();
  for (const img of document.querySelectorAll("img")) {
    const src = img.currentSrc || img.src || "";
    if (/googleusercontent\\.com/.test(src)) urls.add(src);
  }
  try {
    const state = JSON.stringify(window.APP_INITIALIZATION_STATE || null);
    for (const m of state.matchAll(${PHOTO_URL_RE.toString()})) urls.add(m[0]);
  } catch {}
  out.photo_urls = [...urls].slice(0, 24);
  return out;
})()`;

// Group rendered menu-panel lines into sections/items. Format is Google's:
// a section header line, then repeating name/price/description blocks in
// visual order. Heuristic: a line that is exactly a price token attaches to
// the preceding name line; other lines are candidate names (section headers
// look like names too — a section ends when another short line is followed
// by another short line... this is genuinely lossy, which is fine: the
// output either lands in review or behind pending_verification).
export function parseMenuLines(lines: string[]): GmapsMenuSection[] {
  const items: GmapsMenuItem[] = [];
  let pending: string[] = [];
  const flush = () => {
    // pending is a run of non-price lines — the first is the item name,
    // the rest description fragments.
    if (pending.length > 0) {
      items.push({ name: pending[0]!, ...(pending.length > 1 ? { description: pending.slice(1).join(" ") } : {}) });
      pending = [];
    }
  };
  for (const line of lines) {
    const priceMatch = line.match(PRICE_LINE_RE);
    if (priceMatch) {
      flush();
      const price = Number(priceMatch[1]);
      if (items.length > 0 && items[items.length - 1]!.price === undefined) {
        items[items.length - 1]!.price = price;
      }
      continue;
    }
    pending.push(line);
  }
  flush();
  return items.length > 0 ? [{ name: "Menu", items }] : [];
}

async function fetchWithBrowser(resolved: GmapsResolved, env: Env, db: Db): Promise<GmapsFetchResult> {
  const day = utcDay(new Date());
  if (!(await budgetAvailable(db, "browser_run", browserSecondsCap(env), day))) {
    throw new Error("browser_run daily budget exhausted");
  }
  // Defer the puppeteer import so tests/stub never load the module.
  const puppeteer = (await import("@cloudflare/puppeteer")).default;

  const started = Date.now();
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER as unknown as Parameters<typeof puppeteer.launch>[0]);
    const page = await browser.newPage();
    const target = resolved.resolved_url + (resolved.resolved_url.includes("?") ? "&" : "?") + "hl=en&gl=bn";
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Google consent interstitial — click through it (fixed settle delay;
    // CF's puppeteer subset doesn't expose waitForNavigation).
    if (CONSENT_HOST_RE.test(page.url())) {
      await page.evaluate(`(() => {
        const btn = [...document.querySelectorAll("button")]
          .find((b) => /accept all|i agree|agree/i.test(b.textContent || ""));
        if (btn) btn.click();
      })()`);
      await new Promise((r) => setTimeout(r, 2_500));
    }

    // Place panel identity: h1 for the venue name is the reliable anchor.
    await page.waitForSelector("h1", { timeout: 15_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1_500));

    // Open the Menu tab when the place has one.
    const clickedMenu = await page.evaluate(`(() => {
      const tabs = [...document.querySelectorAll('[role="tab"], button')];
      const t = tabs.find((el) => /(^|\\s)menu(\\s|$)/i.test((el.textContent || "").trim()));
      if (t) { t.click(); return true; }
      return false;
    })()`);
    if (clickedMenu) await new Promise((r) => setTimeout(r, 2_000));

    const data = (await page.evaluate(EXTRACT_FN)) as unknown as BrowserEvalResult;

    const sections = clickedMenu ? parseMenuLines(data.menu_lines ?? []) : [];
    const photoUrls = data.photo_urls ?? [];
    if (!sections.length && !photoUrls.length && !data.place?.name) {
      return { kind: "empty" };
    }
    return {
      kind: "ok",
      data: {
        provider: "browser",
        place: data.place ?? {},
        sections,
        photo_urls: photoUrls,
      },
    };
  } finally {
    // Always close — an idle session bills browser-seconds until the 60 s
    // inactivity timeout (see Browser Run limits docs).
    if (browser) {
      await browser.close().catch(() => {});
    }
    await recordSpend(db, "browser_run", day, (Date.now() - started) / 1000);
  }
}

// --- serpfast provider --------------------------------------------------------

const SERPFAST_BASE = "https://serpfast.com/api/v1/google/maps";

function serpfastIds(resolved: GmapsResolved): URLSearchParams {
  const p = new URLSearchParams({ hl: "en", gl: "bn" });
  if (resolved.place_id) p.set("place_id", resolved.place_id);
  else if (resolved.data_id) p.set("data_id", resolved.data_id);
  else if (resolved.data_cid) p.set("data_cid", resolved.data_cid);
  else throw new Error("serpfast needs a place_id, data_id or data_cid");
  return p;
}

async function serpfastGet(path: string, params: URLSearchParams, env: Env): Promise<unknown> {
  const res = await fetch(`${SERPFAST_BASE}${path}?${params}`, {
    headers: { authorization: `Bearer ${env.SERPFAST_API_KEY}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null; // "not found" — unbilled
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`serpfast HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// serpfast /menu accepts place_id ONLY — a link that resolved to a data_id
// or cid must first be translated via /maps (which takes data_id), which
// returns the place's ChIJ id.
async function serpfastPlaceId(resolved: GmapsResolved, env: Env, db: Db): Promise<string | null> {
  if (resolved.place_id) return resolved.place_id;
  const params = new URLSearchParams({ hl: "en", gl: "bn" });
  if (resolved.data_id) params.set("data_id", resolved.data_id);
  else if (resolved.data_cid) params.set("data_cid", resolved.data_cid);
  else return null;
  if (!(await spendBudget(db, "serpfast", serpfastCallCap(env), utcDay(new Date())))) {
    throw new Error("serpfast daily budget exhausted");
  }
  const json = await serpfastGet("/maps", params, env);
  if (json === null) return null;
  // Walk the response for the first ChIJ place id + details.
  const found: { place_id?: string } = {};
  const walk = (node: unknown, depth: number) => {
    if (found.place_id || depth > 8 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return void node.forEach((el) => walk(el, depth + 1));
    const rec = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if (k === "place_id" && typeof v === "string" && /^ChI[jJ]/.test(v)) found.place_id = v;
      else walk(v, depth + 1);
    }
  };
  walk(json, 0);
  return found.place_id ?? null;
}

// serpfast response groups vary by page — walk whatever JSON came back and
// pull out the three things we need. Field names are guess-checked against
// SerpApi-style shapes (place/local_result, menu.categories, photos[]).
function normalizeSerpfast(json: unknown): Partial<GmapsPlaceData> {
  const out: Partial<GmapsPlaceData> = { photo_urls: [] };
  const photos = new Set<string>();
  const PHOTO_KEY_RE = /^(image|image_url|thumbnail|photo_url|url|src)$/;
  const looksPhoto = (s: string) => /googleusercontent|ggpht|gstatic|serpapi/i.test(s);

  const walk = (node: unknown, depth: number) => {
    if (depth > 8 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const el of node) walk(el, depth + 1);
      return;
    }
    const rec = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if (typeof v === "string" && PHOTO_KEY_RE.test(k) && looksPhoto(v)) photos.add(v);
      walk(v, depth + 1);
    }
  };
  walk(json, 0);
  out.photo_urls = [...photos].slice(0, 24);

  // Place details: find the object that carries a name — prefer explicit
  // place/local_result keys.
  const rec = json as Record<string, unknown>;
  const placeObj =
    (rec.place ?? rec.local_result ?? rec.result ?? rec.business ?? rec) as Record<string, unknown>;
  const name = typeof placeObj.name === "string" ? placeObj.name : typeof placeObj.title === "string" ? placeObj.title : undefined;
  const address = typeof placeObj.address === "string" ? placeObj.address : undefined;
  const gps = placeObj.gps_coordinates as Record<string, unknown> | undefined;
  const lat = Number(gps?.latitude);
  const lng = Number(gps?.longitude);
  const categories = Array.isArray(placeObj.categories)
    ? (placeObj.categories as unknown[]).filter((c): c is string => typeof c === "string")
    : typeof placeObj.type === "string"
      ? [placeObj.type]
      : undefined;
  out.place = {
    ...(name ? { name } : {}),
    ...(address ? { address } : {}),
    ...(Number.isFinite(lat) ? { lat } : {}),
    ...(Number.isFinite(lng) ? { lng } : {}),
    ...(categories ? { categories } : {}),
  };

  // Structured menu: hunt for arrays of objects carrying {name, price}.
  const menuNode =
    (rec.menu ?? rec.menus ?? placeObj.menu) as Record<string, unknown> | unknown[] | undefined;
  const sectionArrays: GmapsMenuSection[] = [];
  const priceOf = (o: Record<string, unknown>): number | undefined => {
    const raw = o.price ?? o.price_value ?? o.priceValue;
    if (typeof raw === "number") return raw;
    if (typeof raw === "string") {
      const m = raw.match(/(\d+(?:\.\d{1,2})?)/);
      return m ? Number(m[1]) : undefined;
    }
    return undefined;
  };
  const toItem = (o: Record<string, unknown>): GmapsMenuItem | null => {
    const n = o.name ?? o.itemName ?? o.title ?? o.item_name;
    if (typeof n !== "string" || !n.trim()) return null;
    const desc = o.description ?? o.itemDescription ?? o.desc;
    return {
      name: n.trim(),
      ...(priceOf(o) !== undefined ? { price: priceOf(o) } : {}),
      ...(typeof desc === "string" && desc.trim() ? { description: desc.trim() } : {}),
    };
  };
  const harvestSections = (node: unknown, label?: string, depth = 0): void => {
    if (depth > 6 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      const items = node
        .map((el) => (typeof el === "object" && el !== null ? toItem(el as Record<string, unknown>) : null))
        .filter((i): i is GmapsMenuItem => i !== null);
      if (items.length >= 2 && items.some((i) => i.price !== undefined)) {
        sectionArrays.push({ name: label ?? "Menu", items });
        return;
      }
      for (const el of node) harvestSections(el, label, depth + 1);
      return;
    }
    const rec2 = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec2)) {
      const nested =
        typeof v === "object" && v !== null && !Array.isArray(v)
          ? ((v as Record<string, unknown>).items ?? (v as Record<string, unknown>).entries)
          : undefined;
      if (Array.isArray(nested)) harvestSections(nested, String((v as Record<string, unknown>).name ?? k), depth + 1);
      else harvestSections(v, /section|categor|group/i.test(k) ? String((node as Record<string, unknown>).name ?? k) : label, depth + 1);
    }
  };
  if (menuNode) harvestSections(menuNode);
  out.sections = sectionArrays;
  return out;
}

async function fetchWithSerpfast(resolved: GmapsResolved, env: Env, db: Db): Promise<GmapsFetchResult> {
  const day = utcDay(new Date());
  const cap = serpfastCallCap(env);
  const spend = () => spendBudget(db, "serpfast", cap, day);
  if (!(await spend())) throw new Error("serpfast daily budget exhausted");

  // /menu accepts only a ChIJ place_id — translate data_id/cid links via
  // /maps first (an extra call only when the share link lacks one).
  const placeId = await serpfastPlaceId(resolved, env, db);
  if (placeId === null && !resolved.place_id && !resolved.data_id && !resolved.data_cid) {
    return { kind: "empty" }; // no identifier serpfast can use at all
  }
  let menuJson: unknown = null;
  if (placeId !== null) {
    menuJson = await serpfastGet("/menu", new URLSearchParams({ place_id: placeId, hl: "en", gl: "bn" }), env);
  }
  if (menuJson !== null) {
    const norm = normalizeSerpfast(menuJson);
    const sections = norm.sections ?? [];
    const photos = norm.photo_urls ?? [];
    return {
      kind: "ok",
      data: { provider: "serpfast", place: norm.place ?? {}, sections, photo_urls: photos },
    };
  }

  // No structured menu — the photo categories may still exist (404s are
  // free on serpfast). /photos takes data_id or place_id — prefer the
  // translated place_id when we have one.
  // KNOWN ISSUE: the "menu" category frequently returns storefront/location
  // photos rather than menu images (observed on Chop Jing Chew — facade
  // shots imported instead of the ~18 menu shots shown in the Maps Menu
  // tab). Photos are filed for review anyway, so quality is reviewable —
  // but consider paginating/widening categories or the extension-snapshot
  // flow (docs/superpowers/specs/2026-11-05-extension-snapshot-import.md).
  const photoIds = placeId !== null ? new URLSearchParams({ place_id: placeId }) : serpfastIds(resolved);
  const photos: string[] = [];
  for (const category of ["menu", "food_and_drink"]) {
    if (photos.length >= MAX_FILES) break;
    if (!(await spend())) break;
    const params = new URLSearchParams(photoIds);
    params.set("category", category);
    params.set("hl", "en");
    params.set("gl", "bn");
    const page = await serpfastGet("/photos", params, env);
    if (page === null) continue;
    const norm = normalizeSerpfast(page);
    photos.push(...(norm.photo_urls ?? []));
  }
  if (photos.length === 0) return { kind: "empty" };
  return {
    kind: "ok",
    data: {
      provider: "serpfast",
      place: {},
      sections: [],
      photo_urls: [...new Set(photos)],
    },
  };
}

// --- stub provider ------------------------------------------------------------

type StubSource =
  | GmapsFetchResult
  | ((resolved: GmapsResolved) => GmapsFetchResult | Promise<GmapsFetchResult>);

const DEFAULT_STUB: GmapsFetchResult = { kind: "empty" };
let stubSource: StubSource = DEFAULT_STUB;

/** Test hook: choose what the `stub` provider returns. */
export function setStubGmapsProvider(next: StubSource): void {
  stubSource = next;
}

export function resetStubGmapsProvider(): void {
  stubSource = DEFAULT_STUB;
}

// --- chain ------------------------------------------------------------------

const PROVIDERS: Record<string, GmapsProviderImpl> = {
  browser: {
    name: "browser",
    ready: (env) => env.BROWSER !== undefined,
    fetch: fetchWithBrowser,
  },
  serpfast: {
    name: "serpfast",
    ready: (env) => Boolean(env.SERPFAST_API_KEY),
    fetch: fetchWithSerpfast,
  },
  stub: {
    name: "stub",
    ready: () => true,
    fetch: async (resolved) => (typeof stubSource === "function" ? stubSource(resolved) : stubSource),
  },
};

export function providerChain(env: Env): string[] {
  const list = (env.GMAPS_PROVIDER ?? "browser,serpfast")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : ["browser", "serpfast"];
}

/**
 * Walk the provider chain for a resolved Maps link. Returns the first "ok"
 * answer, an "empty" verdict if any provider definitively found nothing,
 * or throws when every provider was unavailable (missing secret/budget or
 * an error) — the caller treats a throw as retryable.
 */
export async function fetchPlaceData(resolved: GmapsResolved, env: Env): Promise<GmapsFetchResult> {
  const db = getDb(env);
  let sawEmpty = false;
  for (const name of providerChain(env)) {
    const provider = PROVIDERS[name];
    if (!provider || !provider.ready(env)) continue;
    let result: GmapsFetchResult;
    try {
      result = await provider.fetch(resolved, env, db);
    } catch (e) {
      console.error(`gmaps provider ${name} failed`, e);
      continue;
    }
    if (result.kind === "ok") return result;
    sawEmpty = true;
  }
  if (sawEmpty) return { kind: "empty" };
  throw new Error("no gmaps provider available");
}

// --- photo download -----------------------------------------------------------

// Fetch photo URLs into R2-ready image payloads. Magic-byte sniffed — a
// URL answering HTML or junk is dropped, never stored.
export async function downloadPhotos(urls: string[], cap = MAX_FILES): Promise<{ bytes: Uint8Array; mime: string }[]> {
  const out: { bytes: Uint8Array; mime: string }[] = [];
  for (const url of urls.slice(0, cap)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const type = sniffMagic(bytes);
      if (type && type !== "pdf") out.push({ bytes, mime: SNIFFED_MIME[type] });
    } catch {
      // unreachable/expired URL — skip it
    }
  }
  return out;
}
