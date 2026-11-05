import { useRouter } from "expo-router";
import { useEffect } from "react";

// expo-share-intent is a native module — it loads fine on dev-client
// builds but throws inside useShareIntent on Expo Go and on web. The
// require is top-level (module presence is constant per binary) and the
// hook call is try/catch-guarded, so the component is a no-op where the
// native side is missing while hook-call order stays stable.
interface ShareIntentLike {
  hasShareIntent?: boolean;
  shareIntent?: { webUrl?: string | null; text?: string | null };
  resetShareIntent?: () => void;
}
let useShareIntent: (() => ShareIntentLike) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  useShareIntent = (require("expo-share-intent") as { useShareIntent: () => ShareIntentLike })
    .useShareIntent;
} catch {
  useShareIntent = null;
}

export function ShareIntentRouter() {
  const router = useRouter();
  let si: ShareIntentLike | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- guarded module;
    // presence is constant per binary so call order is stable.
    si = useShareIntent ? useShareIntent() : null;
  } catch {
    si = null;
  }

  useEffect(() => {
    if (!si?.hasShareIntent) return;
    const url = si.shareIntent?.webUrl ?? si.shareIntent?.text;
    if (url) {
      si.resetShareIntent?.();
      router.push({ pathname: "/import", params: { url } });
    }
  }, [si, router]);

  return null;
}
