// The "Laparku Menus" header title — tappable, navigates to / (the search
// home tab). Wired as headerTitle in both the root Stack and the tab
// navigator so tapping the wordmark cancels whatever data-entry flow the
// user was in by taking them home.
import { Link } from "expo-router";
import { Pressable, Text } from "react-native";

export function HeaderTitle() {
  return (
    <Link href="/" asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Laparku Menus — back to home"
        hitSlop={8}
      >
        <Text className="text-lg font-semibold text-white">Laparku Menus</Text>
      </Pressable>
    </Link>
  );
}
