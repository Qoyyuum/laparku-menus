import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import type { Badge, MeProfile } from "../api";
import { adminFetch, authClient } from "../auth";
import { SignInGate } from "../components/SignInGate";

// Personal contributor profile (Task 7): the signed-in user's own counts
// from GET /api/me plus the opt-in editor for display_name /
// show_on_leaderboard / show_credit (PATCH /api/me — Task 5's write
// surface). Both calls ride the session cookie via adminFetch — the helper
// just attaches auth, it isn't admin-only despite the name.
export default function ProfileScreen() {
  return (
    <SignInGate title="Sign in to see your profile" callbackURL="/profile" requireReviewer={false}>
      <ProfileBody />
    </SignInGate>
  );
}

const STAT_FIELDS: { key: keyof Pick<MeProfile, "submissions" | "approved" | "checkins" | "verifications">; label: string }[] = [
  { key: "submissions", label: "Submissions" },
  { key: "approved", label: "Approved" },
  { key: "checkins", label: "Check-ins" },
  { key: "verifications", label: "Verifications" },
];

function ProfileBody() {
  const { data: session } = authClient.useSession();
  const [me, setMe] = useState<MeProfile | null>(null);
  const [badges, setBadges] = useState<Badge[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [showBoard, setShowBoard] = useState(false);
  const [showCredit, setShowCredit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    adminFetch<MeProfile>("/me")
      .then((m) => {
        if (cancelled) return;
        setMe(m);
        // Prefill the opt-in editor with the stored values — the same
        // fields PATCH /api/me writes.
        setName(m.display_name ?? "");
        setShowBoard(m.show_on_leaderboard);
        setShowCredit(m.show_credit);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    // Every badge with progress — powers the earned grid + progress bars.
    adminFetch<{ badges: Badge[] }>("/me/badges")
      .then((r) => !cancelled && setBadges(r.badges))
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
      // PATCH /api/me returns just the stored prefs (see leaderboards.ts).
      const updated = await adminFetch<Pick<MeProfile, "display_name" | "show_on_leaderboard" | "show_credit">>("/me", {
        method: "PATCH",
        body: JSON.stringify({
          display_name: name.trim() || null,
          show_on_leaderboard: showBoard,
          show_credit: showCredit,
        }),
      });
      setMe((prev) => (prev ? { ...prev, ...updated } : prev));
      setMessage("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView className="flex-1 bg-neutral-50" contentContainerClassName="gap-4 p-4">
      <View className="gap-1">
        <Text className="text-xl font-bold text-neutral-900">Your profile</Text>
        <Text className="text-sm text-neutral-600">{session?.user?.email}</Text>
      </View>

      {loading ? <ActivityIndicator color="#047857" /> : null}
      {error ? <Text className="text-sm text-red-600">{error}</Text> : null}

      {me ? (
        <View className="flex-row flex-wrap gap-2">
          {STAT_FIELDS.map((f) => (
            <View
              key={f.key}
              className="min-w-[45%] flex-1 items-center gap-1 rounded-xl border border-neutral-200 bg-white p-4"
            >
              <Text className="text-2xl font-bold text-emerald-700">{me[f.key]}</Text>
              <Text className="text-xs font-medium text-neutral-600">{f.label}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {badges ? <BadgeCase badges={badges} /> : null}

      <View className="gap-2 rounded-xl border border-neutral-200 bg-white p-4">
        <Text className="text-base font-bold text-neutral-900">Display settings</Text>
        <Text className="text-sm leading-6 text-neutral-600">
          Leaderboards and item credit show “Anonymous” unless you opt in with a display name.
        </Text>
        <TextInput
          className="rounded-lg border border-neutral-300 px-3 py-2 text-base"
          placeholder="Display name (e.g. Menu Hunter)"
          maxLength={80}
          value={name}
          onChangeText={setName}
        />
        <View className="flex-row items-center gap-2">
          <Switch value={showBoard} onValueChange={setShowBoard} />
          <Text className="flex-1 text-sm text-neutral-800">Show my name on leaderboards</Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Switch value={showCredit} onValueChange={setShowCredit} />
          <Text className="flex-1 text-sm text-neutral-800">Credit me on items I contributed</Text>
        </View>
        {message ? <Text className="text-sm font-medium text-emerald-700">{message}</Text> : null}
        <Pressable
          className="items-center rounded-lg bg-emerald-700 px-4 py-2.5 disabled:opacity-50"
          disabled={busy || (showBoard && name.trim() === "")}
          onPress={save}
        >
          <Text className="text-base font-semibold text-white">{busy ? "Saving…" : "Save"}</Text>
        </Pressable>
      </View>

      <Pressable
        className="items-center rounded-lg border border-neutral-300 px-4 py-2.5"
        onPress={() => authClient.signOut()}
      >
        <Text className="text-base font-medium text-neutral-800">Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

// Badge case (Task 8): earned badges as a grid of chips, then the unearned
// ones with a progress bar each ("23/50 check-ins") so there's always a
// next goal in view. Data comes from GET /api/me/badges — computed
// server-side, progress included.
function BadgeCase({ badges }: { badges: Badge[] }) {
  const earned = badges.filter((b) => b.earned);
  const pending = badges.filter((b) => !b.earned);
  return (
    <View className="gap-3 rounded-xl border border-neutral-200 bg-white p-4">
      <Text className="text-base font-bold text-neutral-900">Badges</Text>
      {earned.length === 0 ? (
        <Text className="text-sm text-neutral-600">No badges yet — your first submission earns one.</Text>
      ) : (
        <View className="flex-row flex-wrap gap-2">
          {earned.map((b) => (
            <View key={b.key} className="rounded-full border border-amber-500 bg-amber-50 px-3 py-1.5">
              <Text className="text-sm font-semibold text-amber-800">{b.name}</Text>
            </View>
          ))}
        </View>
      )}
      {pending.length > 0 ? (
        <View className="gap-2.5">
          {pending.map((b) => {
            const pct = Math.min(100, Math.round((b.progress / Math.max(b.target, 1)) * 100));
            return (
              <View key={b.key} className="gap-1">
                <View className="flex-row items-baseline gap-2">
                  <Text className="flex-1 text-sm font-medium text-neutral-800" numberOfLines={1}>
                    {b.name}
                  </Text>
                  <Text className="text-xs text-neutral-500">
                    {b.progress}/{b.target}
                  </Text>
                </View>
                <View className="h-2 overflow-hidden rounded-full bg-neutral-200">
                  {/* Percentage widths aren't expressible as static
                      nativewind classes — the fill gets an inline style. */}
                  <View className="h-2 rounded-full bg-emerald-600" style={{ width: `${pct}%` }} />
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
