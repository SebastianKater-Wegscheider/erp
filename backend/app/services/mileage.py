from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.mileage_log import MileageLog
from app.models.purchase import Purchase
from app.schemas.mileage import MileageCreate
from app.services.audit import audit_log
from app.services.money import mileage_amount_cents, meters_from_km


async def create_mileage_log(
    session: AsyncSession, *, actor: str, data: MileageCreate, rate_cents_per_km: int
) -> MileageLog:
    distance_meters = meters_from_km(data.km)
    amount_cents = mileage_amount_cents(distance_meters=distance_meters, rate_cents_per_km=rate_cents_per_km)

    purchases: list[Purchase] = []
    if data.purchase_ids:
        purchases = (await session.execute(select(Purchase).where(Purchase.id.in_(data.purchase_ids)))).scalars().all()
        found = {p.id for p in purchases}
        missing = [pid for pid in data.purchase_ids if pid not in found]
        if missing:
            raise ValueError(f"Unknown purchase id(s): {', '.join(str(m) for m in missing)}")

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
        log.purchases = purchases
        await session.flush()

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
