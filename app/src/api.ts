// API client for the laparku-menus worker.
//
// `EXPO_PUBLIC_API_URL` is the base URL of the public API, e.g.
// "https://laparku-menus.<sub>.workers.dev/api". When unset it defaults to the
// relative path "/api" — correct on web, where the worker serves this app and
// the API from the same origin. On native builds set the env var to the
// deployed worker URL before running `expo export` / `expo start`.
const API_BASE = (process.env.EXPO_PUBLIC_API_URL ?? "/api").replace(/\/+$/, "");

export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
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

export function formatBnd(price: number | null): string {
  return price == null ? "—" : `B$${price.toFixed(2)}`;
}
