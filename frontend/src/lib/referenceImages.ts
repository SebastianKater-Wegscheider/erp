import { API_BASE_URL } from "./api";

function apiOrigin(): string {
  return API_BASE_URL.replace(/\/api\/v1\/?$/, "");
}

function normalizeRelPath(value: string): string {
  return value.replace(/^\/+/, "");
}

export function resolveReferenceImageSrc(value?: string | null): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;

  const rel = normalizeRelPath(raw);
  if (rel.startsWith("uploads/master-product-reference/")) {
    const encoded = rel.split("/").map(encodeURIComponent).join("/");
    return `${apiOrigin()}/public/master-product-images/${encoded}`;
  }
  return raw;
}

export function amazonListingUrl(asin?: string | null): string | null {
  const value = (asin ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(value)) return null;
  return `https://www.amazon.de/dp/${value}`;
}
