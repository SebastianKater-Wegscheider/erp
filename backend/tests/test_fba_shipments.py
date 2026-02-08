from __future__ import annotations

import uuid

from app.core.enums import FBACostDistributionMethod
from app.services.fba_shipments import distribute_shipping_costs


def test_distribute_shipping_costs_equal_is_deterministic_and_exact() -> None:
    ids = [uuid.UUID(int=3), uuid.UUID(int=1), uuid.UUID(int=2)]
    out = distribute_shipping_costs(
        item_ids=ids,
        total_cents=10,
        method=FBACostDistributionMethod.EQUAL,
        purchase_price_by_item_id={},
    )

    assert sum(out.values()) == 10
    # Sorted order is UUID 1,2,3 -> remainder cents go to first item.
    assert out[uuid.UUID(int=1)] == 4
    assert out[uuid.UUID(int=2)] == 3
    assert out[uuid.UUID(int=3)] == 3


def test_distribute_shipping_costs_weighted_uses_purchase_price_weights() -> None:
    i1 = uuid.UUID(int=1)
    i2 = uuid.UUID(int=2)
    i3 = uuid.UUID(int=3)
    out = distribute_shipping_costs(
        item_ids=[i1, i2, i3],
        total_cents=100,
        method=FBACostDistributionMethod.PURCHASE_PRICE_WEIGHTED,
        purchase_price_by_item_id={i1: 1000, i2: 2000, i3: 7000},
    )

    assert sum(out.values()) == 100
    assert out[i3] > out[i2] > out[i1]


def test_distribute_shipping_costs_weighted_falls_back_to_equal_for_zero_weights() -> None:
    i1 = uuid.UUID(int=11)
    i2 = uuid.UUID(int=12)

    out = distribute_shipping_costs(
        item_ids=[i1, i2],
        total_cents=5,
        method=FBACostDistributionMethod.PURCHASE_PRICE_WEIGHTED,
        purchase_price_by_item_id={i1: 0, i2: 0},
    )

    assert out[i1] == 3
    assert out[i2] == 2
    assert sum(out.values()) == 5
