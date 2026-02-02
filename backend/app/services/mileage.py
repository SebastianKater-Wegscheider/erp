from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.mileage_log import MileageLog
from app.schemas.mileage import MileageCreate
from app.services.audit import audit_log
from app.services.money import mileage_amount_cents, meters_from_km


async def create_mileage_log(
    session: AsyncSession, *, actor: str, data: MileageCreate, rate_cents_per_km: int
) -> MileageLog:
    distance_meters = meters_from_km(data.km)
    amount_cents = mileage_amount_cents(distance_meters=distance_meters, rate_cents_per_km=rate_cents_per_km)

    log = MileageLog(
        log_date=data.log_date,
        start_location=data.start_location,
        destination=data.destination,
        purpose=data.purpose,
        distance_meters=distance_meters,
        rate_cents_per_km=rate_cents_per_km,
        amount_cents=amount_cents,
        purchase_id=data.purchase_id,
    )
    session.add(log)
    await session.flush()

    await audit_log(
        session,
        actor=actor,
        entity_type="mileage",
        entity_id=log.id,
        action="create",
        after={"distance_meters": distance_meters, "amount_cents": amount_cents, "purpose": log.purpose},
    )
    return log

