from __future__ import annotations

from app.core.enums import InventoryStatus
from app.services.inventory import ALLOWED_TRANSITIONS


def test_fba_transition_paths_are_allowed() -> None:
    assert InventoryStatus.FBA_INBOUND in ALLOWED_TRANSITIONS[InventoryStatus.AVAILABLE]
    assert InventoryStatus.FBA_WAREHOUSE in ALLOWED_TRANSITIONS[InventoryStatus.FBA_INBOUND]
    assert InventoryStatus.DISCREPANCY in ALLOWED_TRANSITIONS[InventoryStatus.FBA_INBOUND]
    assert InventoryStatus.SOLD in ALLOWED_TRANSITIONS[InventoryStatus.FBA_WAREHOUSE]


def test_discrepancy_resolution_transitions_are_allowed() -> None:
    allowed = ALLOWED_TRANSITIONS[InventoryStatus.DISCREPANCY]
    assert InventoryStatus.FBA_WAREHOUSE in allowed
    assert InventoryStatus.AVAILABLE in allowed
    assert InventoryStatus.LOST in allowed
