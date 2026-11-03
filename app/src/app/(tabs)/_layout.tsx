import Ionicons from "@expo/vector-icons/Ionicons";
import { Link, Tabs } from "expo-router";
import { Text } from "react-native";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: "#047857" },
        headerTintColor: "#fff",
        headerTitle: "Laparku Menus",
        tabBarActiveTintColor: "#047857",
        headerRight: () => (
          <Link href="/about">
            <Text className="px-4 text-base font-medium text-white">About</Text>
          </Link>
        ),
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
        name="venues"
        options={{
          title: "Venues",
          tabBarIcon: ({ color, size }) => <Ionicons name="restaurant" color={color as string} size={size} />,
        }}
      />
    </Tabs>
  );
}
