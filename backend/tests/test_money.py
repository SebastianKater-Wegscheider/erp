from __future__ import annotations

from decimal import Decimal

import pytest

from app.services.money import format_eur, mileage_amount_cents, meters_from_km, parse_eur_to_cents, split_gross_to_net_and_tax


def test_split_gross_to_net_and_tax_exact_20_percent() -> None:
    net, tax = split_gross_to_net_and_tax(gross_cents=120, tax_rate_bp=2000)
    assert net == 100
    assert tax == 20


@pytest.mark.parametrize("gross", [1, 2, 3, 10, 99, 119, 121, 199, 999, 10_001])
def test_split_gross_to_net_and_tax_invariant(gross: int) -> None:
    net, tax = split_gross_to_net_and_tax(gross_cents=gross, tax_rate_bp=2000)
    assert net + tax == gross
    assert net >= 0
    assert tax >= 0


def test_split_gross_to_net_and_tax_zero_rate() -> None:
    net, tax = split_gross_to_net_and_tax(gross_cents=12345, tax_rate_bp=0)
    assert net == 12345
    assert tax == 0


def test_format_eur() -> None:
    assert format_eur(0) == "0,00"
    assert format_eur(1) == "0,01"
    assert format_eur(10) == "0,10"
    assert format_eur(12345) == "123,45"
    assert format_eur(-1) == "-0,01"


def test_meters_from_km_round_half_up() -> None:
    assert meters_from_km(Decimal("1")) == 1000
    assert meters_from_km(Decimal("1.234")) == 1234
    assert meters_from_km(Decimal("0.0005")) == 1
    assert meters_from_km(Decimal("0.0004")) == 0


def test_mileage_amount_cents_round_half_up() -> None:
    assert mileage_amount_cents(distance_meters=1000, rate_cents_per_km=42) == 42
    assert mileage_amount_cents(distance_meters=1500, rate_cents_per_km=42) == 63


def test_parse_eur_to_cents() -> None:
    assert parse_eur_to_cents("") == 0
    assert parse_eur_to_cents("  ") == 0
    assert parse_eur_to_cents("0") == 0
    assert parse_eur_to_cents("0,01") == 1
    assert parse_eur_to_cents("123,45") == 12_345
    assert parse_eur_to_cents("123.4") == 12_340
    assert parse_eur_to_cents("-0,05") == -5
    assert parse_eur_to_cents(" 1 234,56 ") == 123_456

    with pytest.raises(ValueError):
        parse_eur_to_cents("abc")
    with pytest.raises(ValueError):
        parse_eur_to_cents("12,345")
