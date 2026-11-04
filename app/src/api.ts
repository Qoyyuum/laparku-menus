// API client for the laparku-menus worker.
//
// `EXPO_PUBLIC_API_URL` is the base URL of the public API, e.g.
// "https://laparku-menus.<sub>.workers.dev/api". When unset it defaults to the
// relative path "/api" — correct on web, where the worker serves this app and
// the API from the same origin. On native builds set the env var to the
// deployed worker URL before running `expo export` / `expo start`.
import { Platform } from "react-native";

const API_BASE = (process.env.EXPO_PUBLIC_API_URL ?? "/api").replace(/\/+$/, "");

export { API_BASE };

// The better-auth client appends `/api/auth` itself, so it needs the bare
// worker origin — API_BASE minus its `/api` suffix. Empty string means
// "same origin" (the web export is served by the worker); in that case the
// client resolves window.location.origin, so pass `undefined` instead.
export const AUTH_ORIGIN = API_BASE.startsWith("http") ? API_BASE.replace(/\/api$/, "") : "";

export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  if (Platform.OS !== "web" && API_BASE.startsWith("/")) {
    throw new Error(
      "EXPO_PUBLIC_API_URL is not set — native builds need the deployed worker API URL " +
        "(e.g. https://<worker>.workers.dev/api).",
    );
  }
  const url = `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`API request failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

// --- Types mirroring the worker's public read API (src/routes/public.ts) ---

export const VENUE_TYPES = ["restaurant", "stall", "supermarket", "grocer", "convenience"] as const;
export const AREAS = ["Brunei-Muara", "Tutong", "Belait", "Temburong"] as const;
export const HALAL_STATUSES = ["halal-certified", "muslim-owned", "non-halal", "unknown", "n-a"] as const;
export const ITEM_TYPES = ["dish", "product"] as const;

export interface NutritionEstimate {
  status?: "estimated" | "verified";
  calories_kcal?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
  [key: string]: unknown;
}

export interface Venue {
  id: string;
  name: string;
  name_ms: string | null;
  type: (typeof VENUE_TYPES)[number];
  area: (typeof AREAS)[number];
  address: string | null;
  instagram: string | null;
  website: string | null;
  halal_status: (typeof HALAL_STATUSES)[number];
  verification: "unverified" | "verified" | "claimed-by-owner";
  // Coverage stub: a name+area-only placeholder flagged "menu needed" —
  // cleared server-side once a submission is approved onto the venue.
  is_stub?: boolean;
  // Derived on the worker from last_verified_at vs STALE_MONTHS
  // (src/lib/freshness.ts): <3mo fresh, <6mo aging, otherwise stale.
  freshness?: "fresh" | "aging" | "stale";
  last_verified_at?: number | null;
}

export interface FoodItem {
  id: string;
  venue_id: string;
  item_type: (typeof ITEM_TYPES)[number];
  name: string;
  name_ms: string | null;
  description: string | null;
  price_bnd: number | null;
  category: string | null;
  tags: string[];
  nutrition_estimate: NutritionEstimate | null;
  brand: string | null;
  barcode: string | null;
  // True on trusted-published scan items until a reviewer verifies —
  // the app renders the "recently scanned" badge off this.
  pending_verification: boolean;
  // Contributor credit (Task 7): the sourcing submitter's verified social
  // handle (preferred_social) — present only when that user opted in via
  // show_credit; absent otherwise. Freeform names never ride this field.
  contributed_by?: string;
}

export interface SearchResult {
  venues: Venue[];
  items: FoodItem[];
}

// --- Types mirroring the reviewer surface (src/routes/admin.ts) ------------

export const SOURCE_TYPES = [
  "menu_pdf",
  "menu_photo",
  "product_photo",
  "barcode",
  "url",
  "manual_entry",
] as const;

// The editable draft item reviewers approve (mirrors DraftItem in
// src/lib/extractor.ts).
export interface DraftItem {
  name: string;
  name_ms?: string;
  description?: string;
  price_bnd?: number;
  category?: string;
  item_type: "dish" | "product";
  brand?: string;
  barcode?: string;
  nutrition_estimate?: NutritionEstimate;
}

export interface ExtractionDraft {
  has_food_content?: boolean;
  confidence?: number;
  venue_guess?: { name: string; type?: string; area?: string } | null;
  items?: DraftItem[];
  suspicion?: string[];
  [key: string]: unknown;
}

export interface QueueSubmission {
  id: string;
  submitter_id: string | null;
  contact: string | null;
  source_type: (typeof SOURCE_TYPES)[number];
  provenance: string;
  image_keys: string[];
  raw_extraction: ExtractionDraft | null;
  confidence: number | null;
  auto_flags: string[];
  status: string;
  rejection_reason: string | null;
  created_at: number;
  // Joined from submitters by the admin list endpoint.
  submitter_trust_tier: "anonymous" | "new" | "trusted" | null;
}

// A trusted-published item awaiting the reviewer double-check (mirrors
// GET /api/admin/pending-verification — the item row plus venue, source
// submission, lookup provenance, and the submitter's overrides vs the
// lookup payload).
export interface PendingVerificationItem extends FoodItem {
  package_size: string | null;
  barcode_source: string[] | null;
  off_barcode: string | null;
  source_submission_id: string | null;
  status: string;
  is_current: boolean;
  created_at: number;
  venue_name: string;
  submission:
    | (QueueSubmission & {
        publish_mode: "reviewed" | "trusted" | null;
        scan_barcode: string | null;
        user_id: string | null;
      })
    | null;
  lookup: {
    code: string;
    merged_payload: {
      name?: string;
      brand?: string;
      package_size?: string;
      nutrition_estimate?: NutritionEstimate;
      image_url?: string;
    };
    sources: { provider: string; url?: string }[];
    found: boolean;
    fetched_at: number;
  }[];
  // Fields the submitter changed relative to the lookup payload —
  // { field: { lookup, submitted } }.
  overrides: Record<string, { lookup: unknown; submitted: unknown }>;
}

// Post-publish item report (mirrors GET /api/admin/flags — the flag row
// joined with its item + venue names).
export interface ItemFlag {
  id: string;
  item_id: string;
  reason: string;
  reporter_contact: string | null;
  status: "open" | "resolved";
  created_at: number;
  item_name: string;
  venue_id: string;
  venue_name: string;
}

// --- Types mirroring the leaderboard surface (src/routes/leaderboards.ts) --

export const LEADERBOARD_KINDS = ["checkins", "contributions", "verifications"] as const;
export type LeaderboardKind = (typeof LEADERBOARD_KINDS)[number];
export const LEADERBOARD_PERIODS = ["week", "month", "all"] as const;
export type LeaderboardPeriod = (typeof LEADERBOARD_PERIODS)[number];

export interface LeaderboardRow {
  rank: number;
  // Verified social handle for opted-in users, "Anonymous" otherwise.
  name: string;
  count: number;
  // Highest-tier earned badge key — opted-in rows only, null otherwise.
  top_badge?: string | null;
}

export interface LeaderboardResponse {
  board: LeaderboardRow[];
  // The signed-in caller's own rank — null when anonymous or unranked.
  me: { rank: number; count: number } | null;
  // The applied area filter — set server-side to the caller's home board
  // (most-checked-in area) when the request omitted `area`.
  area: (typeof AREAS)[number] | null;
}

// --- Types mirroring the coverage surface (src/routes/coverage.ts) --------

// A "we need a menu here" mission (GET /api/requests row — requester_id is
// deliberately not exposed).
export interface VenueRequest {
  id: string;
  venue_id: string | null;
  venue_name: string | null;
  free_text_name: string | null;
  area: (typeof AREAS)[number];
  note: string | null;
  status: "open" | "fulfilled";
  fulfilled_submission_id: string | null;
  created_at: number;
}

export interface CoverageArea {
  area: (typeof AREAS)[number];
  venues: number;
  stubs: number;
  open_requests: number;
  items: number;
}

// --- Types mirroring the badges surface (src/routes/badges.ts) ----------

// A badge from GET /api/me/badges (every registry badge, with progress so
// the app can draw bars) or GET /api/users/:id/badges (earned only).
// `manual` marks honorary badges granted via user_badges rows.
export interface Badge {
  key: string;
  name: string;
  description?: string;
  tier?: number;
  manual?: boolean;
  earned: boolean;
  progress: number;
  target: number;
}

// Display names for the badge keys leaderboard rows carry (mirrors the
// registry in src/lib/badges.ts — the row payload is a key only).
export const BADGE_NAMES: Record<string, string> = {
  first_dish: "First Dish",
  contributor_10: "Contributor",
  contributor_50: "Trusted Contributor",
  contributor_100: "Century Contributor",
  pioneer_brunei_muara: "Peneroka Brunei-Muara",
  pioneer_tutong: "Peneroka Tutong",
  pioneer_belait: "Peneroka Belait",
  pioneer_temburong: "Peneroka Temburong",
  trailblazer: "Trailblazer",
  cartographer: "Cartographer",
  first_checkin: "First Check-in",
  regular_10: "Regular",
  regular_50: "Familiar Face",
  regular_100: "Local Legend",
  brunei_explorer: "Brunei Explorer",
  hawker_hero: "Hawker Hero",
  fact_checker: "Fact Checker",
  founding: "Founding Member",
  reviewer: "Reviewer",
  community_star: "Community Star",
};

export function badgeName(key: string): string {
  return BADGE_NAMES[key] ?? key.replaceAll("_", " ");
}

// --- Types mirroring the rewards surface (src/routes/me.ts, /api/stats) ---

// GET /api/me — the signed-in caller's own counts plus their opt-in prefs
// (the same fields PATCH /api/me writes).
export type ThemePref = "light" | "dark" | "system";

// A Gravatar-verified social account, normalized server-side
// (src/lib/gravatar.ts) — the only kind of public name we show.
export interface VerifiedAccount {
  platform: string;
  label: string;
  handle: string;
  url: string;
}

export interface MeProfile {
  display_name: string | null;
  show_on_leaderboard: boolean;
  show_credit: boolean;
  theme: ThemePref;
  preferred_social: string | null;
  socials: VerifiedAccount[];
  avatar_url: string;
  submissions: number;
  approved: number;
  checkins: number;
  verifications: number;
}

// GET /api/stats — public site-wide totals.
export interface StatsResponse {
  venues: number;
  items: number;
  contributors: number;
  checkins: number;
}

export function formatBnd(price: number | null): string {
  return price == null ? "—" : `B$${price.toFixed(2)}`;
}

// --- Types mirroring the scan surface -------------------------------------
// (src/routes/products.ts, src/routes/nearby.ts, src/routes/scan.ts — the
// endpoints the Scans tab consumes; see plan Task 5 / spec §1–§5.)

// GET /api/products/lookup/:code — the merged multi-provider answer for one
// barcode. `sources` is provenance: every provider that recognized the code.
export interface ProductLookupResult {
  found: boolean;
  product?: {
    name?: string;
    brand?: string;
    package_size?: string;
    nutrition_estimate?: NutritionEstimate;
    image_url?: string;
  };
  sources: { provider: string; url?: string }[];
}

export function lookupProduct(code: string): Promise<ProductLookupResult> {
  return apiFetch(`/products/lookup/${encodeURIComponent(code)}`);
}

// GET /api/venues/nearby — GPS assist for the scan venue pick.
export interface NearbyVenue {
  id: string;
  name: string;
  type: (typeof VENUE_TYPES)[number];
  area: (typeof AREAS)[number];
  distance_m: number;
}

export async function nearbyVenues(lat: number, lng: number, limit = 5): Promise<NearbyVenue[]> {
  const res = await apiFetch<{ venues: NearbyVenue[] }>(
    `/venues/nearby?lat=${lat}&lng=${lng}&limit=${limit}`,
  );
  return res.venues;
}

// One resolved batch item for POST /api/submissions/scan. `source_tags`
// carries the lookup's provider names — the server's trust gate only
// trusted-publishes codes with a `found` row in product_lookup_cache, so an
// item here must have gone through lookupProduct first or it can never
// publish (it queues for review instead).
export interface ScanSubmitItem {
  barcode: string;
  name: string;
  brand?: string;
  package_size?: string;
  nutrition_estimate?: NutritionEstimate;
  source_tags: string[];
}

export interface ScanSubmitResult {
  // The trusted_published submission when ≥1 item went live, else null.
  submission_id: string | null;
  // The pending_review submission holding over-cap items, else null.
  review_submission_id: string | null;
  published: number;
  queued: number;
  // Re-scans of barcodes already live at this venue (freshness re-checks).
  stale_lookup: number;
}

// POST /api/submissions/scan — session-gated JSON batch intake. Same header
// convention as the photo-form submit: web rides the same-origin cookie;
// native forwards the expoClient-stored cookie explicitly. The auth import
// is lazy — auth.ts reads API_BASE at module init, so a top-level import
// here would be a circular dependency.
export async function submitScan(body: {
  venue_id: string;
  provenance: string;
  items: ScanSubmitItem[];
}): Promise<ScanSubmitResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (Platform.OS !== "web") {
    if (API_BASE.startsWith("/")) {
      throw new Error(
        "EXPO_PUBLIC_API_URL is not set — native builds need the deployed worker API URL.",
      );
    }
    headers["X-Laparku-Client"] = "app";
    const { getAuthCookie } = await import("./auth");
    const cookie = await getAuthCookie();
    if (cookie) headers.cookie = cookie;
  }
  const res = await fetch(`${API_BASE}/submissions/scan`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    credentials: "include",
  });
  if (!res.ok) {
    let message = `scan submission failed (${res.status})`;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody.error) message = errBody.error;
    } catch {
      // non-JSON error body — keep the status-based message
    }
    throw new Error(message);
  }
  return res.json() as Promise<ScanSubmitResult>;
}
