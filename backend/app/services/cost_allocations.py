from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cost_allocation import CostAllocation, CostAllocationLine
from app.models.inventory_item import InventoryItem
from app.models.ledger_entry import LedgerEntry
from app.schemas.cost_allocation import CostAllocationCreate
from app.services.audit import audit_log


async def create_cost_allocation(session: AsyncSession, *, actor: str, data: CostAllocationCreate) -> CostAllocation:
    if sum(line.amount_cents for line in data.lines) != data.amount_cents:
        raise ValueError("Sum(lines.amount_cents) must equal amount_cents")

    allocation = CostAllocation(
        allocation_date=data.allocation_date,
        description=data.description,
        amount_cents=data.amount_cents,
        payment_source=data.payment_source,
        receipt_upload_path=data.receipt_upload_path,
    )
    session.add(allocation)
    await session.flush()

    for line in data.lines:
        item = await session.get(InventoryItem, line.inventory_item_id)
        if item is None:
            raise ValueError(f"Inventory item not found: {line.inventory_item_id}")

        session.add(
            CostAllocationLine(
                allocation_id=allocation.id,
                inventory_item_id=item.id,
                amount_cents=line.amount_cents,
            )
        )

        before = {"allocated_costs_cents": item.allocated_costs_cents}
        item.allocated_costs_cents += line.amount_cents
        await audit_log(
            session,
            actor=actor,
            entity_type="inventory_item",
            entity_id=item.id,
            action="allocate_cost",
            before=before,
            after={"allocated_costs_cents": item.allocated_costs_cents},
        )

    session.add(
        LedgerEntry(
            entry_date=data.allocation_date,
            account=data.payment_source,
            amount_cents=-data.amount_cents,
            entity_type="cost_allocation",
            entity_id=allocation.id,
            memo=data.description[:500],
        )
    )

    await audit_log(
        session,
        actor=actor,
        entity_type="cost_allocation",
        entity_id=allocation.id,
        action="create",
        after={"amount_cents": allocation.amount_cents, "payment_source": allocation.payment_source},
    )

    return allocation
