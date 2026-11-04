import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { authClient } from "../auth";

// Friendly copy for better-auth's ?error= redirects (expired/used links land
// back on the same screen via callbackURL?error=...).
const URL_ERRORS: Record<string, string> = {
  INVALID_TOKEN: "That sign-in link expired or was already used — request a new one below.",
  EXPIRED_TOKEN: "That sign-in link has expired — request a new one below.",
  INVALID_CALLBACK_URL: "That sign-in link was malformed — request a new one below.",
};

// The email → magic-link form shared by the standalone /signin screen and
// SignInGate. Reads the current route's ?error= param so expired or
// already-consumed links explain themselves instead of silently re-prompting.
export function MagicLinkForm({
  title = "Sign in",
  subtitle,
  callbackURL = "/",
}: {
  title?: string;
  subtitle?: string;
  callbackURL?: string;
}) {
  const { error: urlError } = useLocalSearchParams<{ error?: string }>();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const notice = urlError
    ? (URL_ERRORS[urlError] ?? "Sign-in failed — request a new link below.")
    : null;

  return (
    <>
      <Text className="text-lg font-bold text-neutral-900 dark:text-neutral-100">{title}</Text>
      {subtitle && !sent ? (
        <Text className="text-sm leading-5 text-neutral-600 dark:text-neutral-300">{subtitle}</Text>
      ) : null}
      {notice ? <Text className="text-sm leading-5 text-amber-700">{notice}</Text> : null}
      {sent ? (
        <Text className="text-sm leading-6 text-neutral-600 dark:text-neutral-300">
          Check your email — we sent a sign-in link to {email}. Open it on this device to
          continue.
        </Text>
      ) : (
        <>
          <TextInput
            className="rounded-lg border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-base"
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
                callbackURL,
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
    </>
  );
}
