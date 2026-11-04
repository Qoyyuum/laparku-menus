// Server-side proxy to OpenStreetMap's Nominatim geocoder — the venue
// picker's "search a building/shop name" path. Keeping the calls on the
// worker means the identifying User-Agent (required by the Nominatim
// usage policy, browsers can't set one) and the graceful-degradation
// contract live in one place: every function here returns an empty answer
// on any upstream failure — timeout, 5xx, geocode miss, unparseable body —
// never throws.
//
// v1 has no response caching: the routes are rate-limited per IP already
// and the picker's debounce keeps call volume far under the policy's
// 1 req/s polite ceiling.

const SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "laparku-menus/1.0";
const TIMEOUT_MS = 5_000;
const RESULT_LIMIT = 8;
// Bounding box half-width applied around the caller's position — a ~0.5°
// span (~55 km) biases results to the user's area without excluding the
// far end of a Brunei-sized country.
const VIEWBOX_HALF_DEG = 0.25;

// Normalized search hit — the client's raw material for the OSM candidate
// list and the POST /api/venues create call. `class` mirrors the Nominatim
// jsonv2 `category` field (class is a reserved word in some JSON tooling;
// the API calls it category, older Nominatim called it class — both are
// accepted on input).
export interface OsmPlace {
  osm_type: string;
  osm_id: number;
  name: string;
  class: string;
  type: string;
  lat: number;
  lng: number;
  display_name: string;
  address?: Record<string, string>;
}

interface NominatimSearchRow {
  osm_type?: unknown;
  osm_id?: unknown;
  name?: unknown;
  class?: unknown;
  category?: unknown;
  type?: unknown;
  lat?: unknown;
  lon?: unknown;
  display_name?: unknown;
  address?: unknown;
}

function normalizePlace(raw: unknown): OsmPlace | null {
  const r = raw as NominatimSearchRow;
  const name = typeof r?.name === "string" ? r.name.trim() : "";
  const lat = Number(r?.lat);
  const lng = Number(r?.lon);
  const osmId = Number(r?.osm_id);
  // A nameless or unlocated hit can't become a venue — drop it rather than
  // handing the client a row it can't use.
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(osmId)) {
    return null;
  }
  return {
    osm_type: typeof r.osm_type === "string" ? r.osm_type : "node",
    osm_id: osmId,
    name,
    class: typeof r.class === "string" ? r.class : typeof r.category === "string" ? r.category : "",
    type: typeof r.type === "string" ? r.type : "",
    lat,
    lng,
    display_name: typeof r.display_name === "string" ? r.display_name : name,
    address:
      typeof r.address === "object" && r.address !== null
        ? (r.address as Record<string, string>)
        : undefined,
  };
}

// Nominatim /search. When `at` is given, results are bounded to a
// VIEWBOX_HALF_DEG box around it (viewbox + bounded=1); without coords the
// query is global and Nominatim ranks it alone.
export async function searchNominatim(q: string, at?: { lat: number; lng: number }): Promise<OsmPlace[]> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("limit", String(RESULT_LIMIT));
  url.searchParams.set("q", q);
  if (at) {
    // viewbox = left,top,right,bottom = minLng,maxLat,maxLng,minLat.
    url.searchParams.set(
      "viewbox",
      `${at.lng - VIEWBOX_HALF_DEG},${at.lat + VIEWBOX_HALF_DEG},${at.lng + VIEWBOX_HALF_DEG},${at.lat - VIEWBOX_HALF_DEG}`,
    );
    url.searchParams.set("bounded", "1");
  }
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map(normalizePlace).filter((p): p is OsmPlace => p !== null);
  } catch {
    return [];
  }
}

// Nominatim /reverse — the pin-drop name suggestion. Returns only the two
// fields the client needs (a place name when the point resolves to a
// named feature, and the display string for context); {} on a geocode
// miss or any upstream failure.
export async function reverseNominatim(
  lat: number,
  lng: number,
): Promise<{ name?: string; address?: string }> {
  const url = new URL(REVERSE_URL);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 404 is Nominatim's "unable to geocode" — a miss, not an error.
    if (!res.ok) return {};
    const data = (await res.json()) as { name?: unknown; display_name?: unknown };
    const name = typeof data?.name === "string" && data.name.trim() !== "" ? data.name.trim() : undefined;
    const address =
      typeof data?.display_name === "string" && data.display_name.trim() !== ""
        ? data.display_name
        : undefined;
    return { ...(name ? { name } : {}), ...(address ? { address } : {}) };
  } catch {
    return {};
  }
}
