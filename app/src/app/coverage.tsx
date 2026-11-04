import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  AREAS,
  apiFetch,
  type CoverageArea,
  type Venue,
  type VenueRequest,
} from "../api";
import { adminFetch, authClient } from "../auth";

// Coverage — where the map is thin and what's needed next. Three lists:
// the per-area rollup from GET /api/coverage, the "menu needed" stub venues
// (GET /api/venues?stub=true), and open missions (GET /api/requests). A
// signed-in user can file a new mission from the form at the bottom.
export default function CoverageScreen() {
  const { data: session } = authClient.useSession();
  const [areas, setAreas] = useState<CoverageArea[]>([]);
  const [stubs, setStubs] = useState<Venue[]>([]);
  const [requests, setRequests] = useState<VenueRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      apiFetch<{ areas: CoverageArea[] }>("/coverage"),
      apiFetch<{ venues: Venue[] }>("/venues?stub=true"),
      apiFetch<{ requests: VenueRequest[] }>("/requests?status=open"),
    ])
      .then(([c, s, r]) => {
        if (!cancelled) {
          setAreas(c.areas);
          setStubs(s.venues);
          setRequests(r.requests);
          setError(null);
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <ScrollView className="flex-1 bg-neutral-50" contentContainerClassName="gap-4 p-4">
      <Text className="text-xl font-bold text-neutral-900">Coverage</Text>
      <Text className="text-sm leading-6 text-neutral-600">
        What's mapped, where menus are still needed, and the missions filed by the community.
      </Text>

      {loading ? <ActivityIndicator color="#047857" /> : null}
      {error ? <Text className="text-sm text-red-600">{error}</Text> : null}

      {/* Per-area rollup */}
      <View className="gap-1.5">
        <Text className="text-sm font-semibold text-neutral-800">By area</Text>
        <View className="gap-2">
          {areas.map((a) => (
            <View key={a.area} className="rounded-lg border border-neutral-200 bg-white px-3 py-2">
              <View className="flex-row items-center justify-between">
                <Text className="text-base font-semibold text-neutral-900">{a.area}</Text>
                <Text className="text-xs text-neutral-500">
                  {a.venues} venues · {a.items} items
                </Text>
              </View>
              <Text className="text-xs text-neutral-600">
                {a.stubs} menu{a.stubs === 1 ? "" : "s"} needed · {a.open_requests} open mission
                {a.open_requests === 1 ? "" : "s"}
              </Text>
            </View>
          ))}
        </View>
      </View>

      {/* "Menu needed" stubs */}
      <View className="gap-1.5">
        <Text className="text-sm font-semibold text-neutral-800">Menu needed</Text>
        <Text className="text-xs text-neutral-500">
          Stub venues — we know they exist, but nobody's menu has landed yet.
        </Text>
        <View className="gap-2">
          {stubs.map((v) => (
            <View
              key={v.id}
              className="flex-row items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"
            >
              <View className="flex-1">
                <Text className="text-base font-medium text-neutral-900" numberOfLines={1}>
                  {v.name}
                </Text>
                <Text className="text-xs text-neutral-600">
                  {v.type} · {v.area}
                </Text>
                <Text className="text-xs font-semibold text-amber-700">⚑ menu needed</Text>
              </View>
              <Link href="/submit">
                <Text className="text-xs font-semibold text-emerald-700">Submit menu →</Text>
              </Link>
            </View>
          ))}
          {!loading && stubs.length === 0 ? (
            <Text className="text-sm text-neutral-600">No stubs — every known venue has a menu.</Text>
          ) : null}
        </View>
      </View>

      {/* Open missions */}
      <View className="gap-1.5">
        <Text className="text-sm font-semibold text-neutral-800">Open missions</Text>
        <Text className="text-xs text-neutral-500">
          Requests filed by the community. Filing a menu for one of these marks it fulfilled.
        </Text>
        <View className="gap-2">
          {requests.map((r) => (
            <View
              key={r.id}
              className="flex-row items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2"
            >
              <View className="flex-1">
                <Text className="text-base font-medium text-neutral-900" numberOfLines={1}>
                  {r.venue_name ?? r.free_text_name ?? "—"}
                </Text>
                <Text className="text-xs text-neutral-600">{r.area}</Text>
                {r.note ? <Text className="mt-1 text-xs italic text-neutral-500">“{r.note}”</Text> : null}
              </View>
              <Link href="/submit">
                <Text className="text-xs font-semibold text-emerald-700">Capture this →</Text>
              </Link>
            </View>
          ))}
          {!loading && requests.length === 0 ? (
            <Text className="text-sm text-neutral-600">No open missions right now.</Text>
          ) : null}
        </View>
      </View>

      <RequestForm
        signedIn={!!session}
        onFiled={() => setRefreshKey((k) => k + 1)}
      />
    </ScrollView>
  );
}

// POST /api/requests — file a free-text mission for a venue that isn't in
// the dataset yet. (Requests attached to a stub venue are filed from that
// venue's surface.)
function RequestForm({ signedIn, onFiled }: { signedIn: boolean; onFiled: () => void }) {
  const [name, setName] = useState("");
  const [area, setArea] = useState<(typeof AREAS)[number]>("Brunei-Muara");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function file() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await adminFetch("/requests", {
        method: "POST",
        body: JSON.stringify({ free_text_name: name.trim(), area, note: note.trim() || undefined }),
      });
      setName("");
      setNote("");
      setMessage("Mission filed — thanks!");
      onFiled();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="gap-2 rounded-xl border border-neutral-200 bg-white p-4">
      <Text className="text-base font-bold text-neutral-900">Request a venue</Text>
      {signedIn ? (
        <>
          <TextInput
            className="rounded-lg border border-neutral-300 px-3 py-2 text-base"
            placeholder="Venue name"
            maxLength={120}
            value={name}
            onChangeText={setName}
          />
          <View className="flex-row flex-wrap gap-2">
            {AREAS.map((a) => (
              <Pressable
                key={a}
                className={`rounded-full border px-3 py-1.5 ${
                  area === a ? "border-emerald-700 bg-emerald-700" : "border-neutral-300 bg-white"
                }`}
                onPress={() => setArea(a)}
              >
                <Text className={`text-sm font-medium ${area === a ? "text-white" : "text-neutral-700"}`}>
                  {a}
                </Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            className="rounded-lg border border-neutral-300 px-3 py-2 text-base"
            placeholder="Note (optional — e.g. where to find it)"
            maxLength={500}
            value={note}
            onChangeText={setNote}
          />
          {error ? <Text className="text-sm text-red-600">{error}</Text> : null}
          {message ? <Text className="text-sm font-medium text-emerald-700">{message}</Text> : null}
          <Pressable
            className="items-center rounded-lg bg-emerald-700 px-4 py-2.5 disabled:opacity-50"
            disabled={busy || name.trim() === ""}
            onPress={file}
          >
            <Text className="text-base font-semibold text-white">{busy ? "Filing…" : "File mission"}</Text>
          </Pressable>
          <Text className="text-xs text-neutral-500">
            Have the menu itself? <Link href="/submit" className="text-emerald-700">Submit it instead</Link>.
          </Text>
        </>
      ) : (
        <Text className="text-sm text-neutral-500">Sign in to request a venue.</Text>
      )}
    </View>
  );
}
