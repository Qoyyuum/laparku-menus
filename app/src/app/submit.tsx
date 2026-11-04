import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import { Image, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { API_BASE, SOURCE_TYPES } from "../api";
import { getAuthCookie } from "../auth";
import { ScanTab } from "../components/ScanTab";
import { SignInGate } from "../components/SignInGate";
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

// Normalized picked file — image-picker and document-picker assets collapse
// to the fields the upload needs.
interface PickedFile {
  uri: string;
  name: string;
  mimeType?: string;
  file?: File; // web only — avoids a second fetch of the blob
}

// Web-side downscale: phone/desktop screenshots easily exceed the server's
// per-file cap, so large images are recompressed to JPEG before upload.
const MAX_DIM = 1600;
async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 800_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

// Phase 2: submissions require an account — the form only renders inside a
// session; any authenticated role may submit (not just reviewers).
export default function SubmitScreen() {
  return (
    <SignInGate
      title="Sign in to submit a menu"
      subtitle="Sign in to file submissions and earn credit and badges."
      callbackURL="/submit"
      requireReviewer={false}
    >
      <SubmitForm />
    </SignInGate>
  );
}

function SubmitForm() {
  // Page-level mode: the classic photo/file form vs the Scans tab
  // (continuous-decode barcode capture → trusted-publish batch).
  const [mode, setMode] = useState<"form" | "scan">("form");
  const [sourceType, setSourceType] = useState<(typeof PICKABLE_SOURCE_TYPES)[number]>("menu_photo");
  const [provenance, setProvenance] = useState("");
  const [email, setEmail] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Web clipboard paste (Ctrl+V): screenshots and copied files attach straight
  // to the submission without a save-to-disk step. File items are only
  // consumed when they fit the current source type — image types accept
  // images, menu_pdf accepts PDFs — so pasting text into the provenance/email
  // fields is never intercepted.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const onPaste = async (e: ClipboardEvent) => {
      const pasted: PickedFile[] = [];
      for (const item of e.clipboardData?.items ?? []) {
        if (item.kind !== "file") continue;
        const f = item.getAsFile();
        if (!f) continue;
        const isPdf = f.type === "application/pdf";
        const isImage = f.type.startsWith("image/");
        if (!isImage && !(isPdf && sourceType === "menu_pdf")) continue;
        const file = await compressImage(f);
        pasted.push({
          uri: URL.createObjectURL(file),
          name:
            file.name && file.name !== "image.png"
              ? file.name
              : `pasted-${Date.now()}.${isPdf ? "pdf" : (file.type.split("/")[1] ?? "png")}`,
          mimeType: file.type,
          file,
        });
      }
      if (pasted.length) {
        e.preventDefault();
        setFiles((prev) => [...prev, ...pasted].slice(0, MAX_FILES));
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [sourceType]);
  const [error, setError] = useState<string | null>(null);

  async function pick(fromCamera: boolean) {
    setError(null);
    // PDF menus come through the document picker — the image picker can't
    // select them.
    if (sourceType === "menu_pdf") {
      const res = await DocumentPicker.getDocumentAsync({ type: "application/pdf", multiple: true });
      if (!res.canceled) {
        setFiles((prev) =>
          [
            ...prev,
            ...res.assets.map((a) => ({
              uri: a.uri,
              name: a.name ?? "menu.pdf",
              mimeType: a.mimeType ?? "application/pdf",
              file: a.file,
            })),
          ].slice(0, MAX_FILES),
        );
      }
      return;
    }
    if (fromCamera) {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        setError(
          "Camera access is needed to photograph a menu — allow it in your device settings, or choose photos from the gallery instead.",
        );
        return;
      }
    }
    const opts: ImagePicker.ImagePickerOptions = {
      mediaTypes: ["images"],
      quality: 0.85,
      allowsMultipleSelection: !fromCamera,
      selectionLimit: MAX_FILES,
    };
    const res = fromCamera
      ? await ImagePicker.launchCameraAsync(opts)
      : await ImagePicker.launchImageLibraryAsync(opts);
    if (!res.canceled) {
      const picked = await Promise.all(
        res.assets.map(async (a, i) => {
          const file = a.file ? await compressImage(a.file) : undefined;
          return {
            uri: file ? URL.createObjectURL(file) : a.uri,
            name: file?.name ?? a.fileName ?? `photo-${i}.jpg`,
            mimeType: file?.type ?? a.mimeType,
            file,
          };
        }),
      );
      setFiles((prev) => [...prev, ...picked].slice(0, MAX_FILES));
    }
  }

  // Miss-path handoff (spec §3): unknown scan codes switch to the
  // product-photo form with the digits carried in provenance so a reviewer
  // can match them against the photo. The tag always appends — a stale
  // provenance draft must not swallow the digits.
  function addPhotosForCode(codes: string[], venueName: string) {
    setMode("form");
    setSourceType("product_photo");
    const tag =
      codes.length === 1
        ? `Barcode: ${codes[0]} — product photo at ${venueName}`
        : `Barcodes: ${codes.join(", ")} — product photos at ${venueName}`;
    setProvenance((p) => (p.trim() ? `${p.trim()}\n${tag}` : tag));
    setMessage(null);
  }

  // FormData wants platform-specific file parts: RN's {uri,name,type} object
  // on native, a real Blob/File on web.
  async function appendFiles(form: FormData) {
    for (const f of files) {
      if (Platform.OS === "web") {
        const blob = f.file ?? (await (await fetch(f.uri)).blob());
        form.append("files", blob, f.name);
      } else {
        form.append("files", {
          uri: f.uri,
          name: f.name,
          type: f.mimeType ?? "image/jpeg",
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
      // The session cookie is required now (phase 2): web sends it via
      // credentials:"include"; native forwards the expoClient-stored cookie
      // explicitly, like adminFetch does.
      const headers: Record<string, string> = {};
      if (Platform.OS !== "web") {
        headers["X-Laparku-Client"] = "app";
        const cookie = await getAuthCookie();
        if (cookie) headers.cookie = cookie;
      }
      const res = await fetch(`${API_BASE}/submissions`, {
        method: "POST",
        body: form,
        headers,
        credentials: "include",
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
        Photograph a menu, product or barcode and we will extract the items for review. Scans that
        match a product database go live right away under a pending-verification badge; everything
        else is checked by a reviewer first.
      </Text>

      {/* Mode tabs: the classic photo/file form vs the continuous-decode
          scanner. Scanning is the packaged-product path — menus and dishes
          stay on the photo form. */}
      <View className="flex-row rounded-lg border border-neutral-300 bg-white p-1">
        {(["form", "scan"] as const).map((m) => (
          <Pressable
            key={m}
            className={`flex-1 items-center rounded-md px-3 py-1.5 ${
              mode === m ? "bg-emerald-700" : ""
            }`}
            onPress={() => setMode(m)}
          >
            <Text
              className={`text-sm font-semibold ${mode === m ? "text-white" : "text-neutral-700"}`}
            >
              {m === "form" ? "Photos / files" : "Scans"}
            </Text>
          </Pressable>
        ))}
      </View>

      {mode === "scan" ? (
        <ScanTab onAddPhotos={addPhotosForCode} />
      ) : (
        <>
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
          {sourceType === "menu_pdf" ? "PDF files" : "Photos"}{" "}
          {needsFiles ? "(at least one required)" : "(optional)"}
        </Text>
        <View className="flex-row gap-2">
          <Pressable
            className="rounded-lg border border-neutral-300 bg-white px-3 py-2"
            onPress={() => pick(false)}
          >
            <Text className="text-sm font-medium text-neutral-800">
              {sourceType === "menu_pdf" ? "Choose PDF files" : "Choose photos"}
            </Text>
          </Pressable>
          {Platform.OS !== "web" && sourceType !== "menu_pdf" ? (
            <Pressable
              className="rounded-lg border border-neutral-300 bg-white px-3 py-2"
              onPress={() => pick(true)}
            >
              <Text className="text-sm font-medium text-neutral-800">Take photo</Text>
            </Pressable>
          ) : null}
        </View>
        {Platform.OS === "web" ? (
          <Text className="text-sm text-neutral-500">
            Tip: you can also paste a screenshot or copied file with Ctrl+V.
          </Text>
        ) : null}
        {files.length > 0 ? (
          <>
            <ScrollView horizontal className="flex-row" showsHorizontalScrollIndicator={false}>
              {files.map((f, i) => (
                <View key={`${f.uri}-${i}`} className="relative mr-2">
                  {f.mimeType?.startsWith("image/") || !f.mimeType ? (
                    <Pressable
                      accessibilityLabel={`Enlarge preview of ${f.name}`}
                      onPress={() => setPreviewUri(f.uri)}
                    >
                      <Image
                        source={{ uri: f.uri }}
                        className="h-20 w-20 rounded-lg border border-neutral-200"
                        resizeMode="cover"
                      />
                    </Pressable>
                  ) : (
                    <View className="h-20 w-20 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-100">
                      <Text className="text-xs font-semibold text-neutral-600">PDF</Text>
                    </View>
                  )}
                  <Pressable
                    className="absolute -right-1.5 -top-1.5 h-5 w-5 items-center justify-center rounded-full bg-neutral-800"
                    accessibilityLabel={`Remove ${f.name}`}
                    onPress={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Text className="text-xs font-bold text-white">×</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
            <Text className="text-sm text-neutral-600">
              {files.length} file{files.length === 1 ? "" : "s"} selected — check the previews, remove
              any that are wrong, then submit.
            </Text>
          </>
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
        <Turnstile siteKey={TURNSTILE_SITEKEY} onToken={setTurnstileToken} onError={setError} />
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
        </>
      )}

      {/* Tap a thumbnail to inspect it full-size before submitting — tap the
          backdrop or the X to dismiss. */}
      <Modal
        visible={previewUri !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewUri(null)}
      >
        <Pressable
          className="flex-1 items-center justify-center bg-black/80 p-4"
          accessibilityLabel="Close preview"
          onPress={() => setPreviewUri(null)}
        >
          {previewUri ? (
            <Image
              source={{ uri: previewUri }}
              className="h-full w-full"
              resizeMode="contain"
            />
          ) : null}
          <Pressable
            className="absolute right-4 top-4 h-9 w-9 items-center justify-center rounded-full bg-white/20"
            accessibilityLabel="Close preview"
            onPress={() => setPreviewUri(null)}
          >
            <Text className="text-lg font-bold text-white">×</Text>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}
