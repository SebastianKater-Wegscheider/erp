from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.db import get_session
from app.core.enums import FBAShipmentStatus
from app.core.security import require_basic_auth
from app.models.fba_shipment import FBAShipment
from app.schemas.fba_shipment import (
    FBAShipmentCreate,
    FBAShipmentOut,
    FBAShipmentReceive,
    FBAShipmentUpdateDraft,
)
from app.services.fba_shipments import (
    create_fba_shipment,
    get_fba_shipment_or_raise,
    mark_fba_shipment_received,
    mark_fba_shipment_shipped,
    update_fba_shipment_draft,
)


router = APIRouter()


@router.get("", response_model=list[FBAShipmentOut])
async def list_fba_shipments(
    status: FBAShipmentStatus | None = None,
    session: AsyncSession = Depends(get_session),
) -> list[FBAShipmentOut]:
    stmt = select(FBAShipment).order_by(FBAShipment.created_at.desc()).options(selectinload(FBAShipment.items))
    if status is not None:
        stmt = stmt.where(FBAShipment.status == status)
    rows = (await session.execute(stmt)).scalars().all()
    return [FBAShipmentOut.model_validate(row) for row in rows]


@router.post("", response_model=FBAShipmentOut)
async def create_fba_shipment_endpoint(
    data: FBAShipmentCreate,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> FBAShipmentOut:
    try:
        async with session.begin():
            shipment = await create_fba_shipment(session, actor=actor, data=data)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    shipment = await get_fba_shipment_or_raise(session, shipment.id)
    return FBAShipmentOut.model_validate(shipment)


@router.get("/{shipment_id}", response_model=FBAShipmentOut)
async def get_fba_shipment_endpoint(shipment_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> FBAShipmentOut:
    try:
        shipment = await get_fba_shipment_or_raise(session, shipment_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Not found") from None
    return FBAShipmentOut.model_validate(shipment)


@router.patch("/{shipment_id}", response_model=FBAShipmentOut)
async def update_fba_shipment_draft_endpoint(
    shipment_id: uuid.UUID,
    data: FBAShipmentUpdateDraft,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> FBAShipmentOut:
    try:
        async with session.begin():
            shipment = await update_fba_shipment_draft(session, actor=actor, shipment_id=shipment_id, data=data)
    except ValueError as e:
        msg = str(e)
        if msg == "FBA shipment not found":
            raise HTTPException(status_code=404, detail="Not found") from e
        raise HTTPException(status_code=409, detail=msg) from e

    shipment = await get_fba_shipment_or_raise(session, shipment.id)
    return FBAShipmentOut.model_validate(shipment)


@router.post("/{shipment_id}/ship", response_model=FBAShipmentOut)
async def ship_fba_shipment_endpoint(
    shipment_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> FBAShipmentOut:
    try:
        async with session.begin():
            shipment = await mark_fba_shipment_shipped(session, actor=actor, shipment_id=shipment_id)
    except ValueError as e:
        msg = str(e)
        if msg == "FBA shipment not found":
            raise HTTPException(status_code=404, detail="Not found") from e
        raise HTTPException(status_code=409, detail=msg) from e

    shipment = await get_fba_shipment_or_raise(session, shipment.id)
    return FBAShipmentOut.model_validate(shipment)


@router.post("/{shipment_id}/receive", response_model=FBAShipmentOut)
async def receive_fba_shipment_endpoint(
    shipment_id: uuid.UUID,
    data: FBAShipmentReceive,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> FBAShipmentOut:
    try:
        async with session.begin():
            shipment = await mark_fba_shipment_received(session, actor=actor, shipment_id=shipment_id, data=data)
    except ValueError as e:
        msg = str(e)
        if msg == "FBA shipment not found":
            raise HTTPException(status_code=404, detail="Not found") from e
        raise HTTPException(status_code=409, detail=msg) from e

    shipment = await get_fba_shipment_or_raise(session, shipment.id)
    return FBAShipmentOut.model_validate(shipment)
