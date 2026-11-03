import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { API_BASE, SOURCE_TYPES } from "../api";
import { Turnstile } from "../components/Turnstile";

// Source types the photo-upload form can produce (manual_entry is the
// signed-in text form; url submissions carry their link in provenance).
const PICKABLE_SOURCE_TYPES = SOURCE_TYPES.filter((t) => t !== "manual_entry");
const MAX_FILES = 10;
const TURNSTILE_SITEKEY = process.env.EXPO_PUBLIC_TURNSTILE_SITEKEY ?? "";

const SOURCE_LABELS: Record<string, string> = {
  menu_photo: "Menu photo",
  menu_pdf: "Menu PDF",
  product_photo: "Product photo",
  barcode: "Barcode",
  url: "Web link",
};

type Picked = ImagePicker.ImagePickerAsset;

function fileName(asset: Picked, i: number): string {
  return asset.fileName ?? `upload-${i}.jpg`;
}

export default function SubmitScreen() {
  const [sourceType, setSourceType] = useState<(typeof PICKABLE_SOURCE_TYPES)[number]>("menu_photo");
  const [provenance, setProvenance] = useState("");
  const [email, setEmail] = useState("");
  const [files, setFiles] = useState<Picked[]>([]);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(fromCamera: boolean) {
    const opts: ImagePicker.ImagePickerOptions = {
      mediaTypes: ["images"],
      quality: 0.85,
      allowsMultipleSelection: !fromCamera,
      selectionLimit: MAX_FILES,
    };
    const res = fromCamera
      ? await ImagePicker.launchCameraAsync(opts)
      : await ImagePicker.launchImageLibraryAsync(opts);
    if (!res.canceled) setFiles((prev) => [...prev, ...res.assets].slice(0, MAX_FILES));
  }

  // FormData wants platform-specific file parts: RN's {uri,name,type} object
  // on native, a real Blob/File on web.
  async function appendFiles(form: FormData) {
    for (let i = 0; i < files.length; i++) {
      const asset = files[i]!;
      if (Platform.OS === "web") {
        const blob = asset.file ?? (await (await fetch(asset.uri)).blob());
        form.append("files", blob, fileName(asset, i));
      } else {
        form.append("files", {
          uri: asset.uri,
          name: fileName(asset, i),
          type: asset.mimeType ?? "image/jpeg",
        } as unknown as Blob);
      }
    }
  }

  const needsFiles = sourceType !== "url";
  const canSubmit =
    !busy &&
    provenance.trim() !== "" &&
    (!needsFiles || files.length > 0) &&
    (Platform.OS !== "web" || TURNSTILE_SITEKEY === "" || turnstileToken !== "");

  async function submit() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const form = new FormData();
      form.set("source_type", sourceType);
      form.set("provenance", provenance.trim());
      if (email.trim()) form.set("email", email.trim());
      if (Platform.OS === "web" && turnstileToken) form.set("turnstile_token", turnstileToken);
      await appendFiles(form);
      const res = await fetch(`${API_BASE}/submissions`, {
        method: "POST",
        body: form,
        // Native clients can't run the web Turnstile widget — the header
        // marks them for the server's native path instead.
        headers: Platform.OS === "web" ? undefined : { "X-Laparku-Client": "app" },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `submission failed (${res.status})`);
      }
      setMessage("Submitted — thank you! It goes into the review queue before it goes live.");
      setFiles([]);
      setProvenance("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "submission failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView className="flex-1 bg-neutral-50" contentContainerClassName="gap-4 p-4">
      <Text className="text-xl font-bold text-neutral-900">Submit a menu</Text>
      <Text className="text-sm leading-6 text-neutral-600">
        Photograph a menu, product or barcode and we will extract the items for review. Submissions
        are checked by a reviewer before they go live.
      </Text>

      <View className="gap-1.5">
        <Text className="text-sm font-semibold text-neutral-800">What are you submitting?</Text>
        <View className="flex-row flex-wrap gap-2">
          {PICKABLE_SOURCE_TYPES.map((t) => (
            <Pressable
              key={t}
              className={`rounded-full border px-3 py-1.5 ${
                sourceType === t ? "border-emerald-700 bg-emerald-700" : "border-neutral-300 bg-white"
              }`}
              onPress={() => setSourceType(t)}
            >
              <Text
                className={`text-sm font-medium ${sourceType === t ? "text-white" : "text-neutral-700"}`}
              >
                {SOURCE_LABELS[t] ?? t}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View className="gap-1.5">
        <Text className="text-sm font-semibold text-neutral-800">
          Photos {needsFiles ? "(at least one required)" : "(optional)"}
        </Text>
        <View className="flex-row gap-2">
          <Pressable
            className="rounded-lg border border-neutral-300 bg-white px-3 py-2"
            onPress={() => pick(false)}
          >
            <Text className="text-sm font-medium text-neutral-800">Choose photos</Text>
          </Pressable>
          {Platform.OS !== "web" ? (
            <Pressable
              className="rounded-lg border border-neutral-300 bg-white px-3 py-2"
              onPress={() => pick(true)}
            >
              <Text className="text-sm font-medium text-neutral-800">Take photo</Text>
            </Pressable>
          ) : null}
        </View>
        {files.length > 0 ? (
          <Text className="text-sm text-neutral-600">
            {files.length} file{files.length === 1 ? "" : "s"} selected
          </Text>
        ) : null}
      </View>

      <View className="gap-1.5">
        <Text className="text-sm font-semibold text-neutral-800">
          Where is this from? <Text className="text-red-600">*</Text>
        </Text>
        <TextInput
          className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base"
          placeholder={
            sourceType === "url"
              ? "https://… link to the menu"
              : "e.g. physical menu at Kedai Kopi, Serusop — photographed Nov 2026"
          }
          value={provenance}
          onChangeText={setProvenance}
          multiline
        />
        <Text className="text-xs text-neutral-500">
          Provenance helps reviewers verify the menu is real. It is required.
        </Text>
      </View>

      <View className="gap-1.5">
        <Text className="text-sm font-semibold text-neutral-800">Email (optional)</Text>
        <TextInput
          className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base"
          placeholder="Get credit for your submissions"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
      </View>

      {Platform.OS === "web" && TURNSTILE_SITEKEY !== "" ? (
        <Turnstile siteKey={TURNSTILE_SITEKEY} onToken={setTurnstileToken} />
      ) : null}

      {error ? <Text className="text-sm text-red-600">{error}</Text> : null}
      {message ? <Text className="text-sm font-medium text-emerald-700">{message}</Text> : null}

      <Pressable
        className="items-center rounded-lg bg-emerald-700 px-4 py-3 disabled:opacity-50"
        disabled={!canSubmit}
        onPress={submit}
      >
        <Text className="text-base font-semibold text-white">{busy ? "Uploading…" : "Submit"}</Text>
      </Pressable>
    </ScrollView>
  );
}
