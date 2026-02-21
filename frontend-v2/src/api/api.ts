import { useMemo } from "react";

import { useAuth, type Credentials } from "../auth/auth";

export class ApiError extends Error {
  status: number;
  detail?: unknown;

  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000/api/v1";

export function basicAuthHeader(credentials: Credentials): string {
  return `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`;
}

export async function validateBasicAuth(credentials: Credentials, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/reports/tax-profile`, {
    headers: { Authorization: basicAuthHeader(credentials) },
    signal,
  });
  if (!res.ok) throw new ApiError("Ungültige Zugangsdaten", res.status);
}

async function requestInternal<T>(
  path: string,
  options: RequestInit & { json?: unknown } = {},
  credentials: Credentials | null,
  onUnauthorized?: () => void,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (credentials) headers.set("Authorization", basicAuthHeader(credentials));
  if (options.json !== undefined) headers.set("Content-Type", "application/json");

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
  });

  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");

  if (!res.ok) {
    const detail = isJson ? await res.json().catch(() => undefined) : await res.text().catch(() => undefined);
    const msg =
      typeof detail === "object" && detail && "detail" in (detail as any) ? (detail as any).detail : res.statusText;
    if (res.status === 401) onUnauthorized?.();
    throw new ApiError(String(msg || "Anfrage fehlgeschlagen"), res.status, detail);
  }

  if (res.status === 204) return undefined as T;
  if (isJson) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export function useApi() {
  const { credentials, logout } = useAuth();

  return useMemo(
    () => ({
      request: <T,>(path: string, options?: RequestInit & { json?: unknown }) =>
        requestInternal<T>(path, options, credentials, logout),
    }),
    [credentials, logout],
  );
}

