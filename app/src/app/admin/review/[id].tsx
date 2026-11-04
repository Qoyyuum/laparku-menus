import { Image } from "expo-image";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  API_BASE,
  apiFetch,
  AREAS,
  formatBnd,
  ITEM_TYPES,
  VENUE_TYPES,
  type DraftItem,
  type FoodItem,
  type QueueSubmission,
  type Venue,
} from "../../../api";
import { AdminApiError, adminFetch, getAuthCookie } from "../../../auth";
import { SignInGate } from "../../../components/SignInGate";

// Editable copy of a draft item — price is kept as text while typing.
interface EditableItem extends Omit<DraftItem, "price_bnd"> {
  priceText: string;
}

function toEditable(item: DraftItem): EditableItem {
  return { ...item, priceText: item.price_bnd == null ? "" : String(item.price_bnd) };
}

function toDraft(item: EditableItem): DraftItem {
  const { priceText, ...rest } = item;
  const trimmed = priceText.trim();
  const price = trimmed === "" ? undefined : Number(trimmed);
  return { ...rest, price_bnd: Number.isFinite(price) ? price : undefined };
}

// Mirror of src/lib/match.ts (the app can't import worker code) — barcode
// equality first (exact, strongest signal), then the same normalized-name +
// 20%-price heuristic the merge UI labels with.
function normalizeName(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function suggestedMatch(draft: EditableItem, existing: FoodItem[]): FoodItem | null {
  const barcode = draft.barcode?.trim() ?? "";
  if (barcode) {
    const hit = existing.find((i) => i.barcode != null && i.barcode.trim() === barcode);
    if (hit) return hit;
  }
  const key = normalizeName(draft.name);
  const price = toDraft(draft).price_bnd;
  let best: FoodItem | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const item of existing) {
    if (normalizeName(item.name) !== key) continue;
    if (price !== undefined && item.price_bnd !== null) {
      if (Math.abs(price - item.price_bnd) > 0.2 * item.price_bnd) continue;
      const diff = Math.abs(price - item.price_bnd);
      if (diff < bestDiff) {
        best = item;
        bestDiff = diff;
      }
    } else if (best === null) {
      best = item;
    }
  }
  return best;
}

// Reviewer-only image URL — the session cookie rides along on web
// (same-origin); native needs it as an explicit header (read asynchronously
// by the screen and passed in).
function imageSource(key: string, cookie: string) {
  const uri = `${API_BASE}/admin/images/${key}`;
  if (Platform.OS === "web") return { uri };
  return { uri, headers: { cookie } };
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      className={`rounded-full border px-3 py-1 ${
        selected ? "border-emerald-700 bg-emerald-700" : "border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800"
      }`}
      onPress={onPress}
    >
      <Text className={`text-xs font-medium ${selected ? "text-white" : "text-neutral-700 dark:text-neutral-300"}`}>
        {label}
      </Text>
    </Pressable>
  );
}

function ReviewForm({ id }: { id: string }) {
  const router = useRouter();
  const [sub, setSub] = useState<QueueSubmission | null>(null);
  const [cookie, setCookie] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Venue target: an existing venue id, or a new-venue draft.
  const [existingVenue, setExistingVenue] = useState<Venue | null>(null);
  const [venueQuery, setVenueQuery] = useState("");
  const [venueMatches, setVenueMatches] = useState<Venue[]>([]);
  const [venueName, setVenueName] = useState("");
  const [venueType, setVenueType] = useState<(typeof VENUE_TYPES)[number]>("restaurant");
  const [venueArea, setVenueArea] = useState<(typeof AREAS)[number]>("Brunei-Muara");

  const [items, setItems] = useState<EditableItem[]>([]);
  // Merge mode: which of the venue's current items survive (keepIds) and
  // which draft rows get added (dropDrafts holds the EXCLUDED indices).
  const [mode, setMode] = useState<"replace" | "merge">("replace");
  const [existingItems, setExistingItems] = useState<FoodItem[]>([]);
  const [menuTruncated, setMenuTruncated] = useState(false);
  const [keepIds, setKeepIds] = useState<Set<string>>(new Set());
  const [dropDrafts, setDropDrafts] = useState<Set<number>>(new Set());
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    adminFetch<{ submission: QueueSubmission }>(`/admin/submissions/${id}`)
      .then(({ submission: s }) => {
        setSub(s);
        const guess = s.raw_extraction?.venue_guess;
        if (guess?.name) setVenueName(guess.name);
        if (guess?.type && (VENUE_TYPES as readonly string[]).includes(guess.type)) {
          setVenueType(guess.type as (typeof VENUE_TYPES)[number]);
        }
        if (guess?.area && (AREAS as readonly string[]).includes(guess.area)) {
          setVenueArea(guess.area as (typeof AREAS)[number]);
        }
        setItems((s.raw_extraction?.items ?? []).map(toEditable));
      })
      .catch((e: Error) => setError(e.message));
    if (Platform.OS !== "web") getAuthCookie().then(setCookie);
  }, [id]);

  // Selecting an existing venue loads its current menu for the merge picker
  // (default: keep everything, add every draft — the reviewer trims).
  useEffect(() => {
    setMode("replace");
    setDropDrafts(new Set());
    if (!existingVenue) {
      setExistingItems([]);
      setKeepIds(new Set());
      setMenuTruncated(false);
      return;
    }
    adminFetch<{ items: FoodItem[]; total: number; truncated: boolean }>(
      `/admin/venues/${existingVenue.id}/items`,
    )
      .then(({ items: rows, total, truncated }) => {
        setExistingItems(rows);
        setKeepIds(new Set(rows.map((i) => i.id)));
        setMenuTruncated(truncated || rows.length < total);
      })
      .catch(() => {
        setExistingItems([]);
        setKeepIds(new Set());
        setMenuTruncated(false);
      });
  }, [existingVenue]);

  const searchVenues = useCallback(async (q: string) => {
    setVenueQuery(q);
    if (q.trim().length < 2) {
      setVenueMatches([]);
      return;
    }
    try {
      const res = await apiFetch<{ venues: Venue[] }>(`/venues?q=${encodeURIComponent(q.trim())}`);
      setVenueMatches(res.venues.slice(0, 5));
    } catch {
      setVenueMatches([]);
    }
  }, []);

  function updateItem(i: number, patch: Partial<EditableItem>) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }

  function toggleKeep(itemId: string) {
    setKeepIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function toggleDropDraft(i: number) {
    setDropDrafts((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  const merging = existingVenue !== null && mode === "merge";
  const selectedDrafts = items
    .map((it, i) => ({ it, i }))
    .filter(({ it, i }) => it.name.trim() !== "" && (!merging || !dropDrafts.has(i)));
  const selectionEmpty = merging && keepIds.size === 0 && selectedDrafts.length === 0;

  async function decide(action: "approve" | "reject") {
    setBusy(action);
    setError(null);
    try {
      if (action === "approve") {
        const venueTarget = existingVenue
          ? { venue_id: existingVenue.id }
          : { venue: { name: venueName.trim(), type: venueType, area: venueArea } };
        const body = merging
          ? {
              ...venueTarget,
              mode: "merge" as const,
              items: [
                ...existingItems
                  .filter((i) => keepIds.has(i.id))
                  .map((i) => ({ source: "existing" as const, item_id: i.id })),
                ...selectedDrafts.map(({ it, i }) => ({
                  source: "draft" as const,
                  draft_index: i,
                  ...toDraft(it),
                })),
              ],
            }
          : {
              ...venueTarget,
              mode: "replace" as const,
              items: items.map(toDraft).filter((it) => it.name.trim() !== ""),
            };
        await adminFetch(`/admin/submissions/${id}/approve`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        setDone("Published — the new menu is live.");
      } else {
        await adminFetch(`/admin/submissions/${id}/reject`, {
          method: "POST",
          body: JSON.stringify({ reason: rejectReason.trim() }),
        });
        setDone("Rejected.");
      }
      setTimeout(() => router.back(), 800);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(null);
    }
  }

  if (error && !sub) {
    return (
      <View className="flex-1 items-center justify-center bg-neutral-50 dark:bg-neutral-900 p-4">
        <Text className="text-sm text-red-600">{error}</Text>
      </View>
    );
  }
  if (!sub) {
    return (
      <View className="flex-1 items-center justify-center bg-neutral-50 dark:bg-neutral-900">
        <ActivityIndicator color="#047857" />
      </View>
    );
  }
  const decided = sub.status !== "pending_review";

  return (
    <ScrollView className="flex-1 bg-neutral-50 dark:bg-neutral-900">
      <Stack.Screen options={{ title: "Review submission" }} />
      {/* Side-by-side on wide screens (web), stacked on narrow. */}
      <View className="flex-col gap-4 p-4 lg:flex-row">
        {/* Left: source material */}
        <View className="gap-3 lg:w-1/2">
          <Text className="text-base font-bold text-neutral-900 dark:text-neutral-100">Source</Text>
          <View className="gap-1 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-3">
            <Text className="text-xs text-neutral-600 dark:text-neutral-300">
              {sub.source_type} · submitted {new Date(sub.created_at).toLocaleString()}
            </Text>
            <Text className="text-sm text-neutral-800 dark:text-neutral-100">Provenance: {sub.provenance}</Text>
            {sub.contact ? (
              <Text className="text-xs text-neutral-600 dark:text-neutral-300">Contact: {sub.contact}</Text>
            ) : null}
            {sub.auto_flags.length > 0 ? (
              <Text className="text-xs font-medium text-amber-800">
                Flags: {sub.auto_flags.join(", ")}
              </Text>
            ) : null}
          </View>
          {sub.image_keys.length === 0 ? (
            <Text className="text-sm text-neutral-500 dark:text-neutral-400">No source images ({sub.source_type}).</Text>
          ) : (
            sub.image_keys.map((key) => (
              <Image
                key={key}
                source={imageSource(key, cookie)}
                style={{ width: "100%", height: 320, borderRadius: 12, backgroundColor: "#e5e5e5" }}
                contentFit="contain"
              />
            ))
          )}
        </View>

        {/* Right: editable draft + decision */}
        <View className="gap-3 lg:w-1/2">
          <Text className="text-base font-bold text-neutral-900 dark:text-neutral-100">Draft</Text>

          {decided ? (
            <Text className="rounded-lg bg-neutral-100 dark:bg-neutral-800 p-2 text-sm text-neutral-700 dark:text-neutral-300">
              Already decided: {sub.status}
              {sub.rejection_reason ? ` — ${sub.rejection_reason}` : ""}
            </Text>
          ) : null}

          <View className="gap-2 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-3">
            <Text className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Venue</Text>
            <TextInput
              className="rounded-lg border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              placeholder="Search existing venue…"
              value={venueQuery}
              onChangeText={searchVenues}
            />
            {venueMatches.length > 0 ? (
              <View className="gap-1">
                {venueMatches.map((v) => (
                  <Pressable
                    key={v.id}
                    className={`rounded-lg border px-2 py-1.5 ${
                      existingVenue?.id === v.id ? "border-emerald-700 bg-emerald-50" : "border-neutral-200 dark:border-neutral-700"
                    }`}
                    onPress={() => setExistingVenue(existingVenue?.id === v.id ? null : v)}
                  >
                    <Text className="text-sm text-neutral-800 dark:text-neutral-100">
                      {v.name} · {v.area}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {existingVenue ? (
              <>
                <Text className="text-xs font-medium text-emerald-700">
                  Publishing onto existing venue: {existingVenue.name}
                </Text>
                <View className="flex-row flex-wrap gap-1.5">
                  <Chip
                    label="Replace menu"
                    selected={mode === "replace"}
                    onPress={() => setMode("replace")}
                  />
                  <Chip
                    label="Merge items"
                    selected={mode === "merge"}
                    onPress={() => setMode("merge")}
                  />
                </View>
                <Text className="text-xs text-neutral-600 dark:text-neutral-300">
                  {mode === "replace"
                    ? "The venue's current items are all superseded; only the draft below goes live."
                    : "Pick which existing items stay live and which draft rows to add. Anything not kept is superseded, not deleted."}
                </Text>
              </>
            ) : (
              <>
                <TextInput
                  className="rounded-lg border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                  placeholder="New venue name *"
                  value={venueName}
                  onChangeText={setVenueName}
                />
                <View className="flex-row flex-wrap gap-1.5">
                  {VENUE_TYPES.map((t) => (
                    <Chip key={t} label={t} selected={venueType === t} onPress={() => setVenueType(t)} />
                  ))}
                </View>
                <View className="flex-row flex-wrap gap-1.5">
                  {AREAS.map((a) => (
                    <Chip key={a} label={a} selected={venueArea === a} onPress={() => setVenueArea(a)} />
                  ))}
                </View>
              </>
            )}
          </View>

          {merging ? (
            <View className="gap-2 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-3">
              <Text className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                Existing menu ({keepIds.size}/{existingItems.length} kept)
              </Text>
              {menuTruncated ? (
                <Text className="rounded bg-amber-50 p-2 text-xs font-medium text-amber-800">
                  This menu has more items than shown — items not listed below would be superseded.
                  Use Replace mode or split the merge.
                </Text>
              ) : null}
              {existingItems.length === 0 ? (
                <Text className="text-xs text-neutral-500 dark:text-neutral-400">This venue has no current items.</Text>
              ) : (
                existingItems.map((item) => (
                  <Pressable
                    key={item.id}
                    className={`flex-row items-center justify-between rounded-lg border px-2 py-1.5 ${
                      keepIds.has(item.id) ? "border-emerald-300 bg-emerald-50" : "border-neutral-200 dark:border-neutral-700 opacity-60"
                    }`}
                    onPress={() => toggleKeep(item.id)}
                  >
                    <Text className="flex-1 text-sm text-neutral-800 dark:text-neutral-100" numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text className="mx-2 text-xs text-neutral-500 dark:text-neutral-400">{formatBnd(item.price_bnd)}</Text>
                    <Text
                      className={`text-xs font-semibold ${
                        keepIds.has(item.id) ? "text-emerald-700" : "text-neutral-500 dark:text-neutral-400"
                      }`}
                    >
                      {keepIds.has(item.id) ? "keep" : "drop"}
                    </Text>
                  </Pressable>
                ))
              )}
            </View>
          ) : null}

          <View className="gap-2 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-3">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                Items ({items.length})
              </Text>
              <Pressable
                className="rounded-lg border border-neutral-300 dark:border-neutral-600 px-2 py-1"
                onPress={() =>
                  setItems((prev) => [...prev, { name: "", item_type: "dish", priceText: "" }])
                }
              >
                <Text className="text-xs font-medium text-neutral-700 dark:text-neutral-300">+ add item</Text>
              </Pressable>
            </View>
            {items.map((item, i) => {
              const match = merging && item.name.trim() !== "" ? suggestedMatch(item, existingItems) : null;
              const dropped = merging && dropDrafts.has(i);
              return (
              <View
                key={i}
                className={`gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 p-2 ${dropped ? "opacity-50" : ""}`}
              >
                {merging ? (
                  <View className="flex-row items-center justify-between">
                    <Text className="flex-1 text-xs text-neutral-500 dark:text-neutral-400" numberOfLines={1}>
                      {match
                        ? `≈ matches existing "${match.name}" (${formatBnd(match.price_bnd)})`
                        : "new item"}
                    </Text>
                    <Pressable onPress={() => toggleDropDraft(i)}>
                      <Text
                        className={`text-xs font-semibold ${dropped ? "text-neutral-500 dark:text-neutral-400" : "text-emerald-700"}`}
                      >
                        {dropped ? "skip" : "add"}
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
                <View className="flex-row items-center gap-2">
                  <TextInput
                    className="flex-1 rounded border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                    placeholder="Item name *"
                    value={item.name}
                    onChangeText={(name) => updateItem(i, { name })}
                  />
                  <TextInput
                    className="w-20 rounded border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                    placeholder="B$"
                    keyboardType="decimal-pad"
                    value={item.priceText}
                    onChangeText={(priceText) => updateItem(i, { priceText })}
                  />
                  <Pressable onPress={() => setItems((prev) => prev.filter((_, idx) => idx !== i))}>
                    <Text className="text-base text-red-600">×</Text>
                  </Pressable>
                </View>
                <View className="flex-row items-center gap-2">
                  <View className="flex-row gap-1">
                    {ITEM_TYPES.map((t) => (
                      <Chip
                        key={t}
                        label={t}
                        selected={item.item_type === t}
                        onPress={() => updateItem(i, { item_type: t })}
                      />
                    ))}
                  </View>
                  <TextInput
                    className="flex-1 rounded border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                    placeholder="Category"
                    value={item.category ?? ""}
                    onChangeText={(category) => updateItem(i, { category })}
                  />
                </View>
              </View>
              );
            })}
          </View>

          {error ? <Text className="text-sm text-red-600">{error}</Text> : null}
          {done ? <Text className="text-sm font-medium text-emerald-700">{done}</Text> : null}

          {!decided ? (
            <View className="gap-2">
              <Pressable
                className="items-center rounded-lg bg-emerald-700 px-4 py-3 disabled:opacity-50"
                disabled={
                  busy !== null ||
                  (!existingVenue && venueName.trim() === "") ||
                  (merging ? selectionEmpty : items.every((i) => i.name.trim() === ""))
                }
                onPress={() => decide("approve")}
              >
                <Text className="text-base font-semibold text-white">
                  {busy === "approve" ? "Publishing…" : "Approve & publish"}
                </Text>
              </Pressable>
              <TextInput
                className="rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm"
                placeholder="Rejection reason (required to reject)"
                value={rejectReason}
                onChangeText={setRejectReason}
              />
              <Pressable
                className="items-center rounded-lg border border-red-300 bg-white dark:bg-neutral-800 px-4 py-3 disabled:opacity-50"
                disabled={busy !== null || rejectReason.trim() === ""}
                onPress={() => decide("reject")}
              >
                <Text className="text-base font-semibold text-red-700">
                  {busy === "reject" ? "Rejecting…" : "Reject"}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}

export default function ReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <SignInGate>
      <ReviewForm id={id} />
    </SignInGate>
  );
}
