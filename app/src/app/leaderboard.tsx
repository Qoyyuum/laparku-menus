import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import {
  API_BASE,
  AREAS,
  LEADERBOARD_KINDS,
  LEADERBOARD_PERIODS,
  type LeaderboardKind,
  type LeaderboardPeriod,
  type LeaderboardResponse,
} from "../api";
import { authClient, getAuthCookie } from "../auth";

const KIND_LABELS: Record<LeaderboardKind, string> = {
  checkins: "Check-ins",
  contributions: "Contributions",
  verifications: "Verifications",
};
const PERIOD_LABELS: Record<LeaderboardPeriod, string> = {
  week: "This week",
  month: "This month",
  all: "All time",
};
// `undefined` = omit the param (server defaults a signed-in caller to their
// home board — the area they check into most); "" = explicitly all areas.
type AreaChoice = (typeof AREAS)[number] | "" | undefined;
const AREA_CHOICES: { value: AreaChoice; label: string }[] = [
  { value: undefined, label: "My area" },
  { value: "", label: "All areas" },
  ...AREAS.map((a) => ({ value: a as AreaChoice, label: a })),
];

// Authenticated fetch: web rides the same-origin session cookie, native
// forwards the expoClient-stored cookie explicitly (same pattern as
// adminFetch in src/auth.ts).
async function authedFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body != null) headers["content-type"] = "application/json";
  if (Platform.OS !== "web") {
    const cookie = await getAuthCookie();
    if (cookie) headers.cookie = cookie;
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: "include" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export default function LeaderboardScreen() {
  const { data: session } = authClient.useSession();
  const [kind, setKind] = useState<LeaderboardKind>("checkins");
  const [period, setPeriod] = useState<LeaderboardPeriod>("month");
  const [area, setArea] = useState<AreaChoice>(undefined);
  const [result, setResult] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped when the opt-in card saves so the board re-fetches (the caller's
  // own name may have just appeared).
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ kind, period });
    if (area !== undefined) params.set("area", area);
    authedFetch<LeaderboardResponse>(`/leaderboards?${params}`)
      .then((r) => {
        if (!cancelled) {
          setResult(r);
          setError(null);
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [kind, period, area, refreshKey, session?.user?.id]);

  return (
    <ScrollView className="flex-1 bg-neutral-50" contentContainerClassName="gap-4 p-4">
      <Text className="text-xl font-bold text-neutral-900">Leaderboards</Text>

      <View className="gap-1.5">
        <Text className="text-sm font-semibold text-neutral-800">Board</Text>
        <View className="flex-row flex-wrap gap-2">
          {LEADERBOARD_KINDS.map((k) => (
            <PickerChip key={k} label={KIND_LABELS[k]} active={kind === k} onPress={() => setKind(k)} />
          ))}
        </View>
      </View>

      <View className="gap-1.5">
        <Text className="text-sm font-semibold text-neutral-800">Period</Text>
        <View className="flex-row flex-wrap gap-2">
          {LEADERBOARD_PERIODS.map((p) => (
            <PickerChip key={p} label={PERIOD_LABELS[p]} active={period === p} onPress={() => setPeriod(p)} />
          ))}
        </View>
      </View>

      <View className="gap-1.5">
        <Text className="text-sm font-semibold text-neutral-800">Area</Text>
        <View className="flex-row flex-wrap gap-2">
          {AREA_CHOICES.map((a) => (
            <PickerChip key={a.label} label={a.label} active={area === a.value} onPress={() => setArea(a.value)} />
          ))}
        </View>
        {result?.area ? (
          <Text className="text-xs text-neutral-500">Showing {result.area}</Text>
        ) : null}
      </View>

      {loading ? <ActivityIndicator color="#047857" /> : null}
      {error ? <Text className="text-sm text-red-600">{error}</Text> : null}

      {result?.me ? (
        <View className="rounded-lg border border-emerald-700 bg-emerald-50 px-3 py-2">
          <Text className="text-sm font-semibold text-emerald-800">
            You: #{result.me.rank} · {result.me.count}
          </Text>
        </View>
      ) : null}

      <View className="gap-2">
        {result?.board.map((r, i) => (
          <View
            key={`${r.rank}-${i}`}
            className={`flex-row items-center gap-3 rounded-lg border px-3 py-2 ${
              result.me?.rank === r.rank ? "border-emerald-700 bg-emerald-50" : "border-neutral-200 bg-white"
            }`}
          >
            <Text className="w-8 text-base font-bold text-neutral-500">#{r.rank}</Text>
            <Text className="flex-1 text-base text-neutral-900" numberOfLines={1}>
              {r.name}
            </Text>
            <Text className="text-base font-semibold text-neutral-800">{r.count}</Text>
          </View>
        ))}
        {!loading && result && result.board.length === 0 ? (
          <Text className="text-sm text-neutral-600">
            Nobody on this board yet — be the first.
          </Text>
        ) : null}
      </View>

      {session ? <OptInCard onSaved={() => setRefreshKey((k) => k + 1)} /> : null}
    </ScrollView>
  );
}

function PickerChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      className={`rounded-full border px-3 py-1.5 ${
        active ? "border-emerald-700 bg-emerald-700" : "border-neutral-300 bg-white"
      }`}
      onPress={onPress}
    >
      <Text className={`text-sm font-medium ${active ? "text-white" : "text-neutral-700"}`}>{label}</Text>
    </Pressable>
  );
}

// The opt-in editor for the leaderboard prefs (PATCH /api/me): a display
// name plus the show_on_leaderboard toggle. Names only render for opted-in
// users — the default is "Anonymous".
function OptInCard({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Prefill with the stored prefs via GET /api/me (Task 7) so the toggles
  // reflect what's saved rather than always starting blank. Only rendered
  // when signed in, so the request is authorized.
  useEffect(() => {
    let cancelled = false;
    authedFetch<{ display_name: string | null; show_on_leaderboard: boolean }>("/me")
      .then((m) => {
        if (cancelled) return;
        setName(m.display_name ?? "");
        setShow(m.show_on_leaderboard);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await authedFetch("/me", {
        method: "PATCH",
        body: JSON.stringify({ display_name: name.trim() || null, show_on_leaderboard: show }),
      });
      setMessage("Saved.");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="gap-2 rounded-xl border border-neutral-200 bg-white p-4">
      <Text className="text-base font-bold text-neutral-900">Your display settings</Text>
      <Text className="text-sm leading-6 text-neutral-600">
        Boards show “Anonymous” unless you opt in with a display name.
      </Text>
      <TextInput
        className="rounded-lg border border-neutral-300 px-3 py-2 text-base"
        placeholder="Display name (e.g. Menu Hunter)"
        maxLength={80}
        value={name}
        onChangeText={setName}
      />
      <View className="flex-row items-center gap-2">
        <Switch value={show} onValueChange={setShow} />
        <Text className="text-sm text-neutral-800">Show my name on leaderboards</Text>
      </View>
      {error ? <Text className="text-sm text-red-600">{error}</Text> : null}
      {message ? <Text className="text-sm font-medium text-emerald-700">{message}</Text> : null}
      <Pressable
        className="items-center rounded-lg bg-emerald-700 px-4 py-2.5 disabled:opacity-50"
        disabled={busy || (show && name.trim() === "")}
        onPress={save}
      >
        <Text className="text-base font-semibold text-white">{busy ? "Saving…" : "Save"}</Text>
      </Pressable>
    </View>
  );
}
