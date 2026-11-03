import { Pressable, ScrollView, Text, View } from "react-native";
import { AREAS, HALAL_STATUSES, ITEM_TYPES, VENUE_TYPES } from "../api";

export type FilterKey = "venue_type" | "item_type" | "area" | "halal";
export type Filters = Partial<Record<FilterKey, string>>;

interface Group {
  key: FilterKey;
  label: string;
  options: readonly string[];
}

const GROUPS: Group[] = [
  { key: "area", label: "Area", options: AREAS },
  { key: "venue_type", label: "Venue", options: VENUE_TYPES },
  { key: "item_type", label: "Item", options: ITEM_TYPES },
  { key: "halal", label: "Halal", options: HALAL_STATUSES },
];

interface Props {
  filters: Filters;
  onChange: (key: FilterKey, value: string | undefined) => void;
  // Restrict which chip groups render (e.g. the venues screen has no item_type).
  groups?: FilterKey[];
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className={`rounded-full border px-3 py-1.5 ${
        active ? "border-emerald-700 bg-emerald-700" : "border-neutral-300 bg-white"
      }`}
    >
      <Text className={`text-xs font-medium ${active ? "text-white" : "text-neutral-700"}`}>{label}</Text>
    </Pressable>
  );
}

// Horizontally scrolling filter chips. Tapping an active chip clears it.
export function FilterBar({ filters, onChange, groups }: Props) {
  const visible = groups ? GROUPS.filter((g) => groups.includes(g.key)) : GROUPS;
  return (
    <View className="gap-2">
      {visible.map((group) => (
        <View key={group.key} className="flex-row items-center gap-2">
          <Text className="w-12 text-xs font-semibold uppercase text-neutral-500">{group.label}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
            {group.options.map((opt) => (
              <Chip
                key={opt}
                label={opt}
                active={filters[group.key] === opt}
                onPress={() => onChange(group.key, filters[group.key] === opt ? undefined : opt)}
              />
            ))}
          </ScrollView>
        </View>
      ))}
    </View>
  );
}
