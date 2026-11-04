import { Link } from "expo-router";
import { Pressable, Text, View } from "react-native";
import type { Venue } from "../api";
import { HalalBadge } from "./HalalBadge";

// Venue summary card; taps through to the venue detail screen. Venue fields are
// forwarded as route params so the detail screen can render a header without a
// dedicated `GET /api/venues/:id` endpoint.
export function VenueCard({ venue }: { venue: Venue }) {
  return (
    <Link
      href={{
        pathname: "/venue/[id]",
        params: {
          id: venue.id,
          name: venue.name,
          type: venue.type,
          area: venue.area,
          halal_status: venue.halal_status,
          verification: venue.verification,
          freshness: venue.freshness,
          is_stub: venue.is_stub ? "true" : undefined,
        },
      }}
      asChild
    >
      <Pressable className="gap-1.5 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-4 active:bg-neutral-50 dark:bg-neutral-900">
        <View className="flex-row items-start justify-between gap-2">
          <Text className="flex-1 text-base font-semibold text-neutral-900 dark:text-neutral-100">{venue.name}</Text>
          <HalalBadge status={venue.halal_status} />
        </View>
        <Text className="text-sm text-neutral-600 dark:text-neutral-300">
          {venue.type} · {venue.area}
        </Text>
        {venue.is_stub ? <Text className="text-xs font-semibold text-amber-700">⚑ Menu needed</Text> : null}
        {venue.verification !== "unverified" ? (
          <Text className="text-xs font-medium text-sky-700">✓ {venue.verification}</Text>
        ) : null}
      </Pressable>
    </Link>
  );
}
