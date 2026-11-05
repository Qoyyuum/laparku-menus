import * as Clipboard from "expo-clipboard";
import { Link, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Image, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { attachGmapsVenue, getSubmission, importGmaps, type SubmissionStatus } from "../api";
import { SignInGate } from "../components/SignInGate";

type Phase =
  | { step: "form" }
  | { step: "processing"; id: string }
  | { step: "done"; sub: SubmissionStatus }
  | { step: "error"; message: string };

const POLL_MS = 2_500;
const POLL_LIMIT = 60; // ~2.5 min of polling then "still working"

export default function ImportScreen() {
  return (
    <SignInGate
      title="Import a venue from Google Maps"
      subtitle="Sign in to import menus from a shared Google Maps link."
      callbackURL="/import"
      requireReviewer={false}
    >
      <ImportForm />
    </SignInGate>
  );
}

function ImportForm() {
  const params = useLocalSearchParams<{ url?: string; text?: string }>();
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>({ step: "form" });
  const [busy, setBusy] = useState(false);
  const autoSubmitted = useRef(false);

  // Deep links (share intent, share target, clipboard prompt) pre-fill and
  // auto-submit once. ?text= carries share-sheet prose wrapping the URL.
  useEffect(() => {
    const incoming = params.url ?? params.text;
    if (!incoming || autoSubmitted.current) return;
    const match = incoming.match(/https?:\/\/[^\s"'<>]+/);
    if (!match) return;
    autoSubmitted.current = true;
    setUrl(match[0]);
    void submit(match[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.url, params.text]);

  // Clipboard suggestion on web/native mount — a Maps link in the clipboard
  // is almost certainly why the user opened this screen.
  useEffect(() => {
    void (async () => {
      try {
        const text = await Clipboard.getStringAsync();
        if (/maps\.app\.goo\.gl|google\.[a-z.]+\/maps|maps\.google/i.test(text)) setUrl(text.trim());
      } catch {
        // clipboard read denied — the field still accepts manual paste
      }
    })();
  }, []);

  async function submit(link: string) {
    if (!link.trim() || busy) return;
    setBusy(true);
    try {
      const { submission_id } = await importGmaps(link.trim());
      setPhase({ step: "processing", id: submission_id });
    } catch (e) {
      setPhase({ step: "error", message: e instanceof Error ? e.message : "import failed" });
    } finally {
      setBusy(false);
    }
  }

  // Poll until the import reaches a terminal/review state.
  useEffect(() => {
    if (phase.step !== "processing") return;
    let ticks = 0;
    const timer = setInterval(async () => {
      ticks += 1;
      try {
        const sub = await getSubmission(phase.id);
        if (sub.status !== "pending") {
          setPhase({ step: "done", sub });
          clearInterval(timer);
        } else if (ticks >= POLL_LIMIT) {
          setPhase({ step: "error", message: "Still processing — check your submissions later." });
        }
      } catch (e) {
        setPhase({ step: "error", message: e instanceof Error ? e.message : "status check failed" });
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [phase]);

  async function pickVenue(venueId: string | "new") {
    if (phase.step !== "done") return;
    try {
      const result = await attachGmapsVenue(
        phase.sub.id,
        venueId === "new" ? { new_venue: true } : { venue_id: venueId },
      );
      setPhase({ step: "done", sub: { ...phase.sub, status: result.status === "imported" ? "trusted_published" : "pending_review" } });
    } catch (e) {
      setPhase({ step: "error", message: e instanceof Error ? e.message : "venue attach failed" });
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16, maxWidth: 640, alignSelf: "center", width: "100%" }}>
      <Text style={{ fontSize: 20, fontWeight: "700" }}>Import from Google Maps</Text>
      <Text style={{ color: "#666" }}>
        Share or paste a Google Maps link — we'll read the venue's menu and photos for you.
      </Text>

      <TextInput
        value={url}
        onChangeText={setUrl}
        placeholder="https://maps.app.goo.gl/…"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={Platform.OS === "web" ? "default" : "url"}
        style={{ borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 }}
      />
      <Pressable
        onPress={() => void submit(url)}
        disabled={busy || !url.trim()}
        style={{ backgroundColor: busy || !url.trim() ? "#9cc" : "#208AEF", padding: 12, borderRadius: 8 }}
      >
        <Text style={{ color: "#fff", textAlign: "center", fontWeight: "600" }}>
          {busy ? "Sending…" : "Import"}
        </Text>
      </Pressable>

      {phase.step === "processing" && <Text>Reading the venue on Google Maps…</Text>}
      {phase.step === "error" && <Text style={{ color: "#b00" }}>{phase.message}</Text>}
      {phase.step === "done" && <Outcome sub={phase.sub} onPick={pickVenue} />}
      {(phase.step === "done" || phase.step === "error") && (
        <Pressable
          onPress={() => {
            setUrl("");
            setPhase({ step: "form" });
          }}
          style={{ borderWidth: 1, borderColor: "#208AEF", borderRadius: 8, padding: 12 }}
        >
          <Text style={{ color: "#208AEF", textAlign: "center", fontWeight: "600" }}>
            Import another venue
          </Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

function Outcome({ sub, onPick }: { sub: SubmissionStatus; onPick: (v: string | "new") => void }) {
  const place = sub.gmaps?.place;
  if (sub.status === "trusted_published") {
    return (
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 16, fontWeight: "600" }}>
          {place?.name ? `Menu imported from ${place.name}` : "Menu imported"}
        </Text>
        <Text>
          {sub.gmaps?.published ?? 0} items are live now (pending a reviewer check)
          {(sub.gmaps?.matched ?? 0) > 0 ? `, ${sub.gmaps!.matched} already on the menu` : ""}.
        </Text>
      </View>
    );
  }
  if (sub.status === "pending_review") {
    const candidates = sub.gmaps?.venue_candidates ?? [];
    const photos = sub.gmaps?.photo_urls ?? [];
    const hasSections = (sub.items_count ?? 0) > 0;
    return (
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 16, fontWeight: "600" }}>
          {place?.name ?? "Venue"} — {hasSections ? `${sub.items_count} menu items found` : `${sub.photo_count} menu photos sent for extraction`}
        </Text>
        {photos.length > 0 && (
          <>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {photos.slice(0, 12).map((u) => (
                <Image key={u} source={{ uri: u }} style={{ width: 72, height: 72, borderRadius: 6 }} />
              ))}
            </View>
            <Text style={{ fontSize: 12, color: "#888" }}>
              Google Maps often has more menu shots than the import could pull — open the venue and
              check the Menu tab.
            </Text>
          </>
        )}
        {candidates.length > 0 ? (
          <>
            <Text>Which venue is this?</Text>
            {candidates.map((v) => (
              <Pressable key={v.id} onPress={() => void onPick(v.id)} style={{ borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 }}>
                <Text>{v.name} — {v.distance_m}m away</Text>
              </Pressable>
            ))}
            <Pressable onPress={() => void onPick("new")} style={{ padding: 10 }}>
              <Text style={{ color: "#208AEF" }}>It's a new venue — send to review</Text>
            </Pressable>
          </>
        ) : (
          <Text>Queued for review — a reviewer will attach it to the right venue.</Text>
        )}
        <Link href="/submit" asChild>
          <Pressable style={{ borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 }}>
            <Text style={{ textAlign: "center", color: "#208AEF", fontWeight: "600" }}>
              Add more menu photos manually
            </Text>
          </Pressable>
        </Link>
      </View>
    );
  }
  if (sub.status === "auto_rejected") {
    return (
      <Text>
        {sub.rejection_reason === "gmaps_no_data"
          ? "Google Maps has no menu data for this place — try photos instead."
          : `Import couldn't be processed (${sub.rejection_reason ?? "unknown"}).`}
      </Text>
    );
  }
  return <Text>Status: {sub.status}</Text>;
}
