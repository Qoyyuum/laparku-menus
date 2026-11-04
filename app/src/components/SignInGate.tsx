import { type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { authClient, isReviewer } from "../auth";
import { MagicLinkForm } from "./MagicLinkForm";

// Gate for authenticated screens: shows a magic-link sign-in form when
// there's no session, an access notice when the signed-in user lacks the
// reviewer/admin role (only when `requireReviewer` — plain submitters are
// enough for e.g. the submit screen), and `children` otherwise.
export function SignInGate({
  children,
  title = "Reviewer sign-in",
  subtitle,
  callbackURL = "/admin",
  requireReviewer = true,
}: {
  children: ReactNode;
  title?: string;
  // One-line "why sign in" under the title — e.g. what the account unlocks.
  subtitle?: string;
  callbackURL?: string;
  requireReviewer?: boolean;
}) {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return (
      <View className="flex-1 items-center justify-center bg-neutral-50 p-4">
        <ActivityIndicator color="#047857" />
      </View>
    );
  }

  if (!session) {
    return (
      <View className="flex-1 justify-center bg-neutral-50 p-4">
        <View className="mx-auto w-full max-w-sm gap-3 rounded-xl border border-neutral-200 bg-white p-4">
          <MagicLinkForm title={title} subtitle={subtitle} callbackURL={callbackURL} />
        </View>
      </View>
    );
  }

  if (requireReviewer && !isReviewer(session.user as { role?: string | null })) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-neutral-50 p-4">
        <Text className="text-center text-base text-neutral-700">
          Signed in as {session.user.email} — this account does not have reviewer access.
        </Text>
        <Pressable
          className="rounded-lg border border-neutral-300 px-4 py-2"
          onPress={() => authClient.signOut()}
        >
          <Text className="text-base font-medium text-neutral-800">Sign out</Text>
        </Pressable>
      </View>
    );
  }

  return <>{children}</>;
}
