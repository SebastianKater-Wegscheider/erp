import "@testing-library/jest-dom/vitest";

type StorageRecord = Record<string, string>;

function createMemoryStorage(): Storage {
  let store: StorageRecord = {};

  return {
    get length() {
      return Object.keys(store).length;
    },
    clear() {
      store = {};
    },
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    key(index: number) {
      return Object.keys(store)[index] ?? null;
    },
    removeItem(key: string) {
      delete store[key];
    },
    setItem(key: string, value: string) {
      store[key] = String(value);
    },
  };
}

function ensureStorage(name: "localStorage" | "sessionStorage") {
  const maybeStorage = (globalThis as Record<string, unknown>)[name] as Partial<Storage> | undefined;
  const isValid =
    maybeStorage &&
    typeof maybeStorage.getItem === "function" &&
    typeof maybeStorage.setItem === "function" &&
    typeof maybeStorage.removeItem === "function" &&
    typeof maybeStorage.clear === "function";
  if (isValid) return;
  Object.defineProperty(globalThis, name, {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });
}

ensureStorage("localStorage");
ensureStorage("sessionStorage");
