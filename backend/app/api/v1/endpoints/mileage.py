from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.db import get_session
from app.core.security import require_basic_auth
from app.models.mileage_log import MileageLog
from app.schemas.mileage import MileageCreate, MileageOut
from app.services.mileage import create_mileage_log


router = APIRouter()


@router.post("", response_model=MileageOut)
async def create_mileage_endpoint(
    data: MileageCreate,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> MileageOut:
    settings = get_settings()
    async with session.begin():
        log = await create_mileage_log(session, actor=actor, data=data, rate_cents_per_km=settings.mileage_rate_cents_per_km)
    await session.refresh(log)
    return MileageOut.model_validate(log)


@router.get("", response_model=list[MileageOut])
async def list_mileage(
    from_date: date | None = None,
    to_date: date | None = None,
    session: AsyncSession = Depends(get_session),
) -> list[MileageOut]:
    stmt = select(MileageLog).order_by(MileageLog.log_date.desc())
    if from_date:
        stmt = stmt.where(MileageLog.log_date >= from_date)
    if to_date:
        stmt = stmt.where(MileageLog.log_date <= to_date)
    rows = (await session.execute(stmt)).scalars().all()
    return [MileageOut.model_validate(r) for r in rows]


@router.get("/{log_id}", response_model=MileageOut)
async def get_mileage(log_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> MileageOut:
    log = await session.get(MileageLog, log_id)
    if log is None:
        raise HTTPException(status_code=404, detail="Not found")
    return MileageOut.model_validate(log)

