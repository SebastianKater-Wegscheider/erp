from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import InventoryStatus
from app.models.inventory_item import InventoryItem
from app.services.audit import audit_log


ALLOWED_TRANSITIONS: dict[InventoryStatus, set[InventoryStatus]] = {
    InventoryStatus.DRAFT: {InventoryStatus.AVAILABLE, InventoryStatus.LOST},
    InventoryStatus.AVAILABLE: {
        InventoryStatus.RESERVED,
        InventoryStatus.SOLD,
        InventoryStatus.LOST,
        InventoryStatus.FBA_INBOUND,
    },
    InventoryStatus.RESERVED: {InventoryStatus.AVAILABLE, InventoryStatus.SOLD},
    InventoryStatus.SOLD: {InventoryStatus.RETURNED},
    InventoryStatus.RETURNED: {InventoryStatus.AVAILABLE, InventoryStatus.LOST},
    InventoryStatus.FBA_INBOUND: {
        InventoryStatus.FBA_WAREHOUSE,
        InventoryStatus.DISCREPANCY,
        InventoryStatus.LOST,
        InventoryStatus.AVAILABLE,
    },
    InventoryStatus.FBA_WAREHOUSE: {
        InventoryStatus.SOLD,
        InventoryStatus.DISCREPANCY,
        InventoryStatus.LOST,
        InventoryStatus.AVAILABLE,
    },
    InventoryStatus.DISCREPANCY: {
        InventoryStatus.FBA_WAREHOUSE,
        InventoryStatus.LOST,
        InventoryStatus.AVAILABLE,
    },
    InventoryStatus.LOST: set(),
}


async def transition_status(
    session: AsyncSession,
    *,
    actor: str,
    item: InventoryItem,
    new_status: InventoryStatus,
) -> None:
    if new_status == item.status:
        return
    allowed = ALLOWED_TRANSITIONS.get(item.status, set())
    if new_status not in allowed:
        raise ValueError(f"Invalid status transition: {item.status} -> {new_status}")

    before = {"status": item.status}
    item.status = new_status
    await audit_log(
        session,
        actor=actor,
        entity_type="inventory_item",
        entity_id=item.id,
        action="status_change",
        before=before,
        after={"status": new_status},
    )
