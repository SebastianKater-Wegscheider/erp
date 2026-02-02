from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP


def split_gross_to_net_and_tax(*, gross_cents: int, tax_rate_bp: int) -> tuple[int, int]:
    """
    Integer-only VAT split.

    tax_rate_bp: basis points (e.g. 2000 = 20%).
    """
    if gross_cents < 0:
        raise ValueError("gross_cents must be >= 0")
    if tax_rate_bp < 0:
        raise ValueError("tax_rate_bp must be >= 0")

    if tax_rate_bp == 0:
        return gross_cents, 0

    den = 10_000 + tax_rate_bp
    net = (gross_cents * 10_000 + den // 2) // den
    tax = gross_cents - net
    return net, tax


def meters_from_km(km: Decimal) -> int:
    meters = (km * Decimal("1000")).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return int(meters)


def mileage_amount_cents(*, distance_meters: int, rate_cents_per_km: int) -> int:
    if distance_meters < 0:
        raise ValueError("distance_meters must be >= 0")
    if rate_cents_per_km < 0:
        raise ValueError("rate_cents_per_km must be >= 0")
    return (distance_meters * rate_cents_per_km + 500) // 1000


def format_eur(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    cents_abs = abs(cents)
    euros = cents_abs // 100
    rest = cents_abs % 100
    return f"{sign}{euros},{rest:02d}"
