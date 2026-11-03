import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { apiFetch, type Venue } from "../../api";
import { FilterBar, type FilterKey, type Filters } from "../../components/FilterBar";
import { SearchBar } from "../../components/SearchBar";
import { VenueCard } from "../../components/VenueCard";

function toQuery(q: string, filters: Filters): string {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (filters.venue_type) params.set("type", filters.venue_type);
  if (filters.area) params.set("area", filters.area);
  if (filters.halal) params.set("halal", filters.halal);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export default function VenuesScreen() {
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Filters>({});
  const [venues, setVenues] = useState<Venue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => {
      apiFetch<{ venues: Venue[] }>(`/venues${toQuery(q, filters)}`)
        .then((r) => {
          setVenues(r.venues);
          setError(null);
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q, filters]);

  return (
    <ScrollView className="flex-1 bg-neutral-50" contentContainerClassName="gap-4 p-4">
      <SearchBar value={q} onChange={setQ} placeholder="Search venues…" />
      <FilterBar
        filters={filters}
        onChange={(key: FilterKey, value) => setFilters((f) => ({ ...f, [key]: value }))}
        groups={["area", "venue_type", "halal"]}
      />
      {loading ? <ActivityIndicator color="#047857" /> : null}
      {error ? <Text className="text-sm text-red-600">{error}</Text> : null}
      {!loading && !error && venues.length === 0 ? (
        <Text className="py-8 text-center text-neutral-500">No venues match.</Text>
      ) : null}
      <View className="gap-2">
        {venues.map((venue) => (
          <VenueCard key={venue.id} venue={venue} />
        ))}
      </View>
    </ScrollView>
  );
}
