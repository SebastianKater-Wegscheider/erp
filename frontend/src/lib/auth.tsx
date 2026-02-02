import React, { createContext, useContext, useMemo, useState } from "react";

type Credentials = { username: string; password: string } | null;

type AuthContextValue = {
  credentials: Credentials;
  setCredentials: (c: { username: string; password: string }) => void;
  clearCredentials: () => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const STORAGE_KEY = "erp.basicAuth";

function loadCredentials(): Credentials {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as { username?: string; password?: string };
    if (!obj.username || !obj.password) return null;
    return { username: obj.username, password: obj.password };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [credentials, setCreds] = useState<Credentials>(() => loadCredentials());

  const value = useMemo<AuthContextValue>(
    () => ({
      credentials,
      setCredentials: (c) => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
        setCreds(c);
      },
      clearCredentials: () => {
        localStorage.removeItem(STORAGE_KEY);
        setCreds(null);
      },
    }),
    [credentials],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

