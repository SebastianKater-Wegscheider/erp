from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.security import require_basic_auth
from app.models.opex_expense import OpexExpense
from app.schemas.opex import OpexCreate, OpexOut
from app.services.opex import create_opex


router = APIRouter()


@router.post("", response_model=OpexOut)
async def create_opex_endpoint(
    data: OpexCreate,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> OpexOut:
    async with session.begin():
        expense = await create_opex(session, actor=actor, data=data)
    await session.refresh(expense)
    return OpexOut.model_validate(expense)


@router.get("", response_model=list[OpexOut])
async def list_opex(session: AsyncSession = Depends(get_session)) -> list[OpexOut]:
    rows = (await session.execute(select(OpexExpense).order_by(OpexExpense.expense_date.desc()))).scalars().all()
    return [OpexOut.model_validate(r) for r in rows]


@router.get("/{expense_id}", response_model=OpexOut)
async def get_opex(expense_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> OpexOut:
    expense = await session.get(OpexExpense, expense_id)
    if expense is None:
        raise HTTPException(status_code=404, detail="Not found")
    return OpexOut.model_validate(expense)

