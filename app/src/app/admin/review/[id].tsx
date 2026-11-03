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
  ITEM_TYPES,
  VENUE_TYPES,
  type DraftItem,
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
        selected ? "border-emerald-700 bg-emerald-700" : "border-neutral-300 bg-white"
      }`}
      onPress={onPress}
    >
      <Text className={`text-xs font-medium ${selected ? "text-white" : "text-neutral-700"}`}>
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

  async function decide(action: "approve" | "reject") {
    setBusy(action);
    setError(null);
    try {
      if (action === "approve") {
        const draftItems = items
          .map(toDraft)
          .filter((it) => it.name.trim() !== "");
        await adminFetch(`/admin/submissions/${id}/approve`, {
          method: "POST",
          body: JSON.stringify(
            existingVenue
              ? { venue_id: existingVenue.id, items: draftItems }
              : {
                  venue: { name: venueName.trim(), type: venueType, area: venueArea },
                  items: draftItems,
                },
          ),
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
      <View className="flex-1 items-center justify-center bg-neutral-50 p-4">
        <Text className="text-sm text-red-600">{error}</Text>
      </View>
    );
  }
  if (!sub) {
    return (
      <View className="flex-1 items-center justify-center bg-neutral-50">
        <ActivityIndicator color="#047857" />
      </View>
    );
  }
  const decided = sub.status !== "pending_review";

  return (
    <ScrollView className="flex-1 bg-neutral-50">
      <Stack.Screen options={{ title: "Review submission" }} />
      {/* Side-by-side on wide screens (web), stacked on narrow. */}
      <View className="flex-col gap-4 p-4 lg:flex-row">
        {/* Left: source material */}
        <View className="gap-3 lg:w-1/2">
          <Text className="text-base font-bold text-neutral-900">Source</Text>
          <View className="gap-1 rounded-xl border border-neutral-200 bg-white p-3">
            <Text className="text-xs text-neutral-600">
              {sub.source_type} · submitted {new Date(sub.created_at).toLocaleString()}
            </Text>
            <Text className="text-sm text-neutral-800">Provenance: {sub.provenance}</Text>
            {sub.contact ? (
              <Text className="text-xs text-neutral-600">Contact: {sub.contact}</Text>
            ) : null}
            {sub.auto_flags.length > 0 ? (
              <Text className="text-xs font-medium text-amber-800">
                Flags: {sub.auto_flags.join(", ")}
              </Text>
            ) : null}
          </View>
          {sub.image_keys.length === 0 ? (
            <Text className="text-sm text-neutral-500">No source images ({sub.source_type}).</Text>
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
          <Text className="text-base font-bold text-neutral-900">Draft</Text>

          {decided ? (
            <Text className="rounded-lg bg-neutral-100 p-2 text-sm text-neutral-700">
              Already decided: {sub.status}
              {sub.rejection_reason ? ` — ${sub.rejection_reason}` : ""}
            </Text>
          ) : null}

          <View className="gap-2 rounded-xl border border-neutral-200 bg-white p-3">
            <Text className="text-sm font-semibold text-neutral-800">Venue</Text>
            <TextInput
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm"
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
                      existingVenue?.id === v.id ? "border-emerald-700 bg-emerald-50" : "border-neutral-200"
                    }`}
                    onPress={() => setExistingVenue(existingVenue?.id === v.id ? null : v)}
                  >
                    <Text className="text-sm text-neutral-800">
                      {v.name} · {v.area}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {existingVenue ? (
              <Text className="text-xs font-medium text-emerald-700">
                Publishing onto existing venue: {existingVenue.name} (its current items will be
                replaced)
              </Text>
            ) : (
              <>
                <TextInput
                  className="rounded-lg border border-neutral-300 px-3 py-2 text-sm"
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

          <View className="gap-2 rounded-xl border border-neutral-200 bg-white p-3">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-semibold text-neutral-800">
                Items ({items.length})
              </Text>
              <Pressable
                className="rounded-lg border border-neutral-300 px-2 py-1"
                onPress={() =>
                  setItems((prev) => [...prev, { name: "", item_type: "dish", priceText: "" }])
                }
              >
                <Text className="text-xs font-medium text-neutral-700">+ add item</Text>
              </Pressable>
            </View>
            {items.map((item, i) => (
              <View key={i} className="gap-1.5 rounded-lg border border-neutral-200 p-2">
                <View className="flex-row items-center gap-2">
                  <TextInput
                    className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm"
                    placeholder="Item name *"
                    value={item.name}
                    onChangeText={(name) => updateItem(i, { name })}
                  />
                  <TextInput
                    className="w-20 rounded border border-neutral-300 px-2 py-1 text-sm"
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
                    className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm"
                    placeholder="Category"
                    value={item.category ?? ""}
                    onChangeText={(category) => updateItem(i, { category })}
                  />
                </View>
              </View>
            ))}
          </View>

          {error ? <Text className="text-sm text-red-600">{error}</Text> : null}
          {done ? <Text className="text-sm font-medium text-emerald-700">{done}</Text> : null}

          {!decided ? (
            <View className="gap-2">
              <Pressable
                className="items-center rounded-lg bg-emerald-700 px-4 py-3 disabled:opacity-50"
                disabled={busy !== null || (!existingVenue && venueName.trim() === "")}
                onPress={() => decide("approve")}
              >
                <Text className="text-base font-semibold text-white">
                  {busy === "approve" ? "Publishing…" : "Approve & publish"}
                </Text>
              </Pressable>
              <TextInput
                className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm"
                placeholder="Rejection reason (required to reject)"
                value={rejectReason}
                onChangeText={setRejectReason}
              />
              <Pressable
                className="items-center rounded-lg border border-red-300 bg-white px-4 py-3 disabled:opacity-50"
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
