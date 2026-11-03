import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { authClient, isReviewer } from "../auth";

// Gate for reviewer screens: shows a magic-link sign-in form when there's no
// session, an access notice when the signed-in user lacks the reviewer/admin
// role, and `children` otherwise.
export function SignInGate({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          <Text className="text-lg font-bold text-neutral-900">Reviewer sign-in</Text>
          {sent ? (
            <Text className="text-sm leading-6 text-neutral-600">
              Check your email — we sent a sign-in link to {email}. Open it on this device to
              continue.
            </Text>
          ) : (
            <>
              <TextInput
                className="rounded-lg border border-neutral-300 px-3 py-2 text-base"
                placeholder="you@example.com"
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                value={email}
                onChangeText={setEmail}
              />
              {error ? <Text className="text-sm text-red-600">{error}</Text> : null}
              <Pressable
                className="items-center rounded-lg bg-emerald-700 px-4 py-2.5 disabled:opacity-50"
                disabled={busy || !email.trim()}
                onPress={async () => {
                  setBusy(true);
                  setError(null);
                  const { error: err } = await authClient.signIn.magicLink({
                    email: email.trim(),
                    callbackURL: "/admin",
                  });
                  setBusy(false);
                  if (err) setError(err.message ?? "sign-in failed");
                  else setSent(true);
                }}
              >
                <Text className="text-base font-semibold text-white">
                  {busy ? "Sending…" : "Email me a sign-in link"}
                </Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    );
  }

  if (!isReviewer(session.user as { role?: string | null })) {
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
