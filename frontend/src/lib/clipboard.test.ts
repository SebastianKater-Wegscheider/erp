import { describe, expect, it, vi } from "vitest";

import { copyToClipboard } from "./clipboard";

describe("clipboard", () => {
  it("returns false for empty values", async () => {
    await expect(copyToClipboard("   ")).resolves.toBe(false);
  });

  it("uses navigator clipboard when available", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await expect(copyToClipboard("  IT-123  ")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("IT-123");
  });

  it("falls back to document.execCommand when navigator clipboard fails", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    await expect(copyToClipboard("fallback-copy")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });
});
