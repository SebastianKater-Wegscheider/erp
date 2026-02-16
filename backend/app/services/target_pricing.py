"""Deterministic per-item target pricing & recommendation engine.

Public API:
- ``market_price_for_condition_cents``  – condition-aware Amazon anchor
- ``used_best_price_cents``            – cheapest used offer
- ``referral_fee_cents``               – half-up referral fee
- ``fba_payout_cents``                 – payout after fees
- ``compute_recommendation``           – full recommendation
- ``compute_effective_price``          – manual-override resolution
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import TYPE_CHECKING

from app.core.enums import EffectiveTargetPriceSource, TargetPriceMode

if TYPE_CHECKING:
    from app.core.config import Settings


# ---------------------------------------------------------------------------
# Shared helpers (extracted from reports.py)
# ---------------------------------------------------------------------------

def used_best_price_cents(
    *,
    price_used_like_new_cents: int | None,
    price_used_very_good_cents: int | None,
    price_used_good_cents: int | None,
    price_used_acceptable_cents: int | None,
) -> int | None:
    values = [
        v
        for v in (
            price_used_like_new_cents,
            price_used_very_good_cents,
            price_used_good_cents,
            price_used_acceptable_cents,
        )
        if isinstance(v, int)
    ]
    return min(values) if values else None


def market_price_for_condition_cents(
    *,
    inventory_condition: str,
    price_new_cents: int | None,
    price_used_like_new_cents: int | None,
    price_used_very_good_cents: int | None,
    price_used_good_cents: int | None,
    price_used_acceptable_cents: int | None,
) -> int | None:
    best_used = used_best_price_cents(
        price_used_like_new_cents=price_used_like_new_cents,
        price_used_very_good_cents=price_used_very_good_cents,
        price_used_good_cents=price_used_good_cents,
        price_used_acceptable_cents=price_used_acceptable_cents,
    )
    condition = inventory_condition.upper().strip()
    if condition == "NEW":
        return price_new_cents if isinstance(price_new_cents, int) else best_used
    if condition == "LIKE_NEW":
        return price_used_like_new_cents if isinstance(price_used_like_new_cents, int) else best_used
    if condition == "GOOD":
        if isinstance(price_used_good_cents, int):
            return price_used_good_cents
        if isinstance(price_used_very_good_cents, int):
            return price_used_very_good_cents
        return best_used
    if condition == "ACCEPTABLE":
        if isinstance(price_used_acceptable_cents, int):
            return price_used_acceptable_cents
        if isinstance(price_used_good_cents, int):
            return price_used_good_cents
        return best_used
    return None


def referral_fee_cents(price_cents: int, referral_fee_bp: int) -> int:
    """Deterministic half-up rounding for basis-point fee calculation."""
    return ((price_cents * referral_fee_bp) + 5_000) // 10_000


def fba_payout_cents(
    *,
    market_price_cents: int,
    referral_fee_bp: int,
    fulfillment_fee_cents: int,
    inbound_shipping_cents: int,
) -> int:
    ref = referral_fee_cents(market_price_cents, referral_fee_bp)
    return market_price_cents - ref - fulfillment_fee_cents - inbound_shipping_cents


# ---------------------------------------------------------------------------
# Recommendation engine
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class TargetPriceRecommendation:
    strategy: str  # always "MARGIN_FIRST" for now
    recommended_target_sell_price_cents: int
    anchor_price_cents: int | None
    anchor_source: str  # "AMAZON_CONDITION" | "NONE"
    rank: int | None
    offers_count: int | None
    adjustment_bp: int
    margin_floor_net_cents: int
    margin_floor_price_cents: int
    summary: str


def _clamp(value: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, value))


def _condition_adjustment_bp(condition: str) -> int:
    c = condition.upper().strip()
    if c == "NEW":
        return 200
    if c == "LIKE_NEW":
        return 100
    if c == "GOOD":
        return 0
    if c == "ACCEPTABLE":
        return -100
    return 0


def _offers_adjustment_bp(
    offers_count: int | None,
    offers_low_max: int,
    offers_high_min: int,
) -> int:
    if offers_count is None:
        return 0
    if offers_count <= offers_low_max:
        return 200
    if offers_count >= offers_high_min:
        return -200
    # Linear interpolation
    ratio = (offers_count - offers_low_max) / (offers_high_min - offers_low_max)
    return round(200 - 400 * ratio)


def _rank_adjustment_bp(
    rank: int | None,
    bsr_strong_max: int,
    bsr_weak_min: int,
) -> int:
    if rank is None:
        return 0
    if rank <= bsr_strong_max:
        return 200
    if rank >= bsr_weak_min:
        return -200
    # Linear interpolation
    ratio = (rank - bsr_strong_max) / (bsr_weak_min - bsr_strong_max)
    return round(200 - 400 * ratio)


def _round_up_to_step(cents: int, step_cents: int = 10) -> int:
    """Round up to the nearest step (default 0.10 EUR = 10 cents)."""
    if cents <= 0:
        return step_cents
    return math.ceil(cents / step_cents) * step_cents


def _gross_from_net_payout(
    target_payout_cents: int,
    referral_fee_bp: int,
    fulfillment_fee_cents: int,
    inbound_shipping_cents: int,
) -> int:
    """Invert the fee formula to find the gross listing price that yields a given payout.

    payout = gross - referral_fee(gross) - fulfillment - inbound
    payout = gross * (1 - referral_fee_bp/10000) - fulfillment - inbound
    gross  = (payout + fulfillment + inbound) / (1 - referral_fee_bp/10000)
    """
    numerator = target_payout_cents + fulfillment_fee_cents + inbound_shipping_cents
    factor = 1.0 - referral_fee_bp / 10_000
    if factor <= 0:
        # Edge case: if referral fee >= 100%, use a safe fallback.
        return numerator * 10
    return math.ceil(numerator / factor)


def compute_recommendation(
    *,
    purchase_price_cents: int,
    allocated_costs_cents: int,
    condition: str,
    price_new_cents: int | None,
    price_used_like_new_cents: int | None,
    price_used_very_good_cents: int | None,
    price_used_good_cents: int | None,
    price_used_acceptable_cents: int | None,
    rank: int | None,
    offers_count: int | None,
    settings: Settings,
) -> TargetPriceRecommendation:
    """Compute the full target-price recommendation for one inventory item."""
    cost_basis = purchase_price_cents + allocated_costs_cents

    # 1. Amazon anchor
    anchor = market_price_for_condition_cents(
        inventory_condition=condition,
        price_new_cents=price_new_cents,
        price_used_like_new_cents=price_used_like_new_cents,
        price_used_very_good_cents=price_used_very_good_cents,
        price_used_good_cents=price_used_good_cents,
        price_used_acceptable_cents=price_used_acceptable_cents,
    )
    has_anchor = anchor is not None

    # 2. Market-signal adjustments (clamped to [-500, +500] bp total)
    adj_condition = _condition_adjustment_bp(condition)
    adj_offers = _offers_adjustment_bp(
        offers_count,
        settings.target_pricing_offers_low_max,
        settings.target_pricing_offers_high_min,
    )
    adj_rank = _rank_adjustment_bp(
        rank,
        settings.target_pricing_bsr_strong_max,
        settings.target_pricing_bsr_weak_min,
    )
    total_adjustment_bp = _clamp(adj_condition + adj_offers + adj_rank, -500, 500)

    adjusted_anchor: int | None = None
    if anchor is not None:
        factor = 1.0 + total_adjustment_bp / 10_000
        adjusted_anchor = max(1, round(anchor * factor))

    # 3. Margin floor
    margin_floor_net = max(
        cost_basis * settings.target_pricing_margin_floor_bp // 10_000,
        settings.target_pricing_margin_floor_min_cents,
    )
    target_payout = cost_basis + margin_floor_net
    floor_price = _gross_from_net_payout(
        target_payout_cents=target_payout,
        referral_fee_bp=settings.amazon_fba_referral_fee_bp,
        fulfillment_fee_cents=settings.amazon_fba_fulfillment_fee_cents,
        inbound_shipping_cents=settings.amazon_fba_inbound_shipping_cents,
    )

    # 4. Recommendation
    if adjusted_anchor is not None:
        recommended = max(adjusted_anchor, floor_price)
        anchor_source = "AMAZON_CONDITION"
    else:
        recommended = floor_price
        anchor_source = "NONE"

    recommended = _round_up_to_step(recommended, 10)

    # 5. Summary
    parts: list[str] = []
    if has_anchor:
        parts.append(f"Anker {anchor!r}¢ ({anchor_source})")
        parts.append(f"Adj {total_adjustment_bp:+d}bp")
    else:
        parts.append("Kein Amazon-Anker")
    parts.append(f"Floor {floor_price}¢ (Marge {margin_floor_net}¢)")
    parts.append(f"→ {recommended}¢")
    summary = " | ".join(parts)

    return TargetPriceRecommendation(
        strategy="MARGIN_FIRST",
        recommended_target_sell_price_cents=recommended,
        anchor_price_cents=anchor,
        anchor_source=anchor_source,
        rank=rank,
        offers_count=offers_count,
        adjustment_bp=total_adjustment_bp,
        margin_floor_net_cents=margin_floor_net,
        margin_floor_price_cents=floor_price,
        summary=summary,
    )


def compute_effective_price(
    *,
    mode: str,
    manual_target_sell_price_cents: int | None,
    recommendation: TargetPriceRecommendation,
) -> tuple[int | None, EffectiveTargetPriceSource]:
    """Resolve the effective target sell price.

    Returns (effective_cents, source).
    """
    if mode == TargetPriceMode.MANUAL and manual_target_sell_price_cents is not None:
        return manual_target_sell_price_cents, EffectiveTargetPriceSource.MANUAL

    rec = recommendation.recommended_target_sell_price_cents
    if recommendation.anchor_price_cents is not None:
        return rec, EffectiveTargetPriceSource.AUTO_AMAZON
    # Cost-floor based
    return rec, EffectiveTargetPriceSource.AUTO_COST_FLOOR
