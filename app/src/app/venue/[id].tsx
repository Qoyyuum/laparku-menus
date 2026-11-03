import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { apiFetch, type FoodItem } from "../../api";
import { HalalBadge } from "../../components/HalalBadge";
import { ItemCard } from "../../components/ItemCard";

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

  return (
    <ScrollView className="flex-1 bg-neutral-50" contentContainerClassName="gap-4 p-4">
      <Stack.Screen options={{ title: params.name ?? "Venue" }} />

      <View className="gap-1.5">
        <Text className="text-xl font-bold text-neutral-900">{params.name ?? "Venue"}</Text>
        <View className="flex-row items-center gap-2">
          <Text className="text-sm text-neutral-600">
            {[params.type, params.area].filter(Boolean).join(" · ") || "—"}
          </Text>
          {params.halal_status ? <HalalBadge status={params.halal_status} /> : null}
        </View>
        {params.verification && params.verification !== "unverified" ? (
          <Text className="text-xs font-medium text-sky-700">✓ {params.verification}</Text>
        ) : null}
      </View>

      {loading ? <ActivityIndicator color="#047857" /> : null}
      {error ? <Text className="text-sm text-red-600">{error}</Text> : null}
      {!loading && !error && items.length === 0 ? (
        <Text className="py-8 text-center text-neutral-500">No published items yet.</Text>
      ) : null}

      <View className="gap-2">
        {items.map((item) => (
          <ItemCard key={item.id} item={item} />
        ))}
      </View>
    </ScrollView>
  );
}
