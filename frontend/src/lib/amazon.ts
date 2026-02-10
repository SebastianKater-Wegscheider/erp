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
