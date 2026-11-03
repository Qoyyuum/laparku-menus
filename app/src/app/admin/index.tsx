import { Link, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { type QueueSubmission } from "../../api";
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

function Queue() {
  const [subs, setSubs] = useState<QueueSubmission[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await adminFetch<{ submissions: QueueSubmission[] }>(
        "/admin/submissions?status=pending_review",
      );
      setSubs(res.submissions);
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

  return (
    <FlatList
      className="flex-1 bg-neutral-50"
      contentContainerClassName="gap-2 p-4"
      data={subs ?? []}
      keyExtractor={(s) => s.id}
      renderItem={({ item }) => <QueueRow sub={item} />}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
      ListHeaderComponent={
        <Text className="text-xl font-bold text-neutral-900">Review queue</Text>
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
  );
}

export default function AdminQueueScreen() {
  return (
    <SignInGate>
      <Queue />
    </SignInGate>
  );
}
