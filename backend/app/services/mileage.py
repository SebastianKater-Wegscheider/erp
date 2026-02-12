from __future__ import annotations

import uuid

from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.mileage_log import MileageLog, _mileage_log_purchases
from app.models.purchase import Purchase
from app.schemas.mileage import MileageCreate
from app.services.audit import audit_log
from app.services.money import mileage_amount_cents, meters_from_km


async def create_mileage_log(
    session: AsyncSession, *, actor: str, data: MileageCreate, rate_cents_per_km: int
) -> MileageLog:
    purchases = await _resolve_mileage_purchases(session=session, purchase_ids=data.purchase_ids)
    distance_meters = meters_from_km(data.km)
    amount_cents = mileage_amount_cents(distance_meters=distance_meters, rate_cents_per_km=rate_cents_per_km)

    log = MileageLog(
        log_date=data.log_date,
        start_location=data.start_location,
        destination=data.destination,
        purpose=data.purpose,
        purpose_text=data.purpose_text,
        distance_meters=distance_meters,
        rate_cents_per_km=rate_cents_per_km,
        amount_cents=amount_cents,
        purchase_id=data.purchase_ids[0] if len(data.purchase_ids) == 1 else None,
    )
    session.add(log)
    await session.flush()

    if purchases:
        await session.execute(
            insert(_mileage_log_purchases),
            [{"mileage_log_id": log.id, "purchase_id": p.id} for p in purchases],
        )

    await audit_log(
        session,
        actor=actor,
        entity_type="mileage",
        entity_id=log.id,
        action="create",
        after={
            "distance_meters": distance_meters,
            "amount_cents": amount_cents,
            "purpose": log.purpose,
            "purpose_text": log.purpose_text,
            "purchase_ids": [str(p) for p in data.purchase_ids],
        },
    )
    return log


async def update_mileage_log(
    session: AsyncSession,
    *,
    actor: str,
    log_id: uuid.UUID,
    data: MileageCreate,
    rate_cents_per_km: int,
) -> MileageLog:
    log = await session.get(MileageLog, log_id)
    if log is None:
        raise ValueError("Mileage log not found")

    purchases = await _resolve_mileage_purchases(session=session, purchase_ids=data.purchase_ids)
    existing_linked_ids = [
        row[0]
        for row in (
            await session.execute(
                select(_mileage_log_purchases.c.purchase_id).where(_mileage_log_purchases.c.mileage_log_id == log.id)
            )
        ).all()
    ]
    if not existing_linked_ids and log.purchase_id is not None:
        existing_linked_ids = [log.purchase_id]

    distance_meters = meters_from_km(data.km)
    amount_cents = mileage_amount_cents(distance_meters=distance_meters, rate_cents_per_km=rate_cents_per_km)

    before = {
        "log_date": log.log_date,
        "start_location": log.start_location,
        "destination": log.destination,
        "purpose": log.purpose,
        "purpose_text": log.purpose_text,
        "distance_meters": log.distance_meters,
        "amount_cents": log.amount_cents,
        "purchase_ids": [str(pid) for pid in existing_linked_ids],
    }

    log.log_date = data.log_date
    log.start_location = data.start_location
    log.destination = data.destination
    log.purpose = data.purpose
    log.purpose_text = data.purpose_text
    log.distance_meters = distance_meters
    log.rate_cents_per_km = rate_cents_per_km
    log.amount_cents = amount_cents
    log.purchase_id = data.purchase_ids[0] if len(data.purchase_ids) == 1 else None

    await session.execute(delete(_mileage_log_purchases).where(_mileage_log_purchases.c.mileage_log_id == log.id))
    if purchases:
        await session.execute(
            insert(_mileage_log_purchases),
            [{"mileage_log_id": log.id, "purchase_id": p.id} for p in purchases],
        )

    await audit_log(
        session,
        actor=actor,
        entity_type="mileage",
        entity_id=log.id,
        action="update",
        before=before,
        after={
            "log_date": log.log_date,
            "start_location": log.start_location,
            "destination": log.destination,
            "purpose": log.purpose,
            "purpose_text": log.purpose_text,
            "distance_meters": log.distance_meters,
            "amount_cents": log.amount_cents,
            "purchase_ids": [str(pid) for pid in data.purchase_ids],
        },
    )
    return log


async def _resolve_mileage_purchases(session: AsyncSession, *, purchase_ids: list[uuid.UUID]) -> list[Purchase]:
    if not purchase_ids:
        return []

    purchases = (await session.execute(select(Purchase).where(Purchase.id.in_(purchase_ids)))).scalars().all()
    found = {p.id for p in purchases}
    missing = [pid for pid in purchase_ids if pid not in found]
    if missing:
        raise ValueError(f"Unknown purchase id(s): {', '.join(str(m) for m in missing)}")
    return purchases
