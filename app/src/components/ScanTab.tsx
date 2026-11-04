// Scans tab (spec §1/§4, plan Task 5): continuous-decode barcode capture
// whose capture list IS the submission draft.
//
// Flow: pick a venue (GPS-assisted "Near you" via /api/venues/nearby, with
// the venue search as manual fallback — GPS is assistive, never enforced) →
// continuous decode (ScanCamera — expo-camera native, zxing web) → each
// code resolves asynchronously through /api/products/lookup while the
// camera keeps running → submit sheet shows found/unknown counts →
// POST /api/submissions/scan publishes found items trusted (pending-
// verification badge); unknown codes are never in the batch — per spec
// they get a per-code "add photos / drop" choice, "add photos" handing off
// to the parent's product_photo form.
//
// Manual-test checklist (no app-side test infra — plan Task 5 step 4):
//  - web (expo start --web → /submit → Scans): pick a venue via search,
//    allow the camera, hold a product barcode up → a row lands in the list
//    and resolves to a name or "unknown product"; sweeping back over the
//    same code within ~3 s does not duplicate it.
//  - deny/block the camera → "type it instead" field still captures.
//  - submit a mixed batch → response card shows published / queued /
//    already-on-menu counts.
//  - native (expo start → device): "Use my location" lists nearby venues
//    with distance; a new capture vibrates; deny camera → typed fallback.
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
  lookupProduct,
  nearbyVenues,
  submitScan,
  type NearbyVenue,
  type ProductLookupResult,
  type ScanSubmitResult,
  type Venue,
} from "../api";
import { ScanCamera } from "./ScanCamera";

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

// Spec: the same code within a ~3 s window counts once — sweeping back over
// a barcode re-confirms rather than re-adding.
const CODE_THROTTLE_MS = 3_000;
// On-camera chips linger briefly after their decode so the user sees what
// was picked up without watching the list.
const CHIP_TTL_MS = 4_000;
const NEARBY_LIMIT = 5;
const SEARCH_LIMIT = 10;

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

export function ScanTab({
  onAddPhotos,
}: {
  /** Hand an unknown code off to the parent's photo form (spec miss path). */
  onAddPhotos?: (code: string, venueName: string) => void;
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

  // Async lookup — never blocks the camera (spec: the capture list shows
  // "…" while in flight, then the product name or "unknown product").
  const resolve = useCallback(async (code: string) => {
    const patch = (p: Partial<Capture>) =>
      setCaptures((prev) => prev.map((c) => (c.code === code ? { ...c, ...p } : c)));
    // The lookup endpoint validates 8–14 digits; QR/Code-128 payloads that
    // aren't GTINs can never resolve, so they go straight to unknown.
    if (!/^\d{8,14}$/.test(code)) {
      patch({ status: "unknown" });
      return;
    }
    try {
      const res = await lookupProduct(code);
      patch({
        status: res.found ? "found" : "unknown",
        product: res.product,
        sourceTags: res.sources.map((s) => s.provider),
      });
    } catch {
      // Lookup unavailable — keep the code, mark it so the user can retry
      // by re-scanning, and let the photo path handle it either way.
      patch({ status: "failed" });
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
            {result.queued} item{result.queued === 1 ? "" : "s"} went to the normal review queue
            (today's trusted-publish limit is 100 items).
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
              onPress={() => onAddPhotos(unknown[0]!.code, venue?.name ?? "")}
            >
              <Text className="text-sm font-semibold text-emerald-800">Photograph an unknown</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  // ---- Step 1: venue pick (GPS-assisted, manual fallback unchanged). ----
  if (!venue) {
    return (
      <View className="gap-2">
        <Text className="text-sm leading-6 text-neutral-600">
          Scan packaged-product barcodes at a venue — every code in the batch attaches to the place
          you pick first.
        </Text>
        <VenuePick onPick={pickVenue} />
      </View>
    );
  }

  // ---- Step 2: camera + capture list. ----
  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-between">
        <View className="flex-1">
          <Text className="text-sm font-semibold text-neutral-800">Scanning at {venue.name}</Text>
          <Text className="text-xs text-neutral-500">Every code scanned attaches to this venue.</Text>
        </View>
        <Pressable
          className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5"
          onPress={() => setVenue(null)}
        >
          <Text className="text-sm font-medium text-neutral-700">Change</Text>
        </Pressable>
      </View>

      <View className="relative h-72 overflow-hidden rounded-xl bg-black">
        <ScanCamera active={!sheetOpen} onCode={handleCode} />
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
      {captures.map((c) => (
        <CaptureRow key={c.code} capture={c} onRemove={() => removeCode(c.code)} />
      ))}

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

      {/* Submit sheet: found/unknown counts, per-item remove, per-code
          "add photos or drop" for unknowns — then end the session. */}
      <Modal
        visible={sheetOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setSheetOpen(false)}
      >
        <View className="flex-1 justify-end bg-black/50">
          <View className="max-h-[85%] gap-3 rounded-t-2xl bg-white p-4">
            <Text className="text-base font-bold text-neutral-900">
              Submit {found.length} scanned product{found.length === 1 ? "" : "s"}
            </Text>
            <Text className="text-sm leading-6 text-neutral-600">
              {found.length} identified — publish{found.length === 1 ? "es" : ""} immediately at{" "}
              {venue.name} with a pending-verification badge.
              {unknown.length > 0
                ? ` ${unknown.length} unknown code${unknown.length === 1 ? "" : "s"} won't be in the batch — add photos or drop each one.`
                : ""}
            </Text>
            {resolving.length > 0 ? (
              <Text className="text-sm leading-6 text-amber-700">
                {resolving.length} lookup{resolving.length === 1 ? " is" : "s are"} still resolving —
                they'll be left out; submit again to add them.
              </Text>
            ) : null}

            <ScrollView className="max-h-72">
              <View className="gap-2">
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
                          onPress={() => onAddPhotos(c.code, venue.name)}
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
              </View>
            </ScrollView>

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

            <View className="flex-row gap-2">
              <Pressable
                className="flex-1 items-center rounded-lg border border-neutral-300 bg-white px-4 py-2.5"
                onPress={() => setSheetOpen(false)}
              >
                <Text className="text-sm font-semibold text-neutral-700">Keep scanning</Text>
              </Pressable>
              <Pressable
                className="flex-1 items-center rounded-lg bg-emerald-700 px-4 py-2.5 disabled:opacity-50"
                disabled={busy || found.length === 0}
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

// Venue pick (spec §4): "Use my location" → /api/venues/nearby → "Near you"
// top-5 with distance; permission denied or empty → the venue search below
// is the unchanged manual fallback. GPS is assistive, never enforced.
function VenuePick({ onPick }: { onPick: (v: PickedVenue) => void }) {
  const [nearby, setNearby] = useState<NearbyVenue[] | null>(null);
  const [locating, setLocating] = useState(false);
  const [locMsg, setLocMsg] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Venue[]>([]);
  const [searching, setSearching] = useState(false);

  async function useMyLocation() {
    setLocating(true);
    setLocMsg(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) {
        setLocMsg("Location permission denied — search for the venue below instead.");
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const list = await nearbyVenues(pos.coords.latitude, pos.coords.longitude, NEARBY_LIMIT);
      setNearby(list);
      if (list.length === 0) setLocMsg("No venues within ~500 m — search below.");
    } catch {
      setLocMsg("Couldn't get your location — search for the venue below instead.");
    } finally {
      setLocating(false);
    }
  }

  // Debounced venue search — the manual fallback, also the path for venues
  // with no geo on record (a shelf sweep there still scans fine).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let dead = false;
    const t = setTimeout(() => {
      setSearching(true);
      apiFetch<{ venues: Venue[] }>(`/venues?q=${encodeURIComponent(q)}`)
        .then((res) => {
          if (!dead) setResults(res.venues.slice(0, SEARCH_LIMIT));
        })
        .catch(() => {
          if (!dead) setResults([]);
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

  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold text-neutral-800">Where are you scanning?</Text>

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

      {nearby && nearby.length > 0 ? (
        <View className="gap-1.5">
          <Text className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Near you
          </Text>
          {nearby.map((v) => (
            <Pressable
              key={v.id}
              className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2"
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
    </View>
  );
}
