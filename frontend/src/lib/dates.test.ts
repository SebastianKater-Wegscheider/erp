import { describe, expect, it, vi } from "vitest";

import { formatDateEuFromIso, parseDateEuToIso, todayIsoLocal } from "./dates";

describe("todayIsoLocal", () => {
  it("uses local calendar date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-08T11:22:33"));

    expect(todayIsoLocal()).toBe("2026-02-08");

    vi.useRealTimers();
  });
});

describe("formatDateEuFromIso", () => {
  it("formats ISO dates", () => {
    expect(formatDateEuFromIso("2026-02-08")).toBe("08.02.2026");
  });

  it("returns input unchanged for invalid format", () => {
    expect(formatDateEuFromIso("08/02/2026")).toBe("08/02/2026");
  });
});

describe("parseDateEuToIso", () => {
  it("parses EU date formats", () => {
    expect(parseDateEuToIso("8.2.2026")).toBe("2026-02-08");
    expect(parseDateEuToIso("08-02-2026")).toBe("2026-02-08");
    expect(parseDateEuToIso("2026-02-08")).toBe("2026-02-08");
  });

  it("rejects invalid calendar values", () => {
    expect(parseDateEuToIso("31.02.2026")).toBeNull();
    expect(parseDateEuToIso("13.13.2026")).toBeNull();
    expect(parseDateEuToIso("01.01.1800")).toBeNull();
  });
});
