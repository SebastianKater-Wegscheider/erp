import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, API_BASE_URL, useApi } from "./api";
import { AuthProvider } from "./auth";

const STORAGE_KEY = "erp.basicAuth";

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("useApi", () => {
  it("sends auth header and json body", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ username: "alice", password: "secret" }));

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useApi(), { wrapper });
    const out = await result.current.request<{ ok: boolean }>("/health", {
      method: "POST",
      json: { a: 1 },
    });

    expect(out).toEqual({ ok: true });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/health`);
    expect(options.body).toBe(JSON.stringify({ a: 1 }));

    const headers = new Headers(options.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toMatch(/^Basic\s+/);
  });

  it("raises ApiError with backend detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "Conflict" }), {
        status: 409,
        statusText: "Conflict",
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useApi(), { wrapper });

    await expect(result.current.request("/x")).rejects.toMatchObject({
      message: "Conflict",
      status: 409,
    } satisfies Partial<ApiError>);
  });

  it("downloads blobs through the files endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("pdf", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useApi(), { wrapper });
    const blob = await result.current.fileBlob("/uploads/test.pdf");

    expect(blob.size).toBe(3);
    expect(blob.type).toBe("application/pdf");

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(new RegExp(`^${API_BASE_URL}/files/uploads/test\\.pdf\\?t=\\d+$`));
    expect(options.cache).toBe("no-store");
  });
});
