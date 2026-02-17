import { describe, expect, it } from "vitest";

import { normalizeChoice, readStoredChoice, writeStorageItem } from "./browserStorage";

describe("browserStorage", () => {
  it("normalizes only allowed values", () => {
    expect(normalizeChoice("overview", ["overview", "ops"] as const)).toBe("overview");
    expect(normalizeChoice("invalid", ["overview", "ops"] as const)).toBeNull();
    expect(normalizeChoice(null, ["overview", "ops"] as const)).toBeNull();
  });

  it("reads and validates persisted choices", () => {
    window.localStorage.setItem("test:view", "ops");
    expect(readStoredChoice("test:view", ["overview", "ops"] as const)).toBe("ops");

    window.localStorage.setItem("test:view", "nope");
    expect(readStoredChoice("test:view", ["overview", "ops"] as const)).toBeNull();
  });

  it("returns false if write fails", () => {
    const original = window.localStorage.setItem;
    Object.defineProperty(window.localStorage, "setItem", {
      configurable: true,
      value: () => {
        throw new Error("blocked");
      },
    });
    expect(writeStorageItem("test:key", "value")).toBe(false);
    Object.defineProperty(window.localStorage, "setItem", {
      configurable: true,
      value: original,
    });
  });
});
