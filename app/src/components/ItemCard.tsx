import { Text, View } from "react-native";
import { formatBnd, type FoodItem, type Venue } from "../api";
import { HalalBadge } from "./HalalBadge";

interface Props {
  item: FoodItem;
  // Venue the item belongs to, when known (enriches search results).
  venue?: Venue;
}

export function ItemCard({ item, venue }: Props) {
  const n = item.nutrition_estimate;
  return (
    <View className="gap-1.5 rounded-xl border border-neutral-200 bg-white p-4">
      <View className="flex-row items-start justify-between gap-2">
        <View className="flex-1">
          <Text className="text-base font-semibold text-neutral-900">{item.name}</Text>
          {item.name_ms ? <Text className="text-sm text-neutral-500">{item.name_ms}</Text> : null}
        </View>
        <Text className="text-base font-bold text-emerald-700">{formatBnd(item.price_bnd)}</Text>
      </View>

      {item.description ? (
        <Text className="text-sm text-neutral-600" numberOfLines={2}>
          {item.description}
        </Text>
      ) : null}

      {venue ? (
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="text-xs text-neutral-500">
            {venue.name} · {venue.area}
          </Text>
          <HalalBadge status={venue.halal_status} />
        </View>
      ) : null}

      {n ? (
        <Text className="text-xs text-neutral-500">
          {n.calories_kcal != null ? `~${Math.round(n.calories_kcal)} kcal` : ""}
          {n.protein_g != null ? ` · P ${n.protein_g}g` : ""}
          {n.carbs_g != null ? ` · C ${n.carbs_g}g` : ""}
          {n.fat_g != null ? ` · F ${n.fat_g}g` : ""}
          {n.status ? ` (${n.status})` : ""}
        </Text>
      ) : null}

      <View className="flex-row flex-wrap items-center gap-1.5">
        {item.category ? (
          <View className="rounded-full bg-neutral-100 px-2 py-0.5">
            <Text className="text-xs text-neutral-600">{item.category}</Text>
          </View>
        ) : null}
        {item.tags.map((tag) => (
          <View key={tag} className="rounded-full bg-amber-100 px-2 py-0.5">
            <Text className="text-xs text-amber-800">{tag}</Text>
          </View>
        ))}
        <View className="rounded-full bg-sky-100 px-2 py-0.5">
          <Text className="text-xs text-sky-800">{item.item_type}</Text>
        </View>
      </View>
    </View>
  );
}
