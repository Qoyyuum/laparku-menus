import Ionicons from "@expo/vector-icons/Ionicons";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
} from "react-native";
import { AUTH_ORIGIN, type Badge, type MeProfile, type ThemePref, type VerifiedAccount } from "../api";
import { adminFetch, authClient } from "../auth";
import { SignInGate } from "../components/SignInGate";
import { useTheme } from "../theme";

// Personal contributor profile: stats, badges, and the opt-in prefs.
// Public identity is NOT freeform — the display_name editor was removed;
// leaderboard naming comes from the user's Gravatar-verified socials
// (managed on gravatar.com), of which one is picked as preferred_social.
export default function ProfileScreen() {
  return (
    <SignInGate title="Sign in to see your profile" callbackURL="/profile" requireReviewer={false}>
      <ProfileBody />
    </SignInGate>
  );
}

const STAT_FIELDS: {
  key: keyof Pick<MeProfile, "submissions" | "approved" | "checkins" | "verifications">;
  label: string;
}[] = [
  { key: "submissions", label: "Submissions" },
  { key: "approved", label: "Approved" },
  { key: "checkins", label: "Check-ins" },
  { key: "verifications", label: "Verifications" },
];

function ProfileBody() {
  const { data: session } = authClient.useSession();
  const [me, setMe] = useState<MeProfile | null>(null);
  const [badges, setBadges] = useState<Badge[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showBoard, setShowBoard] = useState(false);
  const [showCredit, setShowCredit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    adminFetch<MeProfile>("/me")
      .then((m) => {
        if (cancelled) return;
        setMe(m);
        setShowBoard(m.show_on_leaderboard);
        setShowCredit(m.show_credit);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    adminFetch<{ badges: Badge[] }>("/me/badges")
      .then((r) => !cancelled && setBadges(r.badges))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await adminFetch<Pick<MeProfile, "show_on_leaderboard" | "show_credit">>(
        "/me",
        {
          method: "PATCH",
          body: JSON.stringify({
            show_on_leaderboard: showBoard,
            show_credit: showCredit,
          }),
        },
      );
      setMe((prev) => (prev ? { ...prev, ...updated } : prev));
      setMessage("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView className="flex-1 bg-neutral-50 dark:bg-neutral-900" contentContainerClassName="gap-4 p-4">
      <View className="gap-1">
        <Text className="text-xl font-bold text-neutral-900 dark:text-neutral-100">Your profile</Text>
        <Text className="text-sm text-neutral-600 dark:text-neutral-300">{session?.user?.email}</Text>
      </View>

      {loading ? <ActivityIndicator color="#047857" /> : null}
      {error ? <Text className="text-sm text-red-600">{error}</Text> : null}

      {me ? <AvatarCard me={me} onChanged={(url) => setMe((p) => (p ? { ...p, avatar_url: url } : p))} /> : null}

      {me ? (
        <View className="flex-row flex-wrap gap-2">
          {STAT_FIELDS.map((f) => (
            <View
              key={f.key}
              className="min-w-[45%] flex-1 items-center gap-1 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-4"
            >
              <Text className="text-2xl font-bold text-emerald-700">{me[f.key]}</Text>
              <Text className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{f.label}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {badges ? <BadgeCase badges={badges} /> : null}

      {me ? <SocialsCard me={me} onChanged={setMe} /> : null}

      <ThemeCard />

      <View className="gap-2 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-4">
        <Text className="text-base font-bold text-neutral-900 dark:text-neutral-100">Privacy</Text>
        <Text className="text-sm leading-6 text-neutral-600 dark:text-neutral-300">
          Leaderboards and item credit show “Anonymous” unless you opt in.
        </Text>
        <View className="flex-row items-center gap-2">
          <Switch value={showBoard} onValueChange={setShowBoard} />
          <Text className="flex-1 text-sm text-neutral-800 dark:text-neutral-100">
            Show my social handle on leaderboards
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Switch value={showCredit} onValueChange={setShowCredit} />
          <Text className="flex-1 text-sm text-neutral-800 dark:text-neutral-100">
            Credit me on items I contributed
          </Text>
        </View>
        {message ? <Text className="text-sm font-medium text-emerald-700">{message}</Text> : null}
        <Pressable
          className="items-center rounded-lg bg-emerald-700 px-4 py-2.5 disabled:opacity-50"
          disabled={busy}
          onPress={save}
        >
          <Text className="text-base font-semibold text-white">{busy ? "Saving…" : "Save"}</Text>
        </Pressable>
      </View>

      {Platform.OS === "web" ? <PasskeysCard /> : null}

      <Pressable
        className="items-center rounded-lg border border-neutral-300 dark:border-neutral-600 px-4 py-2.5"
        onPress={() => authClient.signOut()}
      >
        <Text className="text-base font-medium text-neutral-800 dark:text-neutral-100">Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

// --- avatar ------------------------------------------------------------------

// ImagePicker asset → raw bytes for POST /me/avatar. Web asset.uri is a
// blob/data URL (fetchable); native is file:// which RN fetch can't read —
// picker base64 + a small decoder instead (no expo-file-system dep).
async function assetBytes(asset: ImagePicker.ImagePickerAsset): Promise<Uint8Array> {
  if (Platform.OS === "web") {
    return new Uint8Array(await (await fetch(asset.uri)).arrayBuffer());
  }
  const bin = atob(asset.base64 ?? "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function AvatarCard({ me, onChanged }: { me: MeProfile; onChanged: (url: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uri = me.avatar_url.startsWith("/") ? `${AUTH_ORIGIN}${me.avatar_url}` : me.avatar_url;
  const uploaded = me.avatar_url.startsWith("/api/avatar/");

  async function upload() {
    setError(null);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.9,
      base64: Platform.OS !== "web",
    });
    const asset = result.assets?.[0];
    if (result.canceled || !asset) return;
    setBusy(true);
    try {
      const bytes = await assetBytes(asset);
      if (bytes.length > 2 * 1024 * 1024) throw new Error("Image must be under 2 MB");
      const r = await adminFetch<{ avatar_url: string }>("/me/avatar", {
        method: "POST",
        body: bytes as unknown as BodyInit,
      });
      onChanged(r.avatar_url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const r = await adminFetch<{ avatar_url: string }>("/me/avatar", { method: "DELETE" });
      onChanged(r.avatar_url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "remove failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="flex-row items-center gap-4 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-4">
      <Image source={{ uri }} className="h-16 w-16 rounded-full bg-neutral-200 dark:bg-neutral-700" />
      <View className="flex-1 gap-1">
        <Text className="text-base font-bold text-neutral-900 dark:text-neutral-100">Photo</Text>
        <Text className="text-xs text-neutral-500 dark:text-neutral-400">
          {uploaded ? "Uploaded photo" : "From your Gravatar — set one at gravatar.com or upload."}
        </Text>
        {error ? <Text className="text-xs text-red-600">{error}</Text> : null}
      </View>
      <View className="gap-2">
        <Pressable
          className="items-center rounded-lg bg-emerald-700 px-3 py-2 disabled:opacity-50"
          disabled={busy}
          onPress={upload}
        >
          <Text className="text-sm font-semibold text-white">{busy ? "…" : "Change"}</Text>
        </Pressable>
        {uploaded ? (
          <Pressable
            className="items-center rounded-lg border border-neutral-300 dark:border-neutral-600 px-3 py-2 disabled:opacity-50"
            disabled={busy}
            onPress={remove}
          >
            <Text className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Remove</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

// --- socials ------------------------------------------------------------------

// Gravatar-verified accounts are the ONLY public-name source. Users manage
// them on gravatar.com; here they refresh the snapshot and pick which one
// identifies them on leaderboards.
function SocialsCard({ me, onChanged }: { me: MeProfile; onChanged: (m: MeProfile) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const r = await adminFetch<{ socials: VerifiedAccount[]; error?: string }>(
        "/me/socials/refresh",
        { method: "POST" },
      );
      if (r.error) setError(r.error);
      onChanged({ ...me, socials: r.socials });
    } catch (e) {
      setError(e instanceof Error ? e.message : "refresh failed");
    } finally {
      setBusy(false);
    }
  }

  async function pick(platform: string | null) {
    setBusy(true);
    setError(null);
    try {
      const r = await adminFetch<{ preferred_social: string | null }>("/me", {
        method: "PATCH",
        body: JSON.stringify({ preferred_social: platform }),
      });
      onChanged({ ...me, preferred_social: r.preferred_social });
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not set preference");
    } finally {
      setBusy(false);
    }
  }

  const chip = (label: string, active: boolean, onPress: () => void, key: string) => (
    <Pressable
      key={key}
      className={`rounded-full border px-3 py-1.5 ${
        active
          ? "border-emerald-700 bg-emerald-700"
          : "border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800"
      }`}
      disabled={busy}
      onPress={onPress}
    >
      <Text className={`text-sm font-medium ${active ? "text-white" : "text-neutral-800 dark:text-neutral-100"}`}>
        {label}
      </Text>
    </Pressable>
  );

  return (
    <View className="gap-3 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-4">
      <Text className="text-base font-bold text-neutral-900 dark:text-neutral-100">Social accounts</Text>
      <Text className="text-sm leading-6 text-neutral-600 dark:text-neutral-300">
        Your public name is a social handle verified by Gravatar — freeform names aren't allowed.
        Link accounts on gravatar.com, then refresh here.
      </Text>

      {me.socials.length === 0 ? (
        <Text className="text-sm text-neutral-500 dark:text-neutral-400">No verified accounts found.</Text>
      ) : (
        <View className="gap-2">
          {me.socials.map((s) => (
            <Pressable key={s.platform} onPress={() => void Linking.openURL(s.url)}>
              <Text className="text-sm text-neutral-800 dark:text-neutral-100">
                <Text className="font-semibold">{s.label}</Text>
                {"  "}
                <Text className="text-emerald-700 dark:text-emerald-400">@{s.handle}</Text>
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      <View className="flex-row flex-wrap gap-2">
        <Pressable
          className="items-center rounded-lg border border-neutral-300 dark:border-neutral-600 px-3 py-2 disabled:opacity-50"
          disabled={busy}
          onPress={refresh}
        >
          <Text className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
            {busy ? "Refreshing…" : "Refresh from Gravatar"}
          </Text>
        </Pressable>
        <Pressable
          className="items-center rounded-lg border border-neutral-300 dark:border-neutral-600 px-3 py-2"
          onPress={() => void Linking.openURL("https://gravatar.com")}
        >
          <Text className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
            Manage on gravatar.com
          </Text>
        </Pressable>
      </View>

      {me.socials.length > 0 ? (
        <View className="gap-2">
          <Text className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            Public handle on leaderboards
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {chip("None", me.preferred_social === null, () => pick(null), "none")}
            {me.socials.map((s) =>
              chip(`@${s.handle}`, me.preferred_social === s.platform, () => pick(s.platform), s.platform),
            )}
          </View>
        </View>
      ) : null}

      {error ? <Text className="text-xs text-red-600">{error}</Text> : null}
    </View>
  );
}

// --- theme --------------------------------------------------------------------

const THEME_OPTIONS: { pref: ThemePref; label: string; icon: string }[] = [
  { pref: "light", label: "Light", icon: "sunny" },
  { pref: "dark", label: "Dark", icon: "moon" },
  { pref: "system", label: "System", icon: "phone-portrait" },
];

function ThemeCard() {
  const { pref, setPref } = useTheme();
  return (
    <View className="gap-2 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-4">
      <Text className="text-base font-bold text-neutral-900 dark:text-neutral-100">Appearance</Text>
      <View className="flex-row gap-2">
        {THEME_OPTIONS.map((o) => {
          const active = pref === o.pref;
          return (
            <Pressable
              key={o.pref}
              className={`flex-1 flex-row items-center justify-center gap-1.5 rounded-lg border px-3 py-2.5 ${
                active
                  ? "border-emerald-700 bg-emerald-700"
                  : "border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800"
              }`}
              onPress={() => setPref(o.pref)}
            >
              <Ionicons
                name={o.icon as never}
                size={16}
                color={active ? "#fff" : "#64748b"}
              />
              <Text
                className={`text-sm font-medium ${active ? "text-white" : "text-neutral-800 dark:text-neutral-100"}`}
              >
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// --- passkeys (web only) -------------------------------------------------------

// Native iOS/Android passkey support is out of scope — the card only renders
// on web. List via the client's passkeys atom; enrol via addPasskey (uses
// the current session); delete hits the plugin's delete endpoint.
function PasskeysCard() {
  const { data: passkeys, refetch } = authClient.useListPasskeys();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    const r = await authClient.passkey.addPasskey();
    setBusy(false);
    if (r.error) setError(r.error.message ?? "Could not add passkey");
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    const r = await authClient.$fetch("/passkey/delete-passkey", {
      method: "POST",
      body: { id },
    });
    setBusy(false);
    if (r.error) setError(r.error.message ?? "Could not remove passkey");
    else void refetch();
  }

  return (
    <View className="gap-3 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-4">
      <Text className="text-base font-bold text-neutral-900 dark:text-neutral-100">Passkeys</Text>
      <Text className="text-sm leading-6 text-neutral-600 dark:text-neutral-300">
        Sign in with your fingerprint, face or device PIN instead of a magic link.
      </Text>
      {(passkeys ?? []).map((p) => (
        <View key={p.id} className="flex-row items-center gap-2">
          <Ionicons name="key" size={16} color="#64748b" />
          <Text className="flex-1 text-sm text-neutral-800 dark:text-neutral-100">
            {p.name || "Passkey"}
          </Text>
          <Pressable disabled={busy} onPress={() => remove(p.id)} hitSlop={8}>
            <Ionicons name="trash-outline" size={18} color="#dc2626" />
          </Pressable>
        </View>
      ))}
      {error ? <Text className="text-xs text-red-600">{error}</Text> : null}
      <Pressable
        className="items-center rounded-lg bg-emerald-700 px-4 py-2.5 disabled:opacity-50"
        disabled={busy}
        onPress={add}
      >
        <Text className="text-sm font-semibold text-white">{busy ? "Working…" : "Add a passkey"}</Text>
      </Pressable>
    </View>
  );
}

// --- badges -------------------------------------------------------------------

// Badge case (Task 8): earned badges as a grid of chips, then the unearned
// ones with a progress bar each ("23/50 check-ins") so there's always a
// next goal in view. Data comes from GET /api/me/badges — computed
// server-side, progress included.
function BadgeCase({ badges }: { badges: Badge[] }) {
  const earned = badges.filter((b) => b.earned);
  const pending = badges.filter((b) => !b.earned);
  return (
    <View className="gap-3 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-4">
      <Text className="text-base font-bold text-neutral-900 dark:text-neutral-100">Badges</Text>
      {earned.length === 0 ? (
        <Text className="text-sm text-neutral-600 dark:text-neutral-300">No badges yet — your first submission earns one.</Text>
      ) : (
        <View className="flex-row flex-wrap gap-2">
          {earned.map((b) => (
            <View key={b.key} className="rounded-full border border-amber-500 bg-amber-50 px-3 py-1.5">
              <Text className="text-sm font-semibold text-amber-800">{b.name}</Text>
            </View>
          ))}
        </View>
      )}
      {pending.length > 0 ? (
        <View className="gap-2.5">
          {pending.map((b) => {
            const pct = Math.min(100, Math.round((b.progress / Math.max(b.target, 1)) * 100));
            return (
              <View key={b.key} className="gap-1">
                <View className="flex-row items-baseline gap-2">
                  <Text className="flex-1 text-sm font-medium text-neutral-800 dark:text-neutral-100" numberOfLines={1}>
                    {b.name}
                  </Text>
                  <Text className="text-xs text-neutral-500 dark:text-neutral-400">
                    {b.progress}/{b.target}
                  </Text>
                </View>
                <View className="h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
                  {/* Percentage widths aren't expressible as static
                      nativewind classes — the fill gets an inline style. */}
                  <View className="h-2 rounded-full bg-emerald-600" style={{ width: `${pct}%` }} />
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
