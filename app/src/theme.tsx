// Theme preference — light | dark | system.
//
// Stored server-side on the user row (PATCH /api/me → `theme`, default
// 'system') so it follows the account across devices; a local copy rides in
// localStorage (web) / SecureStore (native) so the right theme applies
// before the session + GET /api/me round-trip resolves. Signed-out users
// get 'system'. The NativeWind `colorScheme` setter accepts 'system'
// directly, so the resolved `scheme` already folds the device scheme in —
// `dark:` variants just work.
import { useColorScheme } from "nativewind";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import type { MeProfile, ThemePref } from "./api";
import { adminFetch, authClient } from "./auth";

const PREFS = ["light", "dark", "system"] as const;
const CACHE_KEY = "laparku.theme";

export function isThemePref(v: unknown): v is ThemePref {
  return typeof v === "string" && (PREFS as readonly string[]).includes(v);
}

// --- local cache -------------------------------------------------------------

async function readCachedPref(): Promise<ThemePref | null> {
  try {
    const raw =
      Platform.OS === "web"
        ? globalThis.localStorage?.getItem(CACHE_KEY)
        : await SecureStore.getItemAsync(CACHE_KEY);
    return isThemePref(raw) ? raw : null;
  } catch {
    return null;
  }
}

async function writeCachedPref(pref: ThemePref): Promise<void> {
  try {
    if (Platform.OS === "web") globalThis.localStorage?.setItem(CACHE_KEY, pref);
    else await SecureStore.setItemAsync(CACHE_KEY, pref);
  } catch {
    // cache is a nicety — never let a storage hiccup break the UI
  }
}

// --- context -----------------------------------------------------------------

interface ThemeCtx {
  /** Resolved scheme — what NativeWind is actually applying. */
  scheme: "light" | "dark";
  /** The stored preference (may be "system"). */
  pref: ThemePref;
  setPref: (pref: ThemePref) => void;
}

const Ctx = createContext<ThemeCtx>({ scheme: "light", pref: "system", setPref: () => {} });

export function useTheme(): ThemeCtx {
  return useContext(Ctx);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // NativeWind's hook owns the class-scheme plumbing — we only ever push the
  // preference INTO it ('system' is a first-class value there).
  const { colorScheme, setColorScheme } = useColorScheme();
  const { data: session } = authClient.useSession();
  const [pref, setPrefState] = useState<ThemePref>("system");
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from the local cache first (instant), then — when a session
  // exists — from the server row (authoritative across devices).
  useEffect(() => {
    let cancelled = false;
    void readCachedPref().then((cached) => {
      if (cancelled) return;
      if (cached && cached !== "system") {
        setPrefState(cached);
        setColorScheme(cached);
      }
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [setColorScheme]);

  useEffect(() => {
    if (!hydrated || !session?.user) return;
    let cancelled = false;
    void (async () => {
      try {
        const me = await adminFetch<MeProfile>("/me");
        if (cancelled || !isThemePref(me.theme)) return;
        setPrefState(me.theme);
        setColorScheme(me.theme);
        void writeCachedPref(me.theme);
      } catch {
        // theme is best-effort — the cache/device default is fine
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrated, session?.user, setColorScheme]);

  const setPref = useCallback(
    (p: ThemePref) => {
      setPrefState(p);
      setColorScheme(p);
      void writeCachedPref(p);
      // Signed-in users persist to the server; signed-out writes are local
      // only (the API would 401 anyway). Swallow failures — the pref stays
      // applied locally regardless.
      if (session?.user) {
        void adminFetch("/me", {
          method: "PATCH",
          body: JSON.stringify({ theme: p }),
        }).catch(() => {});
      }
    },
    [setColorScheme, session?.user],
  );

  const scheme = colorScheme === "dark" ? "dark" : "light";
  return <Ctx.Provider value={{ scheme, pref, setPref }}>{children}</Ctx.Provider>;
}

// --- chrome colors ------------------------------------------------------------
// className dark: variants style the app body, but navigation chrome
// (header bar, tab bar, status bar) takes real colors.

interface NavColors {
  headerBg: string;
  headerText: string;
  tabBg: string;
  tabBorder: string;
  activeTint: string;
  inactiveTint: string;
  statusBar: "light" | "dark";
}

const NAV: Record<"light" | "dark", NavColors> = {
  light: {
    headerBg: "#047857", // emerald-700 — the app's established brand bar
    headerText: "#ffffff",
    tabBg: "#ffffff",
    tabBorder: "#e2e8f0",
    activeTint: "#047857",
    inactiveTint: "#64748b",
    statusBar: "light",
  },
  dark: {
    headerBg: "#052e22", // deep emerald — brand tint without blinding
    headerText: "#e5e7eb",
    tabBg: "#111827",
    tabBorder: "#1f2937",
    activeTint: "#34d399",
    inactiveTint: "#6b7280",
    statusBar: "light",
  },
};

export function navColors(scheme: "light" | "dark"): NavColors {
  return NAV[scheme];
}
