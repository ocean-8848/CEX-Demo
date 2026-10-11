import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

import { createOpsFetch, readErrorMessage, type OpsFetch } from "../lib/api.js";
import type { OpsSession } from "../lib/types.js";

// Older builds kept the bearer token here; it is removed on boot.
const LEGACY_TOKEN_KEY = "ops-console:token";
const THEME_KEY = "ops-console:theme";

export interface Toast {
  id: number;
  tone: "positive" | "negative" | "neutral";
  title: string;
  detail?: string;
}

interface SessionContextValue {
  session: OpsSession | null;
  booting: boolean;
  api: OpsFetch;
  can: (permission: string) => boolean;
  login: (input: { email: string; password: string; twoFactorCode?: string }) => Promise<void>;
  logout: () => Promise<void>;
  toasts: Toast[];
  toast: (tone: Toast["tone"], title: string, detail?: string) => void;
  dismissToast: (id: number) => void;
  theme: "dark" | "light";
  toggleTheme: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function readStorage(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // Storage may be unavailable; the session then only lives in memory.
  }
}

let toastCounter = 0;

export function SessionProvider(props: { children: ReactNode }) {
  const signedInRef = useRef(false);
  const [session, setSession] = useState<OpsSession | null>(null);
  const [booting, setBooting] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setTheme] = useState<"dark" | "light">(
    readStorage(THEME_KEY) === "light" ? "light" : "dark"
  );

  const toast = useCallback((tone: Toast["tone"], title: string, detail?: string) => {
    toastCounter += 1;
    const id = toastCounter;
    setToasts((current) => [...current.slice(-3), { id, tone, title, detail }]);
  }, []);
  const dismissToast = useCallback(
    (id: number) => setToasts((current) => current.filter((item) => item.id !== id)),
    []
  );

  const clearSession = useCallback(() => {
    signedInRef.current = false;
    setSession(null);
  }, []);

  const api = useMemo(
    () =>
      createOpsFetch(
        () => signedInRef.current,
        () => {
          clearSession();
          toast("neutral", "登录已失效", "请重新登录运营后台");
        }
      ),
    [clearSession, toast]
  );

  // Restore the session from the HttpOnly cookie (if any): the browser sends it
  // automatically, the page just asks who it is.
  useEffect(() => {
    writeStorage(LEGACY_TOKEN_KEY, null);
    api<OpsSession>("/auth/me")
      .then((current) => {
        signedInRef.current = true;
        setSession(current);
      })
      .catch(() => clearSession())
      .finally(() => setBooting(false));
  }, [api, clearSession]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeStorage(THEME_KEY, theme);
  }, [theme]);

  const login = useCallback(
    async (input: { email: string; password: string; twoFactorCode?: string }) => {
      const result = await api<OpsSession>("/auth/login", {
        method: "POST",
        body: { ...input, twoFactorCode: input.twoFactorCode || undefined }
      });
      signedInRef.current = true;
      setSession(result);
      toast("positive", `欢迎，${result.displayName ?? result.email ?? "operator"}`);
    },
    [api, toast]
  );

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST", body: {} });
    } catch (error) {
      console.warn(readErrorMessage(error));
    }
    clearSession();
  }, [api, clearSession]);

  const can = useCallback(
    (permission: string) => Boolean(session?.permissions?.includes(permission)),
    [session]
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      booting,
      api,
      can,
      login,
      logout,
      toasts,
      toast,
      dismissToast,
      theme,
      toggleTheme: () => setTheme((current) => (current === "dark" ? "light" : "dark"))
    }),
    [session, booting, api, can, login, logout, toasts, toast, dismissToast, theme]
  );

  return <SessionContext.Provider value={value}>{props.children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error("useSession must be used inside <SessionProvider>");
  }
  return value;
}
