import Ionicons from "@expo/vector-icons/Ionicons";
import { Link, Tabs, type Href } from "expo-router";
import type { ComponentProps } from "react";
import { Pressable, View } from "react-native";
import { authClient } from "../../auth";
import { HeaderTitle } from "../../components/HeaderTitle";
import { navColors, useTheme } from "../../theme";

type IoniconName = ComponentProps<typeof Ionicons>["name"];

// Icon-only header button — navigation chrome stays language-neutral so the
// UI doesn't need translated labels to be navigable. The accessibilityLabel
// keeps the destination readable for screen readers.
function HeaderIconLink({
  href,
  icon,
  label,
  color,
}: {
  href: Href;
  icon: IoniconName;
  label: string;
  color: string;
}) {
  return (
    <Link href={href} asChild>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        className="px-2.5 py-1"
        hitSlop={8}
      >
        <Ionicons name={icon} color={color} size={22} />
      </Pressable>
    </Link>
  );
}

// Header links with a session-aware entry point: signed-out visitors get a
// log-in icon (→ /profile, whose gate prompts the magic-link flow); once the
// session resolves it flips to the profile icon.
function HeaderLinks() {
  const { data: session } = authClient.useSession();
  const { scheme } = useTheme();
  const color = navColors(scheme).headerText;
  return (
    <View className="flex-row items-center">
      <HeaderIconLink href="/coverage" icon="map" label="Coverage" color={color} />
      <HeaderIconLink href="/leaderboard" icon="trophy" label="Leaderboards" color={color} />
      <HeaderIconLink
        href={session ? "/profile" : "/signin"}
        icon={session ? "person-circle" : "log-in"}
        label={session ? "Profile" : "Sign in"}
        color={color}
      />
      <HeaderIconLink href="/about" icon="information-circle" label="About" color={color} />
    </View>
  );
}

export default function TabsLayout() {
  const { scheme } = useTheme();
  const colors = navColors(scheme);
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.headerBg },
        headerTintColor: colors.headerText,
        // Tappable wordmark → home.
        headerTitle: () => <HeaderTitle />,
        tabBarActiveTintColor: colors.activeTint,
        tabBarInactiveTintColor: colors.inactiveTint,
        tabBarStyle: { backgroundColor: colors.tabBg, borderTopColor: colors.tabBorder },
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
