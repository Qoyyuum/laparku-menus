import { ActivityIndicator, View } from "react-native";
import { Redirect } from "expo-router";
import { authClient } from "../auth";
import { MagicLinkForm } from "../components/MagicLinkForm";

export default function SignInScreen() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return (
      <View className="flex-1 items-center justify-center bg-neutral-50 dark:bg-neutral-900">
        <ActivityIndicator color="#047857" />
      </View>
    );
  }
  if (session) return <Redirect href="/profile" />;

  return (
    <View className="flex-1 justify-center bg-neutral-50 dark:bg-neutral-900 p-4">
      <View className="mx-auto w-full max-w-sm gap-3 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-4">
        <MagicLinkForm
          title="Sign in to laparku"
          subtitle="One magic-link sign-in — submit menus, earn credit and badges, climb the boards."
          callbackURL="/"
        />
      </View>
    </View>
  );
}
