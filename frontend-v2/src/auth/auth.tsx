import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { validateBasicAuth } from "../api/api";

export type Credentials = { username: string; password: string };

type AuthStatus = "checking" | "authenticated" | "unauthenticated";

type AuthContextValue = {
  status: AuthStatus;
  credentials: Credentials | null;
  message: string | null;
  clearMessage: () => void;
  login: (c: Credentials, opts?: { remember?: boolean }) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const STORAGE_KEY_LOCAL = "erp.v2.basicAuth.local";
const STORAGE_KEY_SESSION = "erp.v2.basicAuth.session";

function readStorage(): { credentials: Credentials; remember: boolean } | null {
  const read = (key: string): Credentials | null => {
    try {
      const raw = localStorage.getItem(key) ?? sessionStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw) as { username?: string; password?: string };
      if (!obj.username || !obj.password) return null;
      return { username: obj.username, password: obj.password };
    } catch {
      return null;
    }
  };

  const local = read(STORAGE_KEY_LOCAL);
  if (local) return { credentials: local, remember: true };
  const session = read(STORAGE_KEY_SESSION);
  if (session) return { credentials: session, remember: false };
  return null;
}

function clearStorage() {
  try {
    localStorage.removeItem(STORAGE_KEY_LOCAL);
    sessionStorage.removeItem(STORAGE_KEY_SESSION);
  } catch {
    // ignore
  }
}

function writeStorage(credentials: Credentials, remember: boolean) {
  clearStorage();
  const raw = JSON.stringify(credentials);
  if (remember) localStorage.setItem(STORAGE_KEY_LOCAL, raw);
  else sessionStorage.setItem(STORAGE_KEY_SESSION, raw);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const stored = useMemo(() => readStorage(), []);
  const [status, setStatus] = useState<AuthStatus>(() => (stored ? "checking" : "unauthenticated"));
  const [credentials, setCredentials] = useState<Credentials | null>(() => stored?.credentials ?? null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!stored) return;

    const controller = new AbortController();
    validateBasicAuth(stored.credentials, controller.signal)
      .then(() => setStatus("authenticated"))
      .catch(() => {
        clearStorage();
        setCredentials(null);
        setStatus("unauthenticated");
        setMessage("Gespeicherte Zugangsdaten sind ungültig. Bitte erneut anmelden.");
      });

    return () => controller.abort();
  }, [stored]);

  const clearMessage = useCallback(() => setMessage(null), []);

  const logout = useCallback(() => {
    clearStorage();
    setCredentials(null);
    setStatus("unauthenticated");
  }, []);

  const login = useCallback(async (c: Credentials, opts?: { remember?: boolean }) => {
    await validateBasicAuth(c);
    writeStorage(c, Boolean(opts?.remember));
    setCredentials(c);
    setStatus("authenticated");
    setMessage(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      credentials,
      message,
      clearMessage,
      login,
      logout,
    }),
    [status, credentials, message, clearMessage, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

