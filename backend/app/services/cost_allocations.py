from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import InventoryStatus
from app.core.config import get_settings
from app.models.cost_allocation import CostAllocation, CostAllocationLine
from app.models.inventory_item import InventoryItem
from app.models.ledger_entry import LedgerEntry
from app.schemas.cost_allocation import CostAllocationCreate
from app.services.audit import audit_log
from app.services.money import split_gross_to_net_and_tax


async def create_cost_allocation(session: AsyncSession, *, actor: str, data: CostAllocationCreate) -> CostAllocation:
    if sum(line.amount_cents for line in data.lines) != data.amount_cents:
        raise ValueError("Sum(lines.amount_cents) must equal amount_cents")

    settings = get_settings()
    tax_rate_bp = data.tax_rate_bp if settings.vat_enabled else 0
    input_tax_deductible = data.input_tax_deductible if settings.vat_enabled else False

    line_splits: list[tuple[int, int]] = []
    total_net = 0
    total_tax = 0
    for line in data.lines:
        net, tax = split_gross_to_net_and_tax(gross_cents=line.amount_cents, tax_rate_bp=tax_rate_bp)
        line_splits.append((net, tax))
        total_net += net
        total_tax += tax

    allocation = CostAllocation(
        allocation_date=data.allocation_date,
        description=data.description,
        amount_cents=data.amount_cents,
        amount_net_cents=total_net,
        amount_tax_cents=total_tax,
        tax_rate_bp=tax_rate_bp,
        input_tax_deductible=input_tax_deductible,
        payment_source=data.payment_source,
        receipt_upload_path=data.receipt_upload_path,
    )
    session.add(allocation)
    await session.flush()

    for line, (line_net, line_tax) in zip(data.lines, line_splits, strict=True):
        item = await session.get(InventoryItem, line.inventory_item_id)
        if item is None:
            raise ValueError(f"Inventory item not found: {line.inventory_item_id}")
        if item.status in (InventoryStatus.SOLD, InventoryStatus.LOST):
            raise ValueError(f"Cannot allocate costs to item {item.id} with status {item.status}")

        session.add(
            CostAllocationLine(
                allocation_id=allocation.id,
                inventory_item_id=item.id,
                amount_cents=line.amount_cents,
                amount_net_cents=line_net,
                amount_tax_cents=line_tax,
            )
        )

        cost_increment = line_net if input_tax_deductible else line.amount_cents
        before = {"allocated_costs_cents": item.allocated_costs_cents}
        item.allocated_costs_cents += cost_increment
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
        after={
            "amount_cents": allocation.amount_cents,
            "amount_net_cents": allocation.amount_net_cents,
            "amount_tax_cents": allocation.amount_tax_cents,
            "tax_rate_bp": allocation.tax_rate_bp,
            "input_tax_deductible": allocation.input_tax_deductible,
            "payment_source": allocation.payment_source,
        },
    )

    return allocation
