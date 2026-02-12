from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.core.db import get_session
from app.core.security import require_basic_auth
from app.models.mileage_log import MileageLog
from app.schemas.mileage import MileageCreate, MileageOut
from app.services.mileage import create_mileage_log, update_mileage_log


router = APIRouter()


@router.post("", response_model=MileageOut)
async def create_mileage_endpoint(
    data: MileageCreate,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> MileageOut:
    settings = get_settings()
    try:
        async with session.begin():
            log = await create_mileage_log(
                session,
                actor=actor,
                data=data,
                rate_cents_per_km=settings.mileage_rate_cents_per_km,
            )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    row = (
        await session.execute(
            select(MileageLog).where(MileageLog.id == log.id).options(selectinload(MileageLog.purchases))
        )
    ).scalar_one()
    return MileageOut.model_validate(row)


@router.put("/{log_id}", response_model=MileageOut)
async def update_mileage_endpoint(
    log_id: uuid.UUID,
    data: MileageCreate,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> MileageOut:
    settings = get_settings()
    try:
        async with session.begin():
            log = await update_mileage_log(
                session,
                actor=actor,
                log_id=log_id,
                data=data,
                rate_cents_per_km=settings.mileage_rate_cents_per_km,
            )
    except ValueError as e:
        detail = str(e)
        raise HTTPException(status_code=404 if detail == "Mileage log not found" else 409, detail=detail) from e

    row = (
        await session.execute(
            select(MileageLog).where(MileageLog.id == log.id).options(selectinload(MileageLog.purchases))
        )
    ).scalar_one()
    return MileageOut.model_validate(row)


@router.get("", response_model=list[MileageOut])
async def list_mileage(
    from_date: date | None = None,
    to_date: date | None = None,
    session: AsyncSession = Depends(get_session),
) -> list[MileageOut]:
    stmt = select(MileageLog).order_by(MileageLog.log_date.desc()).options(selectinload(MileageLog.purchases))
    if from_date:
        stmt = stmt.where(MileageLog.log_date >= from_date)
    if to_date:
        stmt = stmt.where(MileageLog.log_date <= to_date)
    rows = (await session.execute(stmt)).scalars().all()
    return [MileageOut.model_validate(r) for r in rows]


@router.get("/{log_id}", response_model=MileageOut)
async def get_mileage(log_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> MileageOut:
    row = (
        await session.execute(
            select(MileageLog).where(MileageLog.id == log_id).options(selectinload(MileageLog.purchases))
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Not found")
    return MileageOut.model_validate(row)
