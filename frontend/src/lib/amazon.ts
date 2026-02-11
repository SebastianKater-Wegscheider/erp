export type AmazonUsedBest = {
  cents: number | null;
  bucket: "USED_LIKE_NEW" | "USED_VERY_GOOD" | "USED_GOOD" | "USED_ACCEPTABLE" | null;
  label: string;
};

export type AmazonFeeProfile = {
  referral_fee_bp: number;
  fulfillment_fee_cents: number;
  inbound_shipping_cents: number;
};

export type SellThroughSpeed = "FAST" | "MEDIUM" | "SLOW" | "VERY_SLOW" | "UNKNOWN";
export type SellThroughConfidence = "HIGH" | "MEDIUM" | "LOW";

export type SellThroughRangeDays = { low: number; high: number };

export type SellThroughEstimate = {
  rank: number | null;
  offers: number | null;
  range_days: SellThroughRangeDays | null;
  speed: SellThroughSpeed;
  confidence: SellThroughConfidence;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function parseIsoMs(value?: string | null): number | null {
  const s = (value ?? "").trim();
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

function baseSellThroughRangeFromRank(rank: number): SellThroughRangeDays {
  if (rank <= 500) return { low: 0.5, high: 2 };
  if (rank <= 2_000) return { low: 1, high: 5 };
  if (rank <= 10_000) return { low: 3, high: 14 };
  if (rank <= 50_000) return { low: 14, high: 45 };
  if (rank <= 200_000) return { low: 45, high: 120 };
  if (rank <= 500_000) return { low: 120, high: 300 };
  return { low: 300, high: 540 };
}

export function estimateSellThroughFromBsr(input: {
  amazon_rank_specific?: number | null;
  amazon_rank_overall?: number | null;
  amazon_offers_count_used_priced_total?: number | null;
  amazon_offers_count_total?: number | null;
  amazon_last_success_at?: string | null;
  amazon_blocked_last?: boolean | null;
}): SellThroughEstimate {
  const rankSpecific = typeof input.amazon_rank_specific === "number" ? input.amazon_rank_specific : null;
  const rankOverall = typeof input.amazon_rank_overall === "number" ? input.amazon_rank_overall : null;
  const rank = (rankSpecific && rankSpecific > 0 ? rankSpecific : null) ?? (rankOverall && rankOverall > 0 ? rankOverall : null);

  const usedOffers = typeof input.amazon_offers_count_used_priced_total === "number" ? input.amazon_offers_count_used_priced_total : null;
  const totalOffers = typeof input.amazon_offers_count_total === "number" ? input.amazon_offers_count_total : null;
  const offersRaw = (usedOffers ?? totalOffers);
  const offers = typeof offersRaw === "number" && Number.isFinite(offersRaw) ? Math.max(1, Math.round(offersRaw)) : null;

  const blocked = !!input.amazon_blocked_last;
  const successMs = parseIsoMs(input.amazon_last_success_at);
  const ageMs = successMs === null ? null : Date.now() - successMs;
  const confidence: SellThroughConfidence =
    blocked || ageMs === null
      ? "LOW"
      : ageMs <= 24 * 60 * 60 * 1000
        ? "HIGH"
        : ageMs <= 72 * 60 * 60 * 1000
          ? "MEDIUM"
          : "LOW";

  if (rank === null) {
    return { rank: null, offers, range_days: null, speed: "UNKNOWN", confidence };
  }

  const base = baseSellThroughRangeFromRank(rank);
  const factor = clamp(Math.sqrt(offers ?? 1), 1, 5);
  const range_days: SellThroughRangeDays = { low: base.low * factor, high: base.high * factor };

  const high = range_days.high;
  const speed: SellThroughSpeed =
    high <= 14 ? "FAST" : high <= 60 ? "MEDIUM" : high <= 180 ? "SLOW" : "VERY_SLOW";

  return { rank, offers, range_days, speed, confidence };
}

export function formatSellThroughRange(range: SellThroughRangeDays | null): string {
  if (!range) return "—";

  function roundRange(low: number, high: number, unit: "T" | "W" | "M"): string {
    const lo = Math.max(1, Math.round(low));
    const hi = Math.max(lo, Math.round(high));
    return lo === hi ? `${lo} ${unit}` : `${lo}–${hi} ${unit}`;
  }

  if (range.high < 14) return roundRange(range.low, range.high, "T");
  if (range.high <= 55) return roundRange(range.low / 7, range.high / 7, "W");
  return roundRange(range.low / 30, range.high / 30, "M");
}

export function computeUsedBest(mp: {
  amazon_price_used_like_new_cents?: number | null;
  amazon_price_used_very_good_cents?: number | null;
  amazon_price_used_good_cents?: number | null;
  amazon_price_used_acceptable_cents?: number | null;
}): AmazonUsedBest {
  const candidates: Array<{ bucket: AmazonUsedBest["bucket"]; label: string; cents: number | null | undefined }> = [
    { bucket: "USED_LIKE_NEW", label: "Wie neu", cents: mp.amazon_price_used_like_new_cents },
    { bucket: "USED_VERY_GOOD", label: "Sehr gut", cents: mp.amazon_price_used_very_good_cents },
    { bucket: "USED_GOOD", label: "Gut", cents: mp.amazon_price_used_good_cents },
    { bucket: "USED_ACCEPTABLE", label: "Akzeptabel", cents: mp.amazon_price_used_acceptable_cents },
  ];

  let best: { bucket: AmazonUsedBest["bucket"]; label: string; cents: number } | null = null;
  for (const c of candidates) {
    if (typeof c.cents !== "number") continue;
    if (!best || c.cents < best.cents) best = { bucket: c.bucket, label: c.label, cents: c.cents };
  }

  if (!best) return { cents: null, bucket: null, label: "—" };
  return { cents: best.cents, bucket: best.bucket, label: best.label };
}

export function estimateMarketPriceForInventoryCondition(
  mp: {
    amazon_price_new_cents?: number | null;
    amazon_price_used_like_new_cents?: number | null;
    amazon_price_used_very_good_cents?: number | null;
    amazon_price_used_good_cents?: number | null;
    amazon_price_used_acceptable_cents?: number | null;
  } | null | undefined,
  inventoryCondition: string,
): { cents: number | null; label: string } {
  if (!mp) return { cents: null, label: "—" };
  const usedBest = computeUsedBest(mp);

  function pickFirst(...cands: Array<{ cents: number | null | undefined; label: string }>) {
    for (const c of cands) {
      if (typeof c.cents === "number") return { cents: c.cents, label: c.label };
    }
    return { cents: usedBest.cents, label: usedBest.cents !== null ? `Used best (${usedBest.label})` : "—" };
  }

  switch ((inventoryCondition ?? "").toUpperCase()) {
    case "NEW":
      return pickFirst({ cents: mp.amazon_price_new_cents, label: "Neu" });
    case "LIKE_NEW":
      return pickFirst({ cents: mp.amazon_price_used_like_new_cents, label: "Wie neu" });
    case "GOOD":
      return pickFirst(
        { cents: mp.amazon_price_used_good_cents, label: "Gut" },
        { cents: mp.amazon_price_used_very_good_cents, label: "Sehr gut" },
      );
    case "ACCEPTABLE":
      return pickFirst(
        { cents: mp.amazon_price_used_acceptable_cents, label: "Akzeptabel" },
        { cents: mp.amazon_price_used_good_cents, label: "Gut" },
      );
    case "DEFECT":
    default:
      return { cents: null, label: "—" };
  }
}

export function estimateFbaPayout(
  marketCents: number | null,
  feeProfile: AmazonFeeProfile,
): { payout_cents: number | null; fees_cents: number | null; referral_fee_cents: number | null } {
  if (typeof marketCents !== "number") return { payout_cents: null, fees_cents: null, referral_fee_cents: null };
  const referral = Math.round((marketCents * feeProfile.referral_fee_bp) / 10_000);
  const fees = referral + feeProfile.fulfillment_fee_cents + feeProfile.inbound_shipping_cents;
  return { payout_cents: marketCents - fees, fees_cents: fees, referral_fee_cents: referral };
}

export function estimateMargin(payoutCents: number | null, costBasisCents: number | null): number | null {
  if (typeof payoutCents !== "number") return null;
  if (typeof costBasisCents !== "number") return null;
  return payoutCents - costBasisCents;
}
