from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.db import get_session
from app.core.security import require_basic_auth
from app.models.cost_allocation import CostAllocation
from app.schemas.cost_allocation import CostAllocationCreate, CostAllocationOut
from app.services.cost_allocations import create_cost_allocation


router = APIRouter()


@router.post("", response_model=CostAllocationOut)
async def create_cost_allocation_endpoint(
    data: CostAllocationCreate,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> CostAllocationOut:
    try:
        async with session.begin():
            allocation = await create_cost_allocation(session, actor=actor, data=data)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    allocation = (
        await session.execute(
            select(CostAllocation).where(CostAllocation.id == allocation.id).options(selectinload(CostAllocation.lines))
        )
    ).scalar_one()
    return CostAllocationOut.model_validate(allocation)


@router.get("", response_model=list[CostAllocationOut])
async def list_cost_allocations(session: AsyncSession = Depends(get_session)) -> list[CostAllocationOut]:
    rows = (
        await session.execute(
            select(CostAllocation).order_by(CostAllocation.allocation_date.desc()).options(selectinload(CostAllocation.lines))
        )
    ).scalars().all()
    return [CostAllocationOut.model_validate(r) for r in rows]


@router.get("/{allocation_id}", response_model=CostAllocationOut)
async def get_cost_allocation(allocation_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> CostAllocationOut:
    row = (
        await session.execute(
            select(CostAllocation).where(CostAllocation.id == allocation_id).options(selectinload(CostAllocation.lines))
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Not found")
    return CostAllocationOut.model_validate(row)

