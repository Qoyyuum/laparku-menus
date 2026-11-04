import Ionicons from "@expo/vector-icons/Ionicons";
import { Link, Tabs } from "expo-router";
import { Text, View } from "react-native";
import { authClient } from "../../auth";

// Header links with a session-aware entry point: signed-out visitors see
// "Sign in" (→ /profile, whose gate prompts the magic-link flow); once the
// session resolves it flips to "Profile".
function HeaderLinks() {
  const { data: session } = authClient.useSession();
  return (
    <View className="flex-row">
      <Link href="/coverage">
        <Text className="px-4 text-base font-medium text-white">Coverage</Text>
      </Link>
      <Link href="/leaderboard">
        <Text className="px-4 text-base font-medium text-white">Boards</Text>
      </Link>
      <Link href="/profile">
        <Text className="px-4 text-base font-medium text-white">
          {session ? "Profile" : "Sign in"}
        </Text>
      </Link>
      <Link href="/about">
        <Text className="px-4 text-base font-medium text-white">About</Text>
      </Link>
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: "#047857" },
        headerTintColor: "#fff",
        headerTitle: "Laparku Menus",
        tabBarActiveTintColor: "#047857",
        headerRight: () => <HeaderLinks />,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Search",
          tabBarIcon: ({ color, size }) => <Ionicons name="search" color={color as string} size={size} />,
        }}
      />
      <Tabs.Screen
        name="contribute"
        options={{
          title: "Contribute",
          // href makes the tab button a Link to /submit — the primary CTA.
          // Center slot + oversized icon keeps it the most prominent tab.
          href: "/submit",
          tabBarIcon: ({ color }) => (
            <Ionicons name="add-circle" color={color as string} size={30} />
          ),
        }}
      />
      <Tabs.Screen
        name="venues"
        options={{
          title: "Venues",
          tabBarIcon: ({ color, size }) => <Ionicons name="restaurant" color={color as string} size={size} />,
        }}
      />
    </Tabs>
  );
}
