// Scans tab: camera-first continuous-decode barcode capture whose capture
// list IS the submission draft.
//
// Flow: the camera opens immediately — venue is no longer the gate — and
// fills the free space under a scan-frame/redline overlay → each code
// resolves asynchronously through /api/products/lookup while the camera
// keeps running → a bottom toast announces the product name or "couldn't
// find this product" (+ a manual-fill handoff to the photo form) → the
// submit sheet is where the venue is picked (GPS "Use my location" →
// "Near you" preselect, a web-only OSM drag-pin adjust, and the manual
// venue search) and shows found/unknown counts → POST
// /api/submissions/scan publishes found items trusted (pending-
// verification badge); unknown codes are never in the batch — they get a
// per-code "add photos / drop" choice, "add photos" handing off to the
// parent's product_photo form.
//
// The server still requires venue_id, so Submit stays disabled until a
// venue is chosen — but never before the camera opens.
import * as Location from "expo-location";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  Vibration,
  View,
} from "react-native";
import {
  apiFetch,
  createVenue,
  lookupProduct,
  nearbyVenues,
  osmReverse,
  osmSearch,
  submitScan,
  type NearbyVenue,
  type OsmPlace,
  type ProductLookupResult,
  type ScanSubmitResult,
  type Venue,
} from "../api";
import { ScanCamera } from "./ScanCamera";
import { VenueMap } from "./VenueMap";

// Prop contract for the platform camera surface (ScanCamera.tsx native,
// ScanCamera.web.tsx web). Declared here so both files and the tab share
// one source of truth — the camera files import it type-only.
export interface ScanPoint {
  x: number;
  y: number;
}
export interface ScanCameraProps {
  /** False while the submit sheet is open — decodes are ignored. */
  active: boolean;
  /** New decode: the code plus a view-space chip anchor when bounds exist. */
  onCode: (code: string, point?: ScanPoint) => void;
}

// Prop contract for the platform venue-adjust map (VenueMap.web.tsx —
// Leaflet on web, VenueMap.tsx — null stub on native). Same one-source-
// of-truth pattern as ScanCameraProps above.
export interface GeoPoint {
  lat: number;
  lng: number;
  /** Present on fresh GPS fixes → the map recenters AND zooms; pin drags omit it. */
  zoom?: number;
}
export interface VenueMapProps {
  /** Current pin position. */
  position: GeoPoint;
  /** Pin drag or map tap — the picker re-queries nearby venues for the point. */
  onMove: (p: GeoPoint) => void;
}

// Spec: the same code within a ~3 s window counts once — sweeping back over
// a barcode re-confirms rather than re-adding.
const CODE_THROTTLE_MS = 3_000;
// On-camera chips linger briefly after their decode so the user sees what
// was picked up without watching the list.
const CHIP_TTL_MS = 4_000;
// The bottom toast hangs around a little longer than a chip — the unknown-
// code variant carries a "Fill it in" action the user needs time to tap.
const TOAST_MS = 6_000;
const NEARBY_LIMIT = 5;
const SEARCH_LIMIT = 10;
// The map's resting position before any location lands (Bandar Seri
// Begawan) — draggable from the start, so no fix is required to use it.
const DEFAULT_POINT: GeoPoint = { lat: 4.9031, lng: 114.9398 };

type CaptureStatus = "resolving" | "found" | "unknown" | "failed";

interface Capture {
  code: string;
  status: CaptureStatus;
  product?: ProductLookupResult["product"];
  /** Provider names from the lookup — submitted verbatim as source_tags. */
  sourceTags: string[];
}

interface Chip {
  code: string;
  x: number;
  y: number;
  ts: number;
}

interface PickedVenue {
  id: string;
  name: string;
}

// The bottom scan toast: the last lookup's verdict, with a manual-fill
// action on misses. "resolving" never reaches it — the on-camera chip
// already covers the in-flight moment.
interface ScanToast {
  code: string;
  status: "found" | "unknown" | "failed";
  name?: string;
  ts: number;
}

export function ScanTab({
  onAddPhotos,
}: {
  /** Hand unknown codes off to the parent's photo form (spec miss path). */
  onAddPhotos?: (codes: string[], venueName: string) => void;
}) {
  const [venue, setVenue] = useState<PickedVenue | null>(null);
  const [provenance, setProvenance] = useState("");
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [chips, setChips] = useState<Chip[]>([]);
  const [manualCode, setManualCode] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanSubmitResult | null>(null);
  const [toast, setToast] = useState<ScanToast | null>(null);

  // Per-code re-decode throttle — a ref, not state: it's a write-mostly map
  // read inside the decode path and must never schedule renders.
  const lastSeen = useRef(new Map<string, number>());
  // Decode callbacks need the current capture list without re-binding —
  // synced in an effect, not during render (React Compiler rule).
  const capturesRef = useRef(captures);
  useEffect(() => {
    capturesRef.current = captures;
  });

  // Chips fade after CHIP_TTL_MS.
  useEffect(() => {
    const t = setInterval(
      () => setChips((prev) => prev.filter((c) => Date.now() - c.ts < CHIP_TTL_MS)),
      1000,
    );
    return () => clearInterval(t);
  }, []);

  // Toasts dismiss themselves — matched on ts so a newer scan's toast is
  // never cleared by an older timer.
  useEffect(() => {
    if (!toast) return;
    const ts = toast.ts;
    const t = setTimeout(() => setToast((cur) => (cur?.ts === ts ? null : cur)), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  // Async lookup — never blocks the camera (spec: the capture list shows
  // "…" while in flight, then the product name or "unknown product"). The
  // verdict also lands on the bottom toast — found shows the name, a miss
  // offers the manual-fill path.
  const resolve = useCallback(async (code: string) => {
    const patch = (p: Partial<Capture>) =>
      setCaptures((prev) => prev.map((c) => (c.code === code ? { ...c, ...p } : c)));
    const say = (status: ScanToast["status"], name?: string) =>
      setToast({ code, status, name, ts: Date.now() });
    // The lookup endpoint validates 8–14 digits; QR/Code-128 payloads that
    // aren't GTINs can never resolve, so they go straight to unknown.
    if (!/^\d{8,14}$/.test(code)) {
      patch({ status: "unknown" });
      say("unknown");
      return;
    }
    try {
      const res = await lookupProduct(code);
      patch({
        status: res.found ? "found" : "unknown",
        product: res.product,
        sourceTags: res.sources.map((s) => s.provider),
      });
      say(res.found ? "found" : "unknown", res.product?.name);
    } catch {
      // Lookup unavailable — keep the code, mark it so the user can retry
      // by re-scanning, and let the photo path handle it either way.
      patch({ status: "failed" });
      say("failed");
    }
  }, []);

  const handleCode = useCallback(
    (raw: string, point?: ScanPoint) => {
      const code = raw.trim();
      if (!code) return;
      const now = Date.now();
      const last = lastSeen.current.get(code);
      if (last !== undefined && now - last < CODE_THROTTLE_MS) return;
      lastSeen.current.set(code, now);
      if (point) {
        setChips((prev) => [
          ...prev.filter((c) => c.code !== code),
          { code, x: point.x, y: point.y, ts: now },
        ]);
      }
      const existing = capturesRef.current.find((c) => c.code === code);
      if (existing) {
        // Re-confirm doesn't re-add — but a failed lookup retries.
        if (existing.status === "failed") void resolve(code);
        return;
      }
      // New-capture feedback without looking away (native haptic; web
      // stays silent per spec).
      if (Platform.OS !== "web") Vibration.vibrate(60);
      setCaptures((prev) => [{ code, status: "resolving", sourceTags: [] }, ...prev]);
      void resolve(code);
    },
    [resolve],
  );

  const removeCode = useCallback(
    (code: string) => setCaptures((prev) => prev.filter((c) => c.code !== code)),
    [],
  );

  function pickVenue(v: PickedVenue) {
    setVenue(v);
    setProvenance((p) => p.trim() || `Scanned at ${v.name}`);
    setError(null);
    setResult(null);
  }

  const found = captures.filter((c) => c.status === "found");
  const resolving = captures.filter((c) => c.status === "resolving");
  const unknown = captures.filter((c) => c.status === "unknown" || c.status === "failed");

  async function confirmSubmit() {
    if (!venue || found.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await submitScan({
        venue_id: venue.id,
        provenance: provenance.trim() || `Scanned at ${venue.name}`,
        items: found.map((c) => ({
          barcode: c.code,
          name: c.product?.name ?? `Scanned product ${c.code}`,
          brand: c.product?.brand,
          package_size: c.product?.package_size,
          nutrition_estimate: c.product?.nutrition_estimate,
          // Server trust gate: tags from the actual lookup, plus a found
          // cache row server-side, are what let these items publish.
          source_tags: c.sourceTags,
        })),
      });
      setResult(res);
      setSheetOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "submission failed");
    } finally {
      setBusy(false);
    }
  }

  function resetSession() {
    setCaptures([]);
    setChips([]);
    lastSeen.current.clear();
    setResult(null);
    setError(null);
    setVenue(null);
    setToast(null);
  }

  // ---- Post-submit result: the session has ended. ----
  if (result) {
    const leftover = unknown.length;
    return (
      <View className="gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <Text className="text-base font-bold text-emerald-900">Scan batch submitted</Text>
        {result.published > 0 ? (
          <Text className="text-sm leading-6 text-emerald-900">
            {result.published} product{result.published === 1 ? "" : "s"} went live at {venue?.name} —
            they'll show a "recently scanned" badge until a reviewer double-checks them.
          </Text>
        ) : null}
        {result.queued > 0 ? (
          <Text className="text-sm leading-6 text-emerald-900">
            {result.queued} item{result.queued === 1 ? "" : "s"} went to the normal review queue —
            a reviewer will check them before they go live (over the daily limit or not verified by
            a product source).
          </Text>
        ) : null}
        {result.stale_lookup > 0 ? (
          <Text className="text-sm leading-6 text-emerald-900">
            {result.stale_lookup} code{result.stale_lookup === 1 ? " was" : "s were"} already on this
            menu — counted as a freshness re-check, not a duplicate.
          </Text>
        ) : null}
        {result.published === 0 && result.queued === 0 && result.stale_lookup === 0 ? (
          <Text className="text-sm leading-6 text-emerald-900">
            Nothing was published or queued — every code in the batch was already handled.
          </Text>
        ) : null}
        {leftover > 0 ? (
          <Text className="text-sm leading-6 text-emerald-900">
            {leftover} unknown code{leftover === 1 ? "" : "s"} weren't part of the batch — photograph
            them from the photo form so a reviewer can see the product.
          </Text>
        ) : null}
        <View className="flex-row gap-2">
          <Pressable
            className="rounded-lg bg-emerald-700 px-4 py-2"
            onPress={resetSession}
          >
            <Text className="text-sm font-semibold text-white">Scan another batch</Text>
          </Pressable>
          {leftover > 0 && onAddPhotos ? (
            <Pressable
              className="rounded-lg border border-emerald-700 bg-white px-4 py-2"
              onPress={() =>
                onAddPhotos(
                  unknown.map((c) => c.code),
                  venue?.name ?? "",
                )
              }
            >
              <Text className="text-sm font-semibold text-emerald-800">
                Photograph unknown{leftover === 1 ? "" : `s (${leftover})`}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  // ---- Camera-first: no venue gate — the picker lives in the submit
  // sheet, the camera owns the screen from the start. ----
  return (
    <View className="flex-1 gap-3">
      {/* The camera takes every pixel the bottom panel doesn't need — the
          flex-1 viewport only works because submit.tsx renders this tab
          outside its ScrollView. */}
      <View
        className="relative flex-1 overflow-hidden rounded-xl bg-black"
        style={{ minHeight: 280 }}
      >
        <ScanCamera active={!sheetOpen} onCode={handleCode} />
        <ScanFrame />
        {chips.map((chip) => {
          const cap = captures.find((c) => c.code === chip.code);
          const label = cap?.status === "found" ? (cap.product?.name ?? chip.code) : chip.code;
          return (
            <View
              key={chip.code}
              className="absolute rounded bg-emerald-700/90 px-1.5 py-0.5"
              style={{ left: Math.max(0, chip.x - 8), top: Math.max(0, chip.y - 16) }}
            >
              <Text className="text-xs font-semibold text-white" numberOfLines={1}>
                {label}
              </Text>
            </View>
          );
        })}
        {toast ? (
          <ScanToastView
            toast={toast}
            onFillIn={
              onAddPhotos
                ? () => {
                    onAddPhotos([toast.code], venue?.name ?? "");
                    setToast(null);
                  }
                : undefined
            }
          />
        ) : null}
      </View>

      {/* "Type it instead" — damaged codes, permission-denied, desktop. */}
      <View className="flex-row gap-2">
        <TextInput
          className="flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base"
          placeholder="Type it instead — barcode digits"
          value={manualCode}
          onChangeText={setManualCode}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => {
            handleCode(manualCode);
            setManualCode("");
          }}
        />
        <Pressable
          className="items-center justify-center rounded-lg border border-neutral-300 bg-white px-4 disabled:opacity-50"
          disabled={manualCode.trim() === ""}
          onPress={() => {
            handleCode(manualCode);
            setManualCode("");
          }}
        >
          <Text className="text-sm font-medium text-neutral-800">Add</Text>
        </Pressable>
      </View>

      <Text className="text-sm font-semibold text-neutral-800">
        {captures.length} captured — {found.length} identified, {unknown.length} unknown
        {resolving.length > 0 ? `, ${resolving.length} looking up…` : ""}
      </Text>
      {captures.length > 0 ? (
        <ScrollView style={{ maxHeight: 160 }}>
          <View className="gap-1.5">
            {captures.map((c) => (
              <CaptureRow key={c.code} capture={c} onRemove={() => removeCode(c.code)} />
            ))}
          </View>
        </ScrollView>
      ) : null}

      {error ? <Text className="text-sm text-red-600">{error}</Text> : null}

      <Pressable
        className="items-center rounded-lg bg-emerald-700 px-4 py-3 disabled:opacity-50"
        disabled={captures.length === 0}
        onPress={() => {
          setError(null);
          setSheetOpen(true);
        }}
      >
        <Text className="text-base font-semibold text-white">
          Review & submit{captures.length > 0 ? ` (${captures.length})` : ""}
        </Text>
      </Pressable>

      {/* Submit sheet: the venue pick moved here (GPS + web map-adjust +
          search) alongside found/unknown counts, per-item remove, and the
          per-code "add photos or drop" choice — then end the session. */}
      <Modal
        visible={sheetOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setSheetOpen(false)}
      >
        <View className="flex-1 justify-end bg-black/50">
          <View className="max-h-[85%] gap-3 rounded-t-2xl bg-white p-4">
            {/* shrink: RN's default flexShrink is 0 — without it a tall
                sheet (map + nearby + captures) overflows the 85% bound
                and pushes the action buttons off-screen. */}
            <ScrollView className="min-h-0 shrink">
              <View className="gap-3">
                <Text className="text-base font-bold text-neutral-900">
                  Submit {found.length} scanned product{found.length === 1 ? "" : "s"}
                </Text>

                {/* Venue is a submit-time choice now — the batch needs a
                    place to attach to, the camera never did. The picker
                    stays mounted after a pick so the Near-you list, map
                    pin and search state survive a change of mind. */}
                <VenuePicker onPick={pickVenue} selected={venue} />

                <Text className="text-sm leading-6 text-neutral-600">
                  {found.length} identified — publish{found.length === 1 ? "es" : ""} immediately
                  {venue ? ` at ${venue.name}` : ""} with a pending-verification badge.
                  {unknown.length > 0
                    ? ` ${unknown.length} unknown code${unknown.length === 1 ? "" : "s"} won't be in the batch — add photos or drop each one.`
                    : ""}
                </Text>
                {resolving.length > 0 ? (
                  <Text className="text-sm leading-6 text-amber-700">
                    {resolving.length} lookup{resolving.length === 1 ? " is" : "s are"} still
                    resolving — they'll be left out; submit again to add them.
                  </Text>
                ) : null}

                {found.map((c) => (
                  <CaptureRow key={c.code} capture={c} onRemove={() => removeCode(c.code)} />
                ))}
                {unknown.map((c) => (
                  <View
                    key={c.code}
                    className="gap-1.5 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2"
                  >
                    <View className="flex-row items-center justify-between">
                      <View className="flex-1">
                        <Text className="text-sm font-medium text-neutral-900">
                          unknown product
                        </Text>
                        <Text className="text-xs text-neutral-500">
                          {c.code}
                          {c.status === "failed" ? " — lookup failed, needs photos" : ""}
                        </Text>
                      </View>
                    </View>
                    <View className="flex-row gap-2">
                      {onAddPhotos ? (
                        <Pressable
                          className="rounded-md bg-emerald-700 px-2.5 py-1"
                          onPress={() => onAddPhotos([c.code], venue?.name ?? "")}
                        >
                          <Text className="text-xs font-semibold text-white">Add photos</Text>
                        </Pressable>
                      ) : null}
                      <Pressable
                        className="rounded-md border border-neutral-300 bg-white px-2.5 py-1"
                        onPress={() => removeCode(c.code)}
                      >
                        <Text className="text-xs font-semibold text-neutral-700">Drop</Text>
                      </Pressable>
                    </View>
                  </View>
                ))}

                <TextInput
                  className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm"
                  value={provenance}
                  onChangeText={setProvenance}
                  multiline
                />

                {error ? <Text className="text-sm text-red-600">{error}</Text> : null}
                {found.length === 0 ? (
                  <Text className="text-sm leading-6 text-neutral-600">
                    Nothing to publish yet — only identified products go into a scan batch. Unknown
                    codes need photos so a reviewer can see the product.
                  </Text>
                ) : null}
                {!venue && found.length > 0 ? (
                  <Text className="text-sm leading-6 text-amber-700">
                    Pick where you are above — the batch needs a venue to attach to.
                  </Text>
                ) : null}
              </View>
            </ScrollView>

            <View className="flex-row gap-2">
              <Pressable
                className="flex-1 items-center rounded-lg border border-neutral-300 bg-white px-4 py-2.5"
                onPress={() => setSheetOpen(false)}
              >
                <Text className="text-sm font-semibold text-neutral-700">Keep scanning</Text>
              </Pressable>
              <Pressable
                className="flex-1 items-center rounded-lg bg-emerald-700 px-4 py-2.5 disabled:opacity-50"
                disabled={busy || found.length === 0 || !venue}
                onPress={() => void confirmSubmit()}
              >
                <Text className="text-sm font-semibold text-white">
                  {busy ? "Submitting…" : `Submit ${found.length}`}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// The barcode scan-frame overlay: corner brackets around the sweet spot
// plus the classic red scanline across the middle. Purely decorative —
// decode coverage is the whole frame, not just the marked area.
function ScanFrame() {
  return (
    <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
      <View className="relative h-24 w-3/4">
        <View className="absolute left-0 top-0 h-6 w-6 border-l-4 border-t-4 border-white/90" />
        <View className="absolute right-0 top-0 h-6 w-6 border-r-4 border-t-4 border-white/90" />
        <View className="absolute bottom-0 left-0 h-6 w-6 border-b-4 border-l-4 border-white/90" />
        <View className="absolute bottom-0 right-0 h-6 w-6 border-b-4 border-r-4 border-white/90" />
        <View
          className="absolute left-0 right-0 h-0.5 bg-red-500"
          style={{ top: "50%", marginTop: -1 }}
        />
      </View>
    </View>
  );
}

// Bottom toast for the last lookup verdict: found → the product name;
// miss → "couldn't find this product" + the manual-fill handoff;
// failed → re-scan hint. Overlays the camera's lower edge.
function ScanToastView({ toast, onFillIn }: { toast: ScanToast; onFillIn?: () => void }) {
  if (toast.status === "found") {
    return (
      <View className="absolute inset-x-3 bottom-3 rounded-xl bg-emerald-800/95 px-3 py-2.5">
        <Text className="text-sm font-semibold text-white" numberOfLines={2}>
          ✓ {toast.name ?? "Product found"}
        </Text>
      </View>
    );
  }
  return (
    <View className="absolute inset-x-3 bottom-3 gap-1 rounded-xl bg-neutral-900/90 px-3 py-2.5">
      <Text className="text-sm font-semibold text-white">
        {toast.status === "failed"
          ? "Couldn't reach the product database — re-scan to retry"
          : "Couldn't find this product"}
      </Text>
      <Text className="text-xs text-neutral-300">{toast.code}</Text>
      {toast.status === "unknown" && onFillIn ? (
        <Pressable
          className="mt-1 self-start rounded-md bg-emerald-700 px-2.5 py-1.5"
          onPress={onFillIn}
        >
          <Text className="text-xs font-semibold text-white">Fill it in manually</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// A capture-list row: code → "…" while the lookup is in flight → product
// name or "unknown product". Removable — the list is the draft.
function CaptureRow({ capture, onRemove }: { capture: Capture; onRemove: () => void }) {
  const c = capture;
  const label =
    c.status === "resolving"
      ? "…"
      : c.status === "found"
        ? (c.product?.name ?? "identified product")
        : c.status === "failed"
          ? "lookup failed"
          : "unknown product";
  const detail =
    c.status === "found"
      ? [c.product?.brand, c.product?.package_size].filter(Boolean).join(" · ")
      : c.status === "failed"
        ? "couldn't reach the product database — re-scan to retry"
        : "";
  return (
    <View className="flex-row items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2">
      <View className="flex-1">
        <Text
          className={`text-sm font-medium ${
            c.status === "found" ? "text-neutral-900" : "text-neutral-500"
          }`}
          numberOfLines={1}
        >
          {label}
        </Text>
        <Text className="text-xs text-neutral-500" numberOfLines={1}>
          {c.code}
          {detail ? ` — ${detail}` : ""}
        </Text>
      </View>
      <Pressable
        className="h-6 w-6 items-center justify-center rounded-full bg-neutral-100"
        accessibilityLabel={`Remove ${c.code}`}
        onPress={onRemove}
      >
        <Text className="text-sm font-bold text-neutral-600">×</Text>
      </Pressable>
    </View>
  );
}

// Best-effort map from a Nominatim class/type pair onto our venue enum —
// an unmapped shop still lands somewhere sensible (restaurant is the
// schema default and reviewers can reclassify).
function osmVenueType(p: OsmPlace): Venue["type"] {
  if (p.class === "shop") {
    if (p.type === "supermarket" || p.type === "wholesale" || p.type === "department_store") {
      return "supermarket";
    }
    if (p.type === "convenience" || p.type === "kiosk") return "convenience";
    return "grocer";
  }
  if (p.class === "amenity" && (p.type === "marketplace" || p.type === "food_court")) {
    return "stall";
  }
  return "restaurant";
}

// Venue pick, submit-time edition (spec §3): "Use my location" →
// /api/venues/nearby → "Near you" top-5 with the closest preselected;
// on web an OSM map with a draggable pin re-queries the list for wherever
// the pin lands (and reverse-geocodes a "use this place?" suggestion);
// the search box queries both our venues table and OpenStreetMap via
// /api/venues/osm-search — picking an OSM row trusted-creates the venue
// through POST /api/venues so anything in the real world is scannable.
function VenuePicker({
  onPick,
  selected,
}: {
  onPick: (v: PickedVenue) => void;
  selected?: PickedVenue | null;
}) {
  const selectedId = selected?.id;
  const [pos, setPos] = useState<GeoPoint>(DEFAULT_POINT);
  const [located, setLocated] = useState(false);
  const [nearby, setNearby] = useState<NearbyVenue[] | null>(null);
  const [locating, setLocating] = useState(false);
  const [locMsg, setLocMsg] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Venue[]>([]);
  const [osmResults, setOsmResults] = useState<OsmPlace[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  // A venue-create POST in flight (OSM pick or pin suggestion) — holds the
  // row's label so the list can show progress and ignore double-taps.
  const [creating, setCreating] = useState<string | null>(null);
  // Web-only: the reverse-geocoded name at the dropped pin.
  const [pinSuggestion, setPinSuggestion] = useState<{
    name: string;
    address?: string;
    lat: number;
    lng: number;
  } | null>(null);
  // The venue id we last auto-preselected — the refresh may preselect the
  // closest hit again only when nothing (or only that auto-pick) is
  // selected, so a deliberate tap is never clobbered by a pin drag.
  const lastAuto = useRef<string | null>(null);
  // Debounce callbacks see the latest selection/props without re-binding.
  const selectedRef = useRef(selectedId);
  const onPickRef = useRef(onPick);
  const posRef = useRef(pos);
  useEffect(() => {
    selectedRef.current = selectedId;
    onPickRef.current = onPick;
    posRef.current = pos;
  });

  // GPS fixes and pin moves funnel into one debounced nearby refresh.
  useEffect(() => {
    if (!located) return;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const list = await nearbyVenues(pos.lat, pos.lng, NEARBY_LIMIT);
          setNearby(list);
          const top = list[0];
          if (top && (!selectedRef.current || selectedRef.current === lastAuto.current)) {
            lastAuto.current = top.id;
            onPickRef.current(top);
          }
          setLocMsg(
            list.length === 0
              ? "No venues within ~500 m of this point — drag the pin or search below."
              : null,
          );
        } catch {
          setLocMsg("Couldn't load venues near that point — search below instead.");
        }
      })();
    }, 400);
    return () => clearTimeout(t);
  }, [located, pos]);

  // Web-only pin-drop reverse geocode (debounced separately from the
  // nearby refresh — a slightly longer window keeps Nominatim calls well
  // under the 1 req/s polite ceiling while dragging). A named feature at
  // the pin becomes a tappable "use this place?" suggestion.
  useEffect(() => {
    if (!located || Platform.OS !== "web") return;
    setPinSuggestion(null);
    const t = setTimeout(() => {
      const p = posRef.current;
      void osmReverse(p.lat, p.lng)
        .then((r) => {
          if (r.name) setPinSuggestion({ name: r.name, address: r.address, lat: p.lat, lng: p.lng });
        })
        .catch(() => {
          // A failed reverse is invisible — the map and search still work.
        });
    }, 700);
    return () => clearTimeout(t);
  }, [located, pos]);

  async function useMyLocation() {
    setLocating(true);
    setLocMsg(null);
    try {
      // Web has no separate permission-request API — getCurrentPosition
      // triggers the browser prompt itself. expo-location's
      // requestForegroundPermissionsAsync on web can return undefined or
      // never resolve, which silently killed the button. Only gate on
      // native.
      if (Platform.OS !== "web") {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (!perm.granted) {
          setLocMsg("Location permission denied — search for the venue below instead.");
          return;
        }
      }
      const fix = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      // An explicit locate re-arms the auto-preselect: whatever is selected
      // counts as "auto" for the refresh this fix triggers, so the new
      // closest hit wins (spec §4).
      lastAuto.current = selectedRef.current ?? null;
      setPos({ lat: fix.coords.latitude, lng: fix.coords.longitude, zoom: 16 });
      setLocated(true);
    } catch {
      setLocMsg("Couldn't get your location — search for the venue below instead.");
    } finally {
      setLocating(false);
    }
  }

  const handleMapMove = useCallback((p: GeoPoint) => {
    setPos({ lat: p.lat, lng: p.lng });
    setLocated(true);
  }, []);

  // Debounced venue search — fires OUR venues table and the OSM proxy in
  // parallel (Promise.allSettled: a failed leg never kills the other).
  // Our rows render first, the real-world candidates below them. Empty
  // and failed searches both get a visible state.
  useEffect(() => {
    const q = query.trim();
    setSearched(false);
    if (q.length < 2) {
      setResults([]);
      setOsmResults([]);
      setSearching(false);
      setSearchErr(null);
      return;
    }
    let dead = false;
    const t = setTimeout(() => {
      setSearching(true);
      setSearchErr(null);
      // The picker pin bounds the OSM query to the user's area (~0.5°);
      // the default BSB point still biases correctly pre-GPS.
      const { lat, lng } = posRef.current;
      void Promise.allSettled([
        apiFetch<{ venues: Venue[] }>(`/venues?q=${encodeURIComponent(q)}`),
        osmSearch(q, lat, lng),
      ])
        .then(([ours, osm]) => {
          if (dead) return;
          setResults(ours.status === "fulfilled" ? ours.value.venues.slice(0, SEARCH_LIMIT) : []);
          setOsmResults(osm.status === "fulfilled" ? osm.value : []);
          setSearched(true);
          if (ours.status === "rejected" && osm.status === "rejected") {
            setSearchErr("Venue search didn't go through — check the connection and try again.");
          }
        })
        .finally(() => {
          if (!dead) setSearching(false);
        });
    }, 300);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [query]);

  // Shared create path for both OSM entry points (search row, pin
  // suggestion): POST /api/venues trusted-creates (or dedup-returns) the
  // venue, then it becomes the pick like any other row.
  async function createAndPick(
    key: string,
    body: { name: string; type?: Venue["type"]; address?: string; lat: number; lng: number; osm_ref?: string },
  ) {
    if (creating) return;
    setCreating(key);
    setSearchErr(null);
    try {
      const venue = await createVenue(body);
      onPickRef.current({ id: venue.id, name: venue.name });
      setPinSuggestion(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setSearchErr(
        msg === "unauthorized"
          ? "Sign in first to add a new place."
          : "Couldn't add that place — try again, or pick a venue above.",
      );
    } finally {
      setCreating(null);
    }
  }

  // Picking an OSM candidate maps its class/type onto our venue enum and
  // trusted-creates the venue on the spot.
  function pickOsm(p: OsmPlace) {
    void createAndPick(`${p.osm_type}/${p.osm_id}`, {
      name: p.name,
      type: osmVenueType(p),
      address: p.display_name !== p.name ? p.display_name : undefined,
      lat: p.lat,
      lng: p.lng,
      osm_ref: `${p.osm_type}/${p.osm_id}`,
    });
  }

  const trimmedQuery = query.trim();

  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold text-neutral-800">Where are you scanning?</Text>

      {selected ? (
        <View className="rounded-lg border border-emerald-700 bg-emerald-50 px-3 py-2">
          <Text className="text-sm font-semibold text-emerald-900">{selected.name} ✓</Text>
          <Text className="text-xs text-emerald-800">
            Every submitted item attaches here — tap another venue below to change.
          </Text>
        </View>
      ) : null}

      <Pressable
        className="items-center rounded-lg border border-emerald-700 bg-white px-3 py-2"
        disabled={locating}
        onPress={() => void useMyLocation()}
      >
        <Text className="text-sm font-semibold text-emerald-800">
          {locating ? "Locating…" : "Use my location"}
        </Text>
      </Pressable>
      {locMsg ? <Text className="text-xs text-neutral-500">{locMsg}</Text> : null}

      {/* Map adjust is web-only — Leaflet needs the DOM; native keeps the
          GPS + search paths (VenueMap.tsx is a null stub there). */}
      {Platform.OS === "web" ? (
        <View className="gap-1.5">
          <VenueMap position={pos} onMove={handleMapMove} />
          <Text className="text-xs text-neutral-500">
            Off by a bit? Drag the pin — or tap the map — to where you're standing. Nearby venues
            update automatically.
          </Text>
          {pinSuggestion && selected?.name !== pinSuggestion.name ? (
            <Pressable
              className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-2"
              disabled={creating !== null}
              onPress={() =>
                void createAndPick("pin", {
                  name: pinSuggestion.name,
                  address: pinSuggestion.address,
                  lat: pinSuggestion.lat,
                  lng: pinSuggestion.lng,
                })
              }
            >
              <Text className="text-sm font-semibold text-sky-900">
                {creating === "pin"
                  ? "Adding…"
                  : `Looks like ${pinSuggestion.name} — use this place?`}
              </Text>
              {pinSuggestion.address ? (
                <Text className="text-xs text-sky-800" numberOfLines={1}>
                  {pinSuggestion.address}
                </Text>
              ) : null}
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {nearby && nearby.length > 0 ? (
        <View className="gap-1.5">
          <Text className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Near you
          </Text>
          {nearby.map((v) => (
            <Pressable
              key={v.id}
              className={`rounded-lg border px-3 py-2 ${
                selectedId === v.id
                  ? "border-emerald-700 bg-emerald-100"
                  : "border-emerald-200 bg-emerald-50"
              }`}
              onPress={() => onPick(v)}
            >
              <Text className="text-sm font-semibold text-neutral-900">{v.name}</Text>
              <Text className="text-xs text-neutral-500">
                {v.type} · {v.area} · {v.distance_m} m away
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <TextInput
        className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base"
        placeholder={nearby?.length ? "Somewhere else — search venues" : "Search venues"}
        value={query}
        onChangeText={setQuery}
      />
      {searching ? <Text className="text-xs text-neutral-500">Searching…</Text> : null}
      {trimmedQuery.length === 1 ? (
        <Text className="text-xs text-neutral-400">Keep typing — search starts at 2 letters.</Text>
      ) : null}
      {searchErr ? <Text className="text-xs text-red-600">{searchErr}</Text> : null}
      {searched && !searchErr && results.length === 0 && osmResults.length === 0 ? (
        <Text className="text-xs text-neutral-500">
          No places found for "{trimmedQuery}" — check the name, or drop the pin where you are and
          see what's nearby.
        </Text>
      ) : null}
      {results.map((v) => (
        <Pressable
          key={v.id}
          className="rounded-lg border border-neutral-200 bg-white px-3 py-2"
          onPress={() => onPick(v)}
        >
          <Text className="text-sm font-semibold text-neutral-900">{v.name}</Text>
          <Text className="text-xs text-neutral-500">
            {v.type} · {v.area}
          </Text>
        </Pressable>
      ))}

      {/* Real-world candidates from the OSM proxy — visually marked so an
          "add this place" row never reads like an existing venue. Picking
          one trusted-creates it server-side (POST /api/venues). */}
      {osmResults.length > 0 ? (
        <View className="gap-1.5">
          <Text className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            From OpenStreetMap
          </Text>
          {osmResults.map((p) => {
            const key = `${p.osm_type}/${p.osm_id}`;
            const chip = [p.class, p.type].filter(Boolean).join(" · ");
            return (
              <Pressable
                key={key}
                className="gap-0.5 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 disabled:opacity-50"
                disabled={creating !== null}
                onPress={() => pickOsm(p)}
              >
                <View className="flex-row items-center gap-2">
                  <Text className="flex-1 text-sm font-semibold text-neutral-900" numberOfLines={1}>
                    {creating === key ? `Adding ${p.name}…` : p.name}
                  </Text>
                  {chip ? (
                    <Text className="rounded bg-sky-200/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-900">
                      {chip}
                    </Text>
                  ) : null}
                </View>
                <Text className="text-xs text-neutral-500" numberOfLines={1}>
                  {p.display_name}
                </Text>
                <Text className="text-[10px] text-sky-700">from OpenStreetMap</Text>
              </Pressable>
            );
          })}
          <Text className="text-[10px] text-neutral-400">
            Search results from OpenStreetMap © OpenStreetMap contributors
          </Text>
        </View>
      ) : null}
    </View>
  );
}
