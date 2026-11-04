import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { API_BASE, apiFetch, type FoodItem } from "../../api";
import { authClient, getAuthCookie } from "../../auth";
import { HalalBadge } from "../../components/HalalBadge";
import { ItemCard } from "../../components/ItemCard";

const FRESHNESS_LABELS: Record<string, { text: string; className: string }> = {
  fresh: { text: "Menu verified recently", className: "text-emerald-700" },
  aging: { text: "Menu may be out of date", className: "text-amber-700" },
  stale: { text: "Menu hasn't been verified in a while", className: "text-red-700" },
};

// "I ate here" → POST /api/venues/:id/checkin. One check-in per user per
// venue per day (and 20/day overall — a repeat returns 429). Tapping the
// button opens an optional "was the menu accurate?" prompt; the answer
// rides along on the same request as `menu_accurate`, which doubles as a
// verification vote. Session cookie handling is the same as VerifyWidget.
function CheckInWidget({ venueId }: { venueId: string }) {
  const { data: session } = authClient.useSession();
  const [asked, setAsked] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function checkin(menuAccurate?: boolean) {
    setBusy(true);
    setError(null);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (Platform.OS !== "web") {
        const cookie = await getAuthCookie();
        if (cookie) headers.cookie = cookie;
      }
      const res = await fetch(`${API_BASE}/venues/${venueId}/checkin`, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify(menuAccurate === undefined ? {} : { menu_accurate: menuAccurate }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `check-in failed (${res.status})`);
      }
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "check-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="gap-2 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-4">
      {done ? (
        <Text className="text-sm text-emerald-700">Checked in — thanks for the visit report!</Text>
      ) : !session ? (
        <Text className="text-sm text-neutral-500 dark:text-neutral-400">Sign in to check in here.</Text>
      ) : !asked ? (
        <Pressable
          className="items-center rounded-lg border border-emerald-700 bg-emerald-700 px-4 py-2.5 disabled:opacity-50"
          disabled={busy}
          onPress={() => setAsked(true)}
        >
          <Text className="text-base font-semibold text-white">📍 I ate here</Text>
        </Pressable>
      ) : (
        <View className="gap-2">
          <Text className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Was the menu accurate?</Text>
          <View className="flex-row gap-2">
            <Pressable
              className="flex-1 items-center rounded-lg border border-emerald-700 bg-emerald-700 px-3 py-2.5 disabled:opacity-50"
              disabled={busy}
              onPress={() => checkin(true)}
            >
              <Text className="text-sm font-semibold text-white">Yes</Text>
            </Pressable>
            <Pressable
              className="flex-1 items-center rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2.5 disabled:opacity-50"
              disabled={busy}
              onPress={() => checkin(false)}
            >
              <Text className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Not quite</Text>
            </Pressable>
            <Pressable
              className="flex-1 items-center rounded-lg px-3 py-2.5 disabled:opacity-50"
              disabled={busy}
              onPress={() => checkin()}
            >
              <Text className="text-sm font-medium text-neutral-500 dark:text-neutral-400">Skip</Text>
            </Pressable>
          </View>
        </View>
      )}
      {error ? <Text className="text-sm text-red-600">{error}</Text> : null}
    </View>
  );
}

// "Is this menu still current?" 👍/👎 → POST /api/venues/:id/verify. Needs a
// session (one vote per user per venue per day); the cookie reaches the
// worker via credentials:"include" on web and the expoClient-stored cookie
// on native — same pattern as the submit screen.
function VerifyWidget({ venueId }: { venueId: string }) {
  const { data: session } = authClient.useSession();
  const [vote, setVote] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cast(accurate: boolean) {
    setBusy(true);
    setError(null);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (Platform.OS !== "web") {
        const cookie = await getAuthCookie();
        if (cookie) headers.cookie = cookie;
      }
      const res = await fetch(`${API_BASE}/venues/${venueId}/verify`, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ accurate }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `vote failed (${res.status})`);
      }
      setVote(accurate);
    } catch (e) {
      setError(e instanceof Error ? e.message : "vote failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="gap-2 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-4">
      <Text className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Is this menu still current?</Text>
      {vote !== null ? (
        <Text className="text-sm text-emerald-700">
          Thanks — your {vote ? "👍" : "👎"} helps reviewers know what needs checking.
        </Text>
      ) : session ? (
        <View className="flex-row gap-2">
          <Pressable
            className="flex-1 items-center rounded-lg border border-emerald-700 bg-emerald-700 px-4 py-2.5 disabled:opacity-50"
            disabled={busy}
            onPress={() => cast(true)}
          >
            <Text className="text-base font-semibold text-white">👍 Yes, still current</Text>
          </Pressable>
          <Pressable
            className="flex-1 items-center rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-4 py-2.5 disabled:opacity-50"
            disabled={busy}
            onPress={() => cast(false)}
          >
            <Text className="text-base font-semibold text-neutral-800 dark:text-neutral-100">👎 It's out of date</Text>
          </Pressable>
        </View>
      ) : (
        <Text className="text-sm text-neutral-500 dark:text-neutral-400">Sign in to tell us.</Text>
      )}
      {error ? <Text className="text-sm text-red-600">{error}</Text> : null}
    </View>
  );
}

// Venue detail. The API has no `GET /api/venues/:id`, so the header fields
// arrive as route params from VenueCard; items are fetched from
// `/api/venues/:id/items`.
export default function VenueScreen() {
  const params = useLocalSearchParams<{
    id: string;
    name?: string;
    type?: string;
    area?: string;
    halal_status?: string;
    verification?: string;
    freshness?: string;
    is_stub?: string;
  }>();
  const [items, setItems] = useState<FoodItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.id) return;
    apiFetch<{ items: FoodItem[] }>(`/venues/${params.id}/items`)
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [params.id]);

  const freshness = params.freshness ? FRESHNESS_LABELS[params.freshness] : undefined;

  return (
    <ScrollView className="flex-1 bg-neutral-50 dark:bg-neutral-900" contentContainerClassName="gap-4 p-4">
      <Stack.Screen options={{ title: params.name ?? "Venue" }} />

      <View className="gap-1.5">
        <Text className="text-xl font-bold text-neutral-900 dark:text-neutral-100">{params.name ?? "Venue"}</Text>
        <View className="flex-row items-center gap-2">
          <Text className="text-sm text-neutral-600 dark:text-neutral-300">
            {[params.type, params.area].filter(Boolean).join(" · ") || "—"}
          </Text>
          {params.halal_status ? <HalalBadge status={params.halal_status} /> : null}
        </View>
        {params.verification && params.verification !== "unverified" ? (
          <Text className="text-xs font-medium text-sky-700">✓ {params.verification}</Text>
        ) : null}
        {freshness ? <Text className={`text-xs font-medium ${freshness.className}`}>{freshness.text}</Text> : null}
        {params.is_stub === "true" ? (
          <Text className="text-xs font-semibold text-amber-700">
            ⚑ Menu needed — this is a stub. Be the first to send its menu in.
          </Text>
        ) : null}
      </View>

      {params.id ? <CheckInWidget venueId={params.id} /> : null}
      {params.id ? <VerifyWidget venueId={params.id} /> : null}

      {loading ? <ActivityIndicator color="#047857" /> : null}
      {error ? <Text className="text-sm text-red-600">{error}</Text> : null}
      {!loading && !error && items.length === 0 ? (
        <Text className="py-8 text-center text-neutral-500 dark:text-neutral-400">No published items yet.</Text>
      ) : null}

      <View className="gap-2">
        {items.map((item) => (
          <ItemCard key={item.id} item={item} />
        ))}
      </View>
    </ScrollView>
  );
}
