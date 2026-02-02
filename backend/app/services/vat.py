from __future__ import annotations

from dataclasses import dataclass

from app.services.money import split_gross_to_net_and_tax


def allocate_proportional(*, total_cents: int, weights: list[int]) -> list[int]:
    """
    Allocate `total_cents` proportionally across `weights`.

    - Returns a list with same length as weights.
    - Sum(result) == total_cents
    - Deterministic: ties are resolved by original index order.
    """
    if total_cents < 0:
        raise ValueError("total_cents must be >= 0")
    if any(w < 0 for w in weights):
        raise ValueError("weights must be >= 0")

    n = len(weights)
    if n == 0:
        return []

    total_weight = sum(weights)
    if total_weight == 0:
        base = total_cents // n
        rem = total_cents - base * n
        out = [base] * n
        for i in range(rem):
            out[i] += 1
        return out

    shares: list[int] = []
    remainders: list[int] = []
    allocated = 0
    for w in weights:
        num = total_cents * w
        share = num // total_weight
        shares.append(int(share))
        allocated += int(share)
        remainders.append(int(num % total_weight))

    remainder = total_cents - allocated
    if remainder:
        indices = sorted(range(n), key=lambda i: remainders[i], reverse=True)
        for i in indices[:remainder]:
            shares[i] += 1

    return shares


@dataclass(frozen=True)
class MarginComponents:
    margin_gross_cents: int
    margin_net_cents: int
    margin_tax_cents: int


def margin_components(*, consideration_gross_cents: int, cost_cents: int, tax_rate_bp: int) -> MarginComponents:
    """
    Margin scheme (Differenzbesteuerung): VAT is computed from the margin (gross).

    If margin is <= 0, VAT is 0.
    """
    if tax_rate_bp < 0:
        raise ValueError("tax_rate_bp must be >= 0")

    margin_gross = consideration_gross_cents - cost_cents
    if margin_gross <= 0 or tax_rate_bp == 0:
        return MarginComponents(margin_gross_cents=margin_gross, margin_net_cents=margin_gross, margin_tax_cents=0)

    net, tax = split_gross_to_net_and_tax(gross_cents=margin_gross, tax_rate_bp=tax_rate_bp)
    return MarginComponents(margin_gross_cents=margin_gross, margin_net_cents=net, margin_tax_cents=tax)

