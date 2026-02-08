import { describe, expect, it } from "vitest";

import { formatEur, parseEurToCents } from "./money";

describe("formatEur", () => {
  it("formats positive and negative cents", () => {
    expect(formatEur(0)).toBe("0,00");
    expect(formatEur(1)).toBe("0,01");
    expect(formatEur(12_345)).toBe("123,45");
    expect(formatEur(-5)).toBe("-0,05");
  });
});

describe("parseEurToCents", () => {
  it("parses decimal and comma formats", () => {
    expect(parseEurToCents("123,45")).toBe(12_345);
    expect(parseEurToCents("123.4")).toBe(12_340);
    expect(parseEurToCents("-0,05")).toBe(-5);
    expect(parseEurToCents(" 1 234,56 ")).toBe(123_456);
  });

  it("returns zero for empty input", () => {
    expect(parseEurToCents("  ")).toBe(0);
  });

  it("rejects invalid values", () => {
    expect(() => parseEurToCents("abc")).toThrow("Ungültiger EUR-Betrag");
    expect(() => parseEurToCents("12,345")).toThrow("Ungültiger EUR-Betrag");
  });
});
