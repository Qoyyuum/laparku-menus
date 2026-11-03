import { useEffect, useRef, type ComponentRef } from "react";
import { View } from "react-native";
import type { TurnstileProps } from "./Turnstile";

// The app's tsconfig has no DOM lib (lib: ESNext) — all browser access goes
// through this typed view of globalThis instead of `window`/`document`.
interface TurnstileApi {
  render: (
    el: unknown,
    opts: { sitekey: string; callback: (token: string) => void; "error-callback"?: () => void },
  ) => string;
  remove: (widgetId: string) => void;
}

interface ScriptElement {
  src: string;
  async: boolean;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

const browser = globalThis as unknown as {
  document: {
    createElement: (tag: "script") => ScriptElement;
    head: { appendChild: (node: unknown) => void };
  };
  turnstile?: TurnstileApi;
};

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptPromise: Promise<void> | null = null;

function loadTurnstile(): Promise<void> {
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    if (browser.turnstile) return resolve();
    const script = browser.document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("turnstile script failed to load"));
    };
    browser.document.head.appendChild(script);
  });
  return scriptPromise;
}

// Cloudflare Turnstile widget (web only). Renders explicitly into the View's
// underlying DOM node so mounts after the script loads still work; calls
// onToken with the token POST /api/submissions expects in `turnstile_token`.
export function Turnstile({ siteKey, onToken, onError }: TurnstileProps) {
  // On react-native-web a View ref is the rendered DOM element.
  const ref = useRef<ComponentRef<typeof View> | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let widgetId: string | undefined;
    let cancelled = false;
    loadTurnstile()
      .then(() => {
        if (cancelled || !ref.current || !browser.turnstile) return;
        widgetId = browser.turnstile.render(ref.current, {
          sitekey: siteKey,
          callback: (token) => onTokenRef.current(token),
          "error-callback": () =>
            onErrorRef.current?.("Spam check failed — reload the page and try again."),
        });
      })
      .catch(() => {
        onErrorRef.current?.(
          "Spam check (Turnstile) failed to load — check your connection or ad blocker, then reload.",
        );
      });
    return () => {
      cancelled = true;
      if (widgetId && browser.turnstile) browser.turnstile.remove(widgetId);
    };
  }, [siteKey]);

  return <View ref={ref} />;
}
