import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { estimateSellThroughFromBsr, formatSellThroughRange } from "./amazon";

describe("estimateSellThroughFromBsr", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps low BSR to a fast sell-through range", () => {
    vi.setSystemTime(new Date("2026-02-11T12:00:00.000Z"));
    const est = estimateSellThroughFromBsr({
      amazon_rank_specific: 400,
      amazon_offers_count_used_priced_total: 1,
      amazon_last_success_at: "2026-02-11T09:00:00.000Z",
      amazon_blocked_last: false,
    });

    expect(est.speed).toBe("FAST");
    expect(est.confidence).toBe("HIGH");
    expect(formatSellThroughRange(est.range_days)).toBe("1–2 T");
  });

  it("adjusts by offers and caps the factor", () => {
    vi.setSystemTime(new Date("2026-02-11T12:00:00.000Z"));
    const est = estimateSellThroughFromBsr({
      amazon_rank_specific: 50_000,
      amazon_offers_count_used_priced_total: 100,
      amazon_last_success_at: "2026-02-10T12:00:00.000Z",
      amazon_blocked_last: false,
    });

    // base range: 14–45 days; offers factor: sqrt(100)=10 -> capped to 5 => 70–225 days
    expect(est.speed).toBe("VERY_SLOW");
    expect(est.confidence).toBe("HIGH");
    expect(formatSellThroughRange(est.range_days)).toBe("2–8 M");
  });

  it("marks blocked or missing success as low confidence", () => {
    vi.setSystemTime(new Date("2026-02-11T12:00:00.000Z"));
    const estBlocked = estimateSellThroughFromBsr({
      amazon_rank_overall: 10_000,
      amazon_offers_count_total: 3,
      amazon_last_success_at: "2026-02-11T11:59:00.000Z",
      amazon_blocked_last: true,
    });
    expect(estBlocked.confidence).toBe("LOW");

    const estNever = estimateSellThroughFromBsr({
      amazon_rank_overall: 10_000,
      amazon_offers_count_total: 3,
      amazon_last_success_at: null,
      amazon_blocked_last: false,
    });
    expect(estNever.confidence).toBe("LOW");
  });

  it("returns UNKNOWN when no rank is present", () => {
    vi.setSystemTime(new Date("2026-02-11T12:00:00.000Z"));
    const est = estimateSellThroughFromBsr({
      amazon_rank_specific: null,
      amazon_rank_overall: null,
      amazon_offers_count_used_priced_total: 10,
      amazon_last_success_at: "2026-02-11T11:00:00.000Z",
    });
    expect(est.speed).toBe("UNKNOWN");
    expect(est.range_days).toBeNull();
    expect(formatSellThroughRange(est.range_days)).toBe("—");
  });
});
