import { useAuth } from "./auth";

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

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

export async function validateBasicAuth(
  credentials: { username: string; password: string },
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/reports/tax-profile`, {
    headers: {
      Authorization: basicAuthHeader(credentials.username, credentials.password),
    },
    signal,
  });
  if (!res.ok) {
    throw new ApiError("Ungültige Zugangsdaten", res.status);
  }
}

export function useApi() {
  const { credentials, clearCredentials } = useAuth();

  async function request<T>(
    path: string,
    options: RequestInit & { json?: unknown } = {},
  ): Promise<T> {
    const headers = new Headers(options.headers);
    if (credentials) {
      headers.set("Authorization", basicAuthHeader(credentials.username, credentials.password));
    }
    if (options.json !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers,
      body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
    });

    const contentType = res.headers.get("content-type") ?? "";
    const isJson = contentType.includes("application/json");

    if (!res.ok) {
      const detail = isJson ? await res.json().catch(() => undefined) : await res.text().catch(() => undefined);
      const msg = typeof detail === "object" && detail && "detail" in (detail as any) ? (detail as any).detail : res.statusText;
      if (res.status === 401 && credentials) {
        clearCredentials();
      }
      throw new ApiError(String(msg || "Anfrage fehlgeschlagen"), res.status, detail);
    }

    if (res.status === 204) return undefined as T;
    if (isJson) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  }

  async function fileBlob(relPath: string): Promise<Blob> {
    const headers = new Headers();
    if (credentials) {
      headers.set("Authorization", basicAuthHeader(credentials.username, credentials.password));
    }
    const safeRel = relPath.replace(/^\/+/, "");
    // Cache-bust because PDFs may be regenerated but keep the same path.
    const url = `${API_BASE_URL}/files/${safeRel}?t=${Date.now()}`;
    const res = await fetch(url, { headers, cache: "no-store" });
    if (!res.ok) throw new ApiError("Download fehlgeschlagen", res.status);
    return await res.blob();
  }

  async function download(relPath: string, filename?: string): Promise<void> {
    const blob = await fileBlob(relPath);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename ?? relPath.split("/").pop() ?? "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return { request, fileBlob, download };
}
