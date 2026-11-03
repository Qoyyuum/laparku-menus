import { ScrollView, Text } from "react-native";

export default function AdminScreen() {
  return (
    <ScrollView className="flex-1 bg-neutral-50" contentContainerClassName="gap-4 p-4">
      <Text className="text-xl font-bold text-neutral-900">Admin</Text>
      <Text className="text-sm leading-6 text-neutral-600">
        Coming soon — reviewer sign-in and the submission moderation queue will live here.
      </Text>
    </ScrollView>
  );
}
