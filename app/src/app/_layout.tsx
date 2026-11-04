import "../global.css";

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { HeaderTitle } from "../components/HeaderTitle";
import { navColors, ThemeProvider, useTheme } from "../theme";

// Chrome colors follow the resolved theme; the provider hydrates the pref
// from cache → server (see ../theme.tsx).
function ThemedShell() {
  const { scheme } = useTheme();
  const colors = navColors(scheme);
  return (
    <>
      <StatusBar style={colors.statusBar} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.headerBg },
          headerTintColor: colors.headerText,
          // Tappable wordmark → home (cancels data entry).
          headerTitle: () => <HeaderTitle />,
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

export default function RootLayout() {
  return (
    <ThemeProvider>
      <ThemedShell />
    </ThemeProvider>
  );
}
