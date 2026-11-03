import { ScrollView, Text } from "react-native";

export default function SubmitScreen() {
  return (
    <ScrollView className="flex-1 bg-neutral-50" contentContainerClassName="gap-4 p-4">
      <Text className="text-xl font-bold text-neutral-900">Submit a menu</Text>
      <Text className="text-sm leading-6 text-neutral-600">
        Coming soon — photo and PDF menu submissions with automatic extraction are on the
        roadmap.
      </Text>
    </ScrollView>
  );
}
