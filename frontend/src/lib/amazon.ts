export type AmazonUsedBest = {
  cents: number | null;
  bucket: "USED_LIKE_NEW" | "USED_VERY_GOOD" | "USED_GOOD" | "USED_ACCEPTABLE" | null;
  label: string;
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

