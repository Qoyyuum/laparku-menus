import { Text, View } from "react-native";

const STYLES: Record<string, { bg: string; text: string }> = {
  "halal-certified": { bg: "bg-emerald-100", text: "text-emerald-800" },
  "muslim-owned": { bg: "bg-teal-100", text: "text-teal-800" },
  "non-halal": { bg: "bg-red-100", text: "text-red-800" },
  unknown: { bg: "bg-neutral-200", text: "text-neutral-600" },
  "n-a": { bg: "bg-neutral-100", text: "text-neutral-500" },
};

export function HalalBadge({ status }: { status: string }) {
  const style = STYLES[status] ?? STYLES["unknown"]!;
  return (
    <View className={`self-start rounded-full px-2 py-0.5 ${style.bg}`}>
      <Text className={`text-xs font-medium ${style.text}`}>{status}</Text>
    </View>
  );
}
