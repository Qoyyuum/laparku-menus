import "../global.css";

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function RootLayout() {
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#047857" },
          headerTintColor: "#fff",
          headerTitle: "Laparku Menus",
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="search" options={{ title: "Search" }} />
        <Stack.Screen name="venue/[id]" options={{ title: "Venue" }} />
        <Stack.Screen name="about" options={{ title: "About" }} />
        <Stack.Screen name="leaderboard" options={{ title: "Leaderboards" }} />
        <Stack.Screen name="profile" options={{ title: "Your profile" }} />
        <Stack.Screen name="coverage" options={{ title: "Coverage" }} />
        <Stack.Screen name="submit" options={{ title: "Submit a menu" }} />
        <Stack.Screen name="signin" options={{ title: "Sign in" }} />
        <Stack.Screen name="admin/index" options={{ title: "Review queue" }} />
        <Stack.Screen name="admin/review/[id]" options={{ title: "Review submission" }} />
      </Stack>
    </>
  );
}
