import { Link } from "expo-router";
import { Text, View } from "react-native";

export default function NotFound() {
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-neutral-50 dark:bg-neutral-900 p-4">
      <Text className="text-lg font-bold text-neutral-900 dark:text-neutral-100">Page not found</Text>
      <Text className="text-center text-sm text-neutral-600 dark:text-neutral-300">
        That page doesn't exist in laparku.
      </Text>
      <Link href="/" className="rounded-lg bg-emerald-700 px-4 py-2.5 text-base font-semibold text-white">
        Back to search
      </Link>
    </View>
  );
}
