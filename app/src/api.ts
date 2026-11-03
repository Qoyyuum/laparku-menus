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

export function formatBnd(price: number | null): string {
  return price == null ? "—" : `B$${price.toFixed(2)}`;
}
