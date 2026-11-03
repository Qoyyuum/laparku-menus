import { Link } from "expo-router";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";

function ExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <Pressable onPress={() => Linking.openURL(href)} className="rounded-lg bg-emerald-700 px-4 py-3 active:bg-emerald-800">
      <Text className="text-center font-semibold text-white">{label}</Text>
    </Pressable>
  );
}

export default function AboutScreen() {
  return (
    <ScrollView className="flex-1 bg-neutral-50" contentContainerClassName="gap-4 p-4">
      <Text className="text-xl font-bold text-neutral-900">Laparku Menus</Text>
      <Text className="text-sm leading-6 text-neutral-700">
        Crowdsourced food menus and nutrition estimates for Brunei — dishes at restaurants and
        stalls, plus packaged products in grocers and supermarkets. Data is submitted by the
        community and may contain machine-generated estimates; always verify halal status and
        nutrition with the venue or packaging.
      </Text>

      <View className="gap-2">
        <ExternalLink href="https://github.com/Qoyyuum/laparku-menus" label="Source code on GitHub" />
        <ExternalLink href="https://buymeacoffee.com/qoyyuum" label="Buy me a coffee" />
      </View>

      <View className="mt-2 gap-2">
        <Link href="/submit" className="text-sm font-medium text-emerald-700">
          Submit a menu or product →
        </Link>
        <Link href="/admin" className="text-sm font-medium text-neutral-500">
          Admin →
        </Link>
      </View>
    </ScrollView>
  );
}
