import Ionicons from "@expo/vector-icons/Ionicons";
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { apiFetch, type CoverageArea } from "../api";

// Compact contribution nudge on the search screen: rolls GET /api/coverage
// up into a single "menus still needed" count and gives a one-tap path to
// /submit. Hidden when the fetch fails or there's nothing left to do — the
// banner should never nag on an empty map.
export function ContributeBanner() {
  const [gaps, setGaps] = useState<{ stubs: number; missions: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ areas: CoverageArea[] }>("/coverage")
      .then((r) => {
        if (cancelled) return;
        const stubs = r.areas.reduce((n, a) => n + a.stubs, 0);
        const missions = r.areas.reduce((n, a) => n + a.open_requests, 0);
        setGaps({ stubs, missions });
      })
      .catch(() => {
        // Silently hide — search results matter more than the nudge.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const total = (gaps?.stubs ?? 0) + (gaps?.missions ?? 0);
  if (!gaps || total === 0) return null;

  return (
    <View className="gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
      <View className="gap-1">
        <Text className="text-base font-bold text-emerald-900">
          {total} menu{total === 1 ? "" : "s"} still needed
        </Text>
        <Text className="text-sm leading-5 text-emerald-800">
          {gaps.missions > 0
            ? `${gaps.missions} open mission${gaps.missions === 1 ? "" : "s"} · `
            : ""}
          Snap a menu and help fill the map — submissions earn credit and badges.
        </Text>
      </View>
      <View className="flex-row gap-2">
        <Link href="/submit" asChild>
          <Pressable className="flex-row items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2.5">
            <Ionicons name="add" color="#fff" size={16} />
            <Text className="text-sm font-semibold text-white">Submit a menu</Text>
          </Pressable>
        </Link>
        <Link href="/coverage" asChild>
          <Pressable className="flex-row items-center gap-1.5 rounded-lg border border-emerald-700 bg-white dark:bg-neutral-800 px-4 py-2.5">
            <Ionicons name="map" color="#047857" size={16} />
            <Text className="text-sm font-semibold text-emerald-700">See coverage</Text>
          </Pressable>
        </Link>
      </View>
    </View>
  );
}
