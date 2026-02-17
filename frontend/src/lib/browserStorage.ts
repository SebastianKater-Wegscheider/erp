export function normalizeChoice<T extends string>(value: string | null | undefined, allowed: readonly T[]): T | null {
  if (!value) return null;
  for (const option of allowed) {
    if (value === option) return option;
  }
  return null;
}

export function readStorageItem(key: string): string | null {
  if (typeof window === "undefined") return null;
  const getItem = window.localStorage?.getItem;
  if (typeof getItem !== "function") return null;
  try {
    return getItem.call(window.localStorage, key);
  } catch {
    return null;
  }
}

export function writeStorageItem(key: string, value: string): boolean {
  if (typeof window === "undefined") return false;
  const setItem = window.localStorage?.setItem;
  if (typeof setItem !== "function") return false;
  try {
    setItem.call(window.localStorage, key, value);
    return true;
  } catch {
    return false;
  }
}

export function readStoredChoice<T extends string>(key: string, allowed: readonly T[]): T | null {
  return normalizeChoice(readStorageItem(key), allowed);
}
