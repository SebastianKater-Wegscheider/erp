from __future__ import annotations

import uuid
from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.db import get_session
from app.models.bank_account import BankAccount
from app.models.bank_transaction import BankTransaction
from app.schemas.bank import BankAccountOut, BankSyncOut, BankTransactionLink, BankTransactionOut
from app.services.bank_transactions import set_bank_transaction_purchases, sync_bank_transactions


router = APIRouter()


@router.post("/sync", response_model=BankSyncOut)
async def sync_bank_endpoint(session: AsyncSession = Depends(get_session)) -> BankSyncOut:
    try:
        async with session.begin():
            stats = await sync_bank_transactions(session)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return BankSyncOut(**asdict(stats))


@router.get("/accounts", response_model=list[BankAccountOut])
async def list_bank_accounts(session: AsyncSession = Depends(get_session)) -> list[BankAccountOut]:
    rows = (await session.execute(select(BankAccount).order_by(BankAccount.created_at.desc()))).scalars().all()
    return [BankAccountOut.model_validate(r) for r in rows]


@router.get("/transactions", response_model=list[BankTransactionOut])
async def list_bank_transactions(
    account_id: uuid.UUID | None = None,
    unlinked_only: bool = False,
    q: str | None = None,
    limit: int = Query(200, ge=1, le=1000),
    session: AsyncSession = Depends(get_session),
) -> list[BankTransactionOut]:
    stmt = (
        select(BankTransaction)
        .order_by(BankTransaction.booked_date.desc(), BankTransaction.created_at.desc())
        .limit(limit)
        .options(selectinload(BankTransaction.purchases))
    )
    if account_id:
        stmt = stmt.where(BankTransaction.bank_account_id == account_id)
    if unlinked_only:
        stmt = stmt.where(~BankTransaction.purchases.any())
    if q and q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                BankTransaction.counterparty_name.ilike(like),
                BankTransaction.remittance_information.ilike(like),
            )
        )

    rows = (await session.execute(stmt)).scalars().all()
    return [BankTransactionOut.model_validate(r) for r in rows]


@router.get("/transactions/{transaction_id}", response_model=BankTransactionOut)
async def get_bank_transaction(transaction_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> BankTransactionOut:
    row = (
        await session.execute(
            select(BankTransaction)
            .where(BankTransaction.id == transaction_id)
            .options(selectinload(BankTransaction.purchases))
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Not found")
    return BankTransactionOut.model_validate(row)


@router.post("/transactions/{transaction_id}/purchases", response_model=BankTransactionOut)
async def set_bank_transaction_purchases_endpoint(
    transaction_id: uuid.UUID,
    data: BankTransactionLink,
    session: AsyncSession = Depends(get_session),
) -> BankTransactionOut:
    try:
        async with session.begin():
            tx = await set_bank_transaction_purchases(
                session,
                bank_transaction_id=transaction_id,
                purchase_ids=data.purchase_ids,
            )
    except ValueError as e:
        msg = str(e)
        if msg == "Bank transaction not found":
            raise HTTPException(status_code=404, detail=msg) from e
        raise HTTPException(status_code=409, detail=msg) from e

    return BankTransactionOut.model_validate(tx)

