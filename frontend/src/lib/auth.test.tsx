import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { AuthProvider, useAuth } from "./auth";

const STORAGE_KEY = "erp.basicAuth";

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

afterEach(() => {
  localStorage.clear();
});

describe("AuthProvider", () => {
  it("starts without credentials when storage is empty", () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.credentials).toBeNull();
  });

  it("loads credentials from localStorage", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ username: "alice", password: "secret" }));

    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.credentials).toEqual({ username: "alice", password: "secret" });
  });

  it("persists and clears credentials", () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    act(() => {
      result.current.setCredentials({ username: "bob", password: "pw" });
    });

    expect(result.current.credentials).toEqual({ username: "bob", password: "pw" });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify({ username: "bob", password: "pw" }));

    act(() => {
      result.current.clearCredentials();
    });

    expect(result.current.credentials).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
