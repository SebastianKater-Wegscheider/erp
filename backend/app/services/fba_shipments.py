from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.enums import FBACostDistributionMethod, FBAShipmentStatus, InventoryStatus
from app.models.fba_shipment import FBAShipment, FBAShipmentItem
from app.models.inventory_item import InventoryItem
from app.schemas.fba_shipment import FBAShipmentCreate, FBAShipmentReceive, FBAShipmentUpdateDraft
from app.services.audit import audit_log
from app.services.inventory import transition_status


def distribute_shipping_costs(
    *,
    item_ids: list[uuid.UUID],
    total_cents: int,
    method: FBACostDistributionMethod,
    purchase_price_by_item_id: dict[uuid.UUID, int],
) -> dict[uuid.UUID, int]:
    if not item_ids:
        return {}
    if total_cents <= 0:
        return {item_id: 0 for item_id in item_ids}

    # Keep allocation deterministic to avoid noisy diffs in financial data.
    ordered = sorted(item_ids, key=str)

    if method == FBACostDistributionMethod.EQUAL:
        base = total_cents // len(ordered)
        remainder = total_cents - (base * len(ordered))
        out = {item_id: base for item_id in ordered}
        for item_id in ordered[:remainder]:
            out[item_id] += 1
        return out

    weights = {item_id: max(0, int(purchase_price_by_item_id.get(item_id, 0))) for item_id in ordered}
    weight_sum = sum(weights.values())
    if weight_sum <= 0:
        return distribute_shipping_costs(
            item_ids=ordered,
            total_cents=total_cents,
            method=FBACostDistributionMethod.EQUAL,
            purchase_price_by_item_id=purchase_price_by_item_id,
        )

    floor_allocs: dict[uuid.UUID, int] = {}
    remainders: list[tuple[int, str, uuid.UUID]] = []
    allocated = 0
    for item_id in ordered:
        weight = weights[item_id]
        numerator = total_cents * weight
        floor_share = numerator // weight_sum
        rem = numerator % weight_sum
        floor_allocs[item_id] = int(floor_share)
        remainders.append((int(rem), str(item_id), item_id))
        allocated += int(floor_share)

    missing = total_cents - allocated
    remainders.sort(key=lambda x: (-x[0], x[1]))
    for _, _, item_id in remainders[:missing]:
        floor_allocs[item_id] += 1

    return floor_allocs


async def _validate_item_ids_for_draft(
    session: AsyncSession,
    *,
    item_ids: list[uuid.UUID],
    current_shipment_id: uuid.UUID | None,
) -> dict[uuid.UUID, InventoryItem]:
    if not item_ids:
        return {}

    rows = (
        await session.execute(select(InventoryItem).where(InventoryItem.id.in_(item_ids)))
    ).scalars().all()
    item_by_id = {item.id: item for item in rows}

    missing = [item_id for item_id in item_ids if item_id not in item_by_id]
    if missing:
        raise ValueError(f"Inventory item not found: {missing[0]}")

    for item_id in item_ids:
        item = item_by_id[item_id]
        if item.status != InventoryStatus.AVAILABLE:
            raise ValueError(f"Inventory item not AVAILABLE: {item.id} (status={item.status})")

        stmt = (
            select(FBAShipmentItem.id)
            .join(FBAShipment, FBAShipment.id == FBAShipmentItem.shipment_id)
            .where(
                FBAShipmentItem.inventory_item_id == item_id,
                FBAShipment.status.in_([FBAShipmentStatus.DRAFT, FBAShipmentStatus.SHIPPED]),
            )
        )
        if current_shipment_id:
            stmt = stmt.where(FBAShipment.id != current_shipment_id)
        already_assigned = (await session.execute(stmt.limit(1))).scalar_one_or_none()
        if already_assigned is not None:
            raise ValueError(f"Inventory item already assigned to active FBA shipment: {item.id}")

    return item_by_id


async def create_fba_shipment(session: AsyncSession, *, actor: str, data: FBAShipmentCreate) -> FBAShipment:
    item_ids = list(data.item_ids)
    await _validate_item_ids_for_draft(session, item_ids=item_ids, current_shipment_id=None)

    shipment = FBAShipment(
        name=data.name,
        status=FBAShipmentStatus.DRAFT,
        carrier=data.carrier,
        tracking_number=data.tracking_number,
        shipping_cost_cents=data.shipping_cost_cents,
        cost_distribution_method=data.cost_distribution_method,
    )
    session.add(shipment)
    await session.flush()

    for item_id in item_ids:
        session.add(FBAShipmentItem(shipment_id=shipment.id, inventory_item_id=item_id))

    await audit_log(
        session,
        actor=actor,
        entity_type="fba_shipment",
        entity_id=shipment.id,
        action="create",
        after={
            "name": shipment.name,
            "status": shipment.status,
            "items_count": len(item_ids),
            "shipping_cost_cents": shipment.shipping_cost_cents,
            "cost_distribution_method": shipment.cost_distribution_method,
        },
    )

    return shipment


async def get_fba_shipment_or_raise(session: AsyncSession, shipment_id: uuid.UUID) -> FBAShipment:
    shipment = (
        await session.execute(
            select(FBAShipment)
            .where(FBAShipment.id == shipment_id)
            .options(selectinload(FBAShipment.items))
        )
    ).scalar_one_or_none()
    if shipment is None:
        raise ValueError("FBA shipment not found")
    return shipment


async def update_fba_shipment_draft(
    session: AsyncSession,
    *,
    actor: str,
    shipment_id: uuid.UUID,
    data: FBAShipmentUpdateDraft,
) -> FBAShipment:
    shipment = await get_fba_shipment_or_raise(session, shipment_id)
    if shipment.status != FBAShipmentStatus.DRAFT:
        raise ValueError("Only DRAFT shipments can be edited")

    before = {
        "name": shipment.name,
        "carrier": shipment.carrier,
        "tracking_number": shipment.tracking_number,
        "shipping_cost_cents": shipment.shipping_cost_cents,
        "cost_distribution_method": shipment.cost_distribution_method,
        "items_count": len(shipment.items),
    }

    patch = data.model_dump(exclude_unset=True)
    if "name" in patch:
        shipment.name = patch["name"]
    if "shipping_cost_cents" in patch:
        shipment.shipping_cost_cents = int(patch["shipping_cost_cents"])
    if "cost_distribution_method" in patch:
        shipment.cost_distribution_method = patch["cost_distribution_method"]
    if "carrier" in patch:
        shipment.carrier = patch["carrier"]
    if "tracking_number" in patch:
        shipment.tracking_number = patch["tracking_number"]

    if data.item_ids is not None:
        item_ids = list(data.item_ids)
        await _validate_item_ids_for_draft(session, item_ids=item_ids, current_shipment_id=shipment.id)

        current_by_item_id = {line.inventory_item_id: line for line in shipment.items}
        new_ids = set(item_ids)

        for inv_item_id, line in current_by_item_id.items():
            if inv_item_id not in new_ids:
                await session.delete(line)

        for inv_item_id in item_ids:
            if inv_item_id not in current_by_item_id:
                session.add(FBAShipmentItem(shipment_id=shipment.id, inventory_item_id=inv_item_id))

    await session.flush()

    shipment = await get_fba_shipment_or_raise(session, shipment_id)
    await audit_log(
        session,
        actor=actor,
        entity_type="fba_shipment",
        entity_id=shipment.id,
        action="update_draft",
        before=before,
        after={
            "name": shipment.name,
            "carrier": shipment.carrier,
            "tracking_number": shipment.tracking_number,
            "shipping_cost_cents": shipment.shipping_cost_cents,
            "cost_distribution_method": shipment.cost_distribution_method,
            "items_count": len(shipment.items),
        },
    )

    return shipment


async def mark_fba_shipment_shipped(session: AsyncSession, *, actor: str, shipment_id: uuid.UUID) -> FBAShipment:
    shipment = await get_fba_shipment_or_raise(session, shipment_id)
    if shipment.status != FBAShipmentStatus.DRAFT:
        raise ValueError("Only DRAFT shipments can be marked SHIPPED")
    if not shipment.items:
        raise ValueError("Cannot ship an empty shipment")

    item_ids = [line.inventory_item_id for line in shipment.items]
    rows = (
        await session.execute(select(InventoryItem).where(InventoryItem.id.in_(item_ids)))
    ).scalars().all()
    item_by_id = {item.id: item for item in rows}

    for item_id in item_ids:
        item = item_by_id.get(item_id)
        if item is None:
            raise ValueError(f"Inventory item not found: {item_id}")
        if item.status != InventoryStatus.AVAILABLE:
            raise ValueError(f"Inventory item not AVAILABLE: {item.id} (status={item.status})")

    allocation_by_item_id = distribute_shipping_costs(
        item_ids=item_ids,
        total_cents=shipment.shipping_cost_cents,
        method=shipment.cost_distribution_method,
        purchase_price_by_item_id={item.id: item.purchase_price_cents for item in item_by_id.values()},
    )

    for line in shipment.items:
        allocation = int(allocation_by_item_id.get(line.inventory_item_id, 0))
        line.allocated_shipping_cost_cents = allocation

        item = item_by_id[line.inventory_item_id]
        if allocation > 0:
            before_cost = {"allocated_costs_cents": item.allocated_costs_cents}
            item.allocated_costs_cents += allocation
            await audit_log(
                session,
                actor=actor,
                entity_type="inventory_item",
                entity_id=item.id,
                action="fba_inbound_shipping_cost_allocation",
                before=before_cost,
                after={"allocated_costs_cents": item.allocated_costs_cents},
            )

        await transition_status(
            session,
            actor=actor,
            item=item,
            new_status=InventoryStatus.FBA_INBOUND,
        )

    shipment.status = FBAShipmentStatus.SHIPPED
    shipment.shipped_at = datetime.now(timezone.utc)

    await audit_log(
        session,
        actor=actor,
        entity_type="fba_shipment",
        entity_id=shipment.id,
        action="ship",
        before={"status": FBAShipmentStatus.DRAFT},
        after={
            "status": shipment.status,
            "shipped_at": shipment.shipped_at,
            "shipping_cost_cents": shipment.shipping_cost_cents,
            "items_count": len(shipment.items),
        },
    )

    return shipment


async def mark_fba_shipment_received(
    session: AsyncSession,
    *,
    actor: str,
    shipment_id: uuid.UUID,
    data: FBAShipmentReceive,
) -> FBAShipment:
    shipment = await get_fba_shipment_or_raise(session, shipment_id)
    if shipment.status != FBAShipmentStatus.SHIPPED:
        raise ValueError("Only SHIPPED shipments can be marked RECEIVED")

    item_ids = [line.inventory_item_id for line in shipment.items]
    discrepancy_map = {d.inventory_item_id: d for d in data.discrepancies}
    unknown_ids = [item_id for item_id in discrepancy_map if item_id not in set(item_ids)]
    if unknown_ids:
        raise ValueError(f"Discrepancy item not part of shipment: {unknown_ids[0]}")

    rows = (
        await session.execute(select(InventoryItem).where(InventoryItem.id.in_(item_ids)))
    ).scalars().all()
    item_by_id = {item.id: item for item in rows}

    for line in shipment.items:
        item = item_by_id.get(line.inventory_item_id)
        if item is None:
            raise ValueError(f"Inventory item not found: {line.inventory_item_id}")

        discrepancy = discrepancy_map.get(item.id)
        if discrepancy is None:
            target_status = InventoryStatus.FBA_WAREHOUSE
            line.discrepancy_note = None
        else:
            target_status = discrepancy.status
            line.discrepancy_note = discrepancy.note

        await transition_status(session, actor=actor, item=item, new_status=target_status)
        line.received_status = target_status

    shipment.status = FBAShipmentStatus.RECEIVED
    shipment.received_at = datetime.now(timezone.utc)

    await audit_log(
        session,
        actor=actor,
        entity_type="fba_shipment",
        entity_id=shipment.id,
        action="receive",
        before={"status": FBAShipmentStatus.SHIPPED},
        after={
            "status": shipment.status,
            "received_at": shipment.received_at,
            "items_count": len(shipment.items),
            "discrepancies_count": len(data.discrepancies),
        },
    )

    return shipment
