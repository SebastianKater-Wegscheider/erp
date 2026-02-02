from __future__ import annotations

import pytest

from app.services.vat import allocate_proportional, margin_components


def test_allocate_proportional_sum_invariant() -> None:
    alloc = allocate_proportional(total_cents=100, weights=[1, 1, 1])
    assert sum(alloc) == 100
    assert len(alloc) == 3
    assert all(x >= 0 for x in alloc)


def test_allocate_proportional_zero_weights_spreads_evenly() -> None:
    alloc = allocate_proportional(total_cents=5, weights=[0, 0])
    assert alloc in ([3, 2], [2, 3])
    assert sum(alloc) == 5


@pytest.mark.parametrize(
    ("total", "weights"),
    [
        (0, []),
        (0, [1, 2, 3]),
        (10, [10]),
        (10, [9, 1]),
        (10, [1, 9]),
    ],
)
def test_allocate_proportional_does_not_lose_cents(total: int, weights: list[int]) -> None:
    alloc = allocate_proportional(total_cents=total, weights=weights)
    assert sum(alloc) == total


def test_margin_components_positive_margin() -> None:
    mc = margin_components(consideration_gross_cents=1200, cost_cents=1000, tax_rate_bp=2000)
    assert mc.margin_gross_cents == 200
    assert mc.margin_tax_cents == 33
    assert mc.margin_net_cents == 167


def test_margin_components_negative_margin_has_no_vat() -> None:
    mc = margin_components(consideration_gross_cents=900, cost_cents=1000, tax_rate_bp=2000)
    assert mc.margin_gross_cents == -100
    assert mc.margin_tax_cents == 0
    assert mc.margin_net_cents == -100

