// Google Maps share-link resolution — pure parsing plus the one network step
// (expanding goo.gl short links). No provider calls happen here; the output
// identifiers feed the provider chain in src/lib/gmaps-provider.ts.

export interface GmapsResolved {
  // ChIJ… place id (Google Places id).
  place_id?: string;
  // Hex feature id "0x…:0x…" (the !1s token in /maps/place URLs).
  data_id?: string;
  // Decimal CID from ?cid= links.
  data_cid?: string;
  name?: string;
  lat?: number;
  lng?: number;
  // Final URL after short-link expansion (or the input URL).
  resolved_url: string;
}

export class GmapsError extends Error {
  constructor(
    public code: "unresolvable_link" | "not_a_venue",
    message: string,
  ) {
    super(message);
    this.name = "GmapsError";
  }
}

// Hosts we accept links from. Short-link hosts require expansion; the rest
// are parsed directly.
const SHORTLINK_HOSTS = new Set(["maps.app.goo.gl", "goo.gl"]);
const MAPS_HOST_RE = /(^|\.)google\.[a-z.]+$|^maps\.google\.[a-z.]+$/i;
// Bare share text often wraps the URL in prose ("Try A's Kitchen: https://…").
const URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>]+/i;

const PLACE_ID_RE = /^ChI[jJ][\w-]{10,}$/;
const DATA_ID_RE = /^0x[0-9a-f]+:0x[0-9a-f]+$/i;

// Pull the first URL-looking token out of free text. Returns null when the
// input isn't (or doesn't contain) an http(s) URL — share-sheet text may be
// nothing but prose.
export function extractMapsUrl(text: string): string | null {
  const trimmed = text.trim();
  const match = trimmed.match(URL_IN_TEXT_RE);
  return match ? match[0]! : null;
}

function isMapsHost(host: string): boolean {
  const h = host.toLowerCase();
  if (SHORTLINK_HOSTS.has(h)) return true;
  // google.com/maps, maps.google.com, google.co.bn/maps — the /maps path
  // check happens on the URL itself, not here.
  return MAPS_HOST_RE.test(h);
}

// Expand a short link to its final google.com URL. Short-link hosts answer
// 30x; undici's fetch follows them and res.url carries the final location.
async function expandShortLink(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
  if (!res.ok && res.status !== 301 && res.status !== 302 && res.status !== 303 && res.status !== 307 && res.status !== 308) {
    throw new GmapsError("unresolvable_link", `share link answered HTTP ${res.status}`);
  }
  return res.url || url;
}

// "!1s" tokens in the data blob hold either the ChIJ place id or the hex
// feature id. There can be several; prefer whichever shape parses.
function extractIds(decodedUrl: string): { place_id?: string; data_id?: string } {
  const out: { place_id?: string; data_id?: string } = {};
  for (const match of decodedUrl.matchAll(/!1s([^!]+)/g)) {
    const token = match[1]!;
    if (!out.place_id && PLACE_ID_RE.test(token)) out.place_id = token;
    if (!out.data_id && DATA_ID_RE.test(token)) out.data_id = token;
  }
  return out;
}

// Resolve a user-supplied link or blob of share text into the place
// identifiers providers can query. Throws GmapsError — the route maps codes
// to 400s; queue work treats an already-resolved payload as ground truth.
export async function resolveGmapsUrl(input: string): Promise<GmapsResolved> {
  const raw = extractMapsUrl(input);
  if (!raw) throw new GmapsError("unresolvable_link", "no URL found in input");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GmapsError("unresolvable_link", "input is not a valid URL");
  }
  if (!isMapsHost(url.hostname)) {
    throw new GmapsError("not_a_venue", "URL is not a Google Maps link");
  }

  let finalUrl = raw;
  if (SHORTLINK_HOSTS.has(url.hostname.toLowerCase())) {
    finalUrl = await expandShortLink(raw);
    try {
      url = new URL(finalUrl);
    } catch {
      throw new GmapsError("unresolvable_link", "share link expanded to an invalid URL");
    }
    if (!isMapsHost(url.hostname)) {
      throw new GmapsError("not_a_venue", "share link does not resolve to Google Maps");
    }
  } else if (!/maps|place|cid=|!1s/i.test(finalUrl)) {
    // A google.com link that isn't Maps-shaped was accepted by the host
    // regex only because every google.* host matches — reject it here.
    throw new GmapsError("not_a_venue", "URL is not a Google Maps link");
  }

  // Work on the percent-decoded form — !1s values and @coords may arrive
  // encoded inside the data blob.
  const decoded = decodeURIComponent(finalUrl);
  const { place_id, data_id } = extractIds(decoded);
  const cid = url.searchParams.get("cid") ?? decoded.match(/[?&]cid=(\d+)/)?.[1];

  // /maps/place/<name>/ — plus-separated, may carry trailing slashes.
  const name = decoded.match(/\/maps\/place\/([^/@]+)/)?.[1]?.replace(/\+/g, " ").trim() || undefined;

  // @<lat>,<lng> in the path, or !3d<lat>!4d<lng> inside the data blob.
  const at = decoded.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  const ll = decoded.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/);
  const lat = at?.[1] ?? ll?.[1];
  const lng = at?.[2] ?? ll?.[2];

  const resolved: GmapsResolved = {
    resolved_url: finalUrl,
    ...(place_id ? { place_id } : {}),
    ...(data_id ? { data_id } : {}),
    ...(cid ? { data_cid: cid } : {}),
    ...(name ? { name } : {}),
    ...(lat && lng && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
      ? { lat: Number(lat), lng: Number(lng) }
      : {}),
  };

  // A usable result needs at least one durable identifier OR a name +
  // coordinates (a /maps/place/<name>/@lat,lng URL with no ids still
  // identifies the venue for the browser provider).
  if (!resolved.place_id && !resolved.data_id && !resolved.data_cid && !(resolved.name && resolved.lat !== undefined)) {
    throw new GmapsError("not_a_venue", "link does not identify a specific place");
  }
  return resolved;
}
