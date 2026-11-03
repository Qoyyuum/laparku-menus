import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { apiFetch, type FoodItem, type SearchResult, type Venue } from "../api";
import { FilterBar, type FilterKey, type Filters } from "../components/FilterBar";
import { ItemCard } from "../components/ItemCard";
import { SearchBar } from "../components/SearchBar";
import { VenueCard } from "../components/VenueCard";

function toQuery(q: string, filters: Filters): string {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export default function SearchScreen() {
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Filters>({});
  const [result, setResult] = useState<SearchResult>({ venues: [], items: [] });
  const [venueMap, setVenueMap] = useState<Map<string, Venue>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // One-time venue directory fetch so item cards can show venue name/area/halal
  // even when the venue itself didn't match the query text.
  useEffect(() => {
    apiFetch<{ venues: Venue[] }>("/venues")
      .then((r) => setVenueMap(new Map(r.venues.map((v) => [v.id, v]))))
      .catch(() => {});
  }, []);

  // Debounced search.
  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => {
      apiFetch<SearchResult>(`/search${toQuery(q, filters)}`)
        .then((r) => {
          setResult(r);
          setError(null);
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q, filters]);

  const items = useMemo(() => result.items, [result]);
  const venues = useMemo(() => result.venues, [result]);

  return (
    <ScrollView className="flex-1 bg-neutral-50" contentContainerClassName="gap-4 p-4">
      <SearchBar value={q} onChange={setQ} />
      <FilterBar
        filters={filters}
        onChange={(key: FilterKey, value) => setFilters((f) => ({ ...f, [key]: value }))}
      />

      {loading ? <ActivityIndicator color="#047857" /> : null}
      {error ? <Text className="text-sm text-red-600">{error}</Text> : null}

      {!loading && !error && venues.length + items.length === 0 ? (
        <Text className="py-8 text-center text-neutral-500">No matches. Try a different search or filter.</Text>
      ) : null}

      {items.length > 0 ? (
        <View className="gap-2">
          <Text className="text-xs font-semibold uppercase text-neutral-500">Menu items</Text>
          {items.map((item: FoodItem) => (
            <ItemCard key={item.id} item={item} venue={venueMap.get(item.venue_id)} />
          ))}
        </View>
      ) : null}

      {venues.length > 0 ? (
        <View className="gap-2">
          <Text className="text-xs font-semibold uppercase text-neutral-500">Venues</Text>
          {venues.map((venue) => (
            <VenueCard key={venue.id} venue={venue} />
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}
