import { Link, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { type ItemFlag, type PendingVerificationItem, type QueueSubmission } from "../../api";
import { AdminApiError, adminFetch } from "../../auth";
import { SignInGate } from "../../components/SignInGate";

const FLAG_LABELS: Record<string, string> = {
  generator_signature: "generator signature",
  venue_unverified: "venue unverified",
  price_outlier: "price outlier",
  extractor_suspicion: "extractor suspicion",
  phash_dup: "phash duplicate",
  dup_sha256: "exact duplicate",
  no_food_content: "no food content",
  low_confidence: "low confidence",
};

function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  if (confidence == null) return null;
  const pct = Math.round(confidence * 100);
  const color = confidence >= 0.8 ? "text-emerald-700" : confidence >= 0.5 ? "text-amber-700" : "text-red-700";
  return <Text className={`text-xs font-semibold ${color}`}>{pct}% conf</Text>;
}

function QueueRow({ sub }: { sub: QueueSubmission }) {
  const guess = sub.raw_extraction?.venue_guess;
  const itemCount = sub.raw_extraction?.items?.length ?? 0;
  return (
    <Link href={`/admin/review/${sub.id}`} asChild>
      <Pressable className="gap-1.5 rounded-xl border border-neutral-200 bg-white p-3 active:bg-neutral-50">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="flex-1 text-base font-semibold text-neutral-900" numberOfLines={1}>
            {guess?.name ?? "Unknown venue"}
          </Text>
          <ConfidenceBadge confidence={sub.confidence} />
        </View>
        <Text className="text-xs text-neutral-600">
          {sub.source_type} · {itemCount} item{itemCount === 1 ? "" : "s"} ·{" "}
          {new Date(sub.created_at).toLocaleDateString()} ·{" "}
          {sub.submitter_trust_tier ?? "anonymous"}
        </Text>
        {sub.auto_flags.length > 0 ? (
          <View className="flex-row flex-wrap gap-1">
            {sub.auto_flags.map((flag) => (
              <View key={flag} className="rounded-full bg-amber-100 px-2 py-0.5">
                <Text className="text-xs font-medium text-amber-800">
                  {FLAG_LABELS[flag] ?? flag}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </Pressable>
    </Link>
  );
}

function FlagRow({ flag, onResolve }: { flag: ItemFlag; onResolve: (id: string) => void }) {
  const [resolving, setResolving] = useState(false);
  return (
    <View className="gap-1.5 rounded-xl border border-red-200 bg-red-50 p-3">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-base font-semibold text-neutral-900" numberOfLines={1}>
          {flag.item_name}
        </Text>
        <Pressable
          disabled={resolving}
          onPress={async () => {
            setResolving(true);
            try {
              await adminFetch(`/admin/flags/${flag.id}/resolve`, { method: "POST" });
              onResolve(flag.id);
            } finally {
              setResolving(false);
            }
          }}
          className="rounded-full bg-emerald-700 px-3 py-1 active:bg-emerald-800"
        >
          <Text className="text-xs font-semibold text-white">
            {resolving ? "Resolving…" : "Resolve"}
          </Text>
        </Pressable>
      </View>
      <Text className="text-xs text-neutral-600">{flag.venue_name}</Text>
      <Text className="text-sm text-neutral-800">{flag.reason}</Text>
      {flag.reporter_contact ? (
        <Text className="text-xs text-neutral-500">reporter: {flag.reporter_contact}</Text>
      ) : null}
    </View>
  );
}

// One trusted-published item in the double-check queue: the live item vs
// the lookup payload that prefilled it, with submitter overrides called
// out. Verify clears the badge; Unpublish hides the item and rejects its
// source submission (server-side).
function PendingRow({ item, onDone }: { item: PendingVerificationItem; onDone: (id: string) => void }) {
  const [busy, setBusy] = useState<"verify" | "unpublish" | null>(null);
  const act = async (action: "verify" | "unpublish") => {
    setBusy(action);
    try {
      await adminFetch(`/admin/items/${item.id}/${action}`, { method: "POST", body: "{}" });
      onDone(item.id);
    } finally {
      setBusy(null);
    }
  };
  const providers = [...new Set(item.lookup.flatMap((l) => l.sources.map((s) => s.provider)))];
  const overrideEntries = Object.entries(item.overrides);
  return (
    <View className="gap-1.5 rounded-xl border border-amber-200 bg-amber-50 p-3">
      <Text className="text-base font-semibold text-neutral-900" numberOfLines={1}>
        {item.name}
      </Text>
      <Text className="text-xs text-neutral-600">
        {item.venue_name}
        {[item.brand, item.package_size].filter(Boolean).length > 0
          ? ` · ${[item.brand, item.package_size].filter(Boolean).join(" · ")}`
          : ""}
        {item.barcode ? ` · ${item.barcode}` : ""}
      </Text>
      {providers.length > 0 ? (
        <View className="flex-row flex-wrap gap-1">
          {providers.map((p) => (
            <View key={p} className="rounded-full bg-neutral-200 px-2 py-0.5">
              <Text className="text-xs font-medium text-neutral-700">{p}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {overrideEntries.length > 0 ? (
        <View className="gap-0.5">
          {overrideEntries.map(([field, o]) => (
            <Text key={field} className="text-xs text-neutral-700">
              {field}: {String(o.lookup ?? "—")} →{" "}
              <Text className="font-semibold">{String(o.submitted)}</Text>
            </Text>
          ))}
        </View>
      ) : null}
      <View className="mt-1 flex-row gap-2">
        <Pressable
          disabled={busy !== null}
          onPress={() => act("verify")}
          className="rounded-full bg-emerald-700 px-3 py-1 active:bg-emerald-800"
        >
          <Text className="text-xs font-semibold text-white">{busy === "verify" ? "Verifying…" : "Verify"}</Text>
        </Pressable>
        <Pressable
          disabled={busy !== null}
          onPress={() => act("unpublish")}
          className="rounded-full bg-red-700 px-3 py-1 active:bg-red-800"
        >
          <Text className="text-xs font-semibold text-white">{busy === "unpublish" ? "Unpublishing…" : "Unpublish"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Queue() {
  const [tab, setTab] = useState<"queue" | "pending">("queue");
  const [subs, setSubs] = useState<QueueSubmission[] | null>(null);
  const [flags, setFlags] = useState<ItemFlag[] | null>(null);
  const [pending, setPending] = useState<PendingVerificationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [subsRes, flagsRes, pendingRes] = await Promise.all([
        adminFetch<{ submissions: QueueSubmission[] }>("/admin/submissions?status=pending_review"),
        adminFetch<{ flags: ItemFlag[] }>("/admin/flags?status=open"),
        adminFetch<{ items: PendingVerificationItem[] }>("/admin/pending-verification"),
      ]);
      setSubs(subsRes.submissions);
      setFlags(flagsRes.flags);
      setPending(pendingRes.items);
      setError(null);
    } catch (e) {
      setError(
        e instanceof AdminApiError && e.status === 403
          ? "This account does not have reviewer access."
          : e instanceof Error
            ? e.message
            : "failed to load queue",
      );
    }
  }, []);

  // Refetch whenever the reviewer returns here (e.g. back from a decision).
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
      }}
    />
  );

  return (
    <View className="flex-1 bg-neutral-50">
      {/* Queue switch: normal submissions vs the trusted-publish double-check. */}
      <View className="flex-row gap-2 px-4 pt-4">
        {(
          [
            ["queue", `Review queue${subs ? ` (${subs.length})` : ""}`],
            ["pending", `Pending verification${pending ? ` (${pending.length})` : ""}`],
          ] as const
        ).map(([key, label]) => (
          <Pressable
            key={key}
            onPress={() => setTab(key)}
            className={`rounded-full px-3 py-1.5 ${
              tab === key ? "bg-emerald-700" : "bg-neutral-200 active:bg-neutral-300"
            }`}
          >
            <Text
              className={`text-xs font-semibold ${tab === key ? "text-white" : "text-neutral-700"}`}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
      {tab === "pending" ? (
        <FlatList
          className="flex-1"
          contentContainerClassName="gap-2 p-4"
          data={pending ?? []}
          keyExtractor={(i) => i.id}
          renderItem={({ item }) => (
            <PendingRow
              item={item}
              onDone={(id) => setPending((cur) => cur?.filter((p) => p.id !== id) ?? cur)}
            />
          )}
          refreshControl={refreshControl}
          ListEmptyComponent={
            <View className="items-center gap-2 py-10">
              {pending === null && !error ? <ActivityIndicator color="#047857" /> : null}
              {error ? <Text className="text-center text-sm text-red-600">{error}</Text> : null}
              {pending !== null && !error ? (
                <Text className="text-sm text-neutral-500">
                  Nothing pending verification — every trusted item is checked.
                </Text>
              ) : null}
            </View>
          }
        />
      ) : (
        <FlatList
          className="flex-1"
          contentContainerClassName="gap-2 p-4"
          data={subs ?? []}
          keyExtractor={(s) => s.id}
          renderItem={({ item }) => <QueueRow sub={item} />}
          refreshControl={refreshControl}
          ListHeaderComponent={
            <View className="gap-2">
              {flags && flags.length > 0 ? (
                <View className="gap-2">
                  <Text className="text-xl font-bold text-neutral-900">
                    Flagged items ({flags.length})
                  </Text>
                  {flags.map((flag) => (
                    <FlagRow
                      key={flag.id}
                      flag={flag}
                      onResolve={(id) => setFlags((cur) => cur?.filter((f) => f.id !== id) ?? cur)}
                    />
                  ))}
                </View>
              ) : null}
              <Text className="text-xl font-bold text-neutral-900">Review queue</Text>
            </View>
          }
          ListEmptyComponent={
            <View className="items-center gap-2 py-10">
              {subs === null && !error ? <ActivityIndicator color="#047857" /> : null}
              {error ? <Text className="text-center text-sm text-red-600">{error}</Text> : null}
              {subs !== null && !error ? (
                <Text className="text-sm text-neutral-500">Queue is empty — nothing to review.</Text>
              ) : null}
            </View>
          }
        />
      )}
    </View>
  );
}

export default function AdminQueueScreen() {
  return (
    <SignInGate>
      <Queue />
    </SignInGate>
  );
}
