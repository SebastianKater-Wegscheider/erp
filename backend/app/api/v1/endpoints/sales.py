from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.db import get_session
from app.core.security import require_basic_auth
from app.models.sales import SalesOrder
from app.models.sales_correction import SalesCorrection
from app.schemas.sales import SalesOrderCreate, SalesOrderOut
from app.schemas.sales_correction import SalesCorrectionCreate, SalesCorrectionOut
from app.services.sales import cancel_sales_order, create_sales_order, finalize_sales_order, generate_sales_invoice_pdf
from app.services.sales_corrections import create_sales_correction, generate_sales_correction_pdf


router = APIRouter()


@router.post("", response_model=SalesOrderOut)
async def create_sales_order_endpoint(
    data: SalesOrderCreate,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> SalesOrderOut:
    try:
        async with session.begin():
            order = await create_sales_order(session, actor=actor, data=data)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    order = (
        await session.execute(select(SalesOrder).where(SalesOrder.id == order.id).options(selectinload(SalesOrder.lines)))
    ).scalar_one()
    return SalesOrderOut.model_validate(order)


@router.get("", response_model=list[SalesOrderOut])
async def list_sales_orders(session: AsyncSession = Depends(get_session)) -> list[SalesOrderOut]:
    rows = (
        await session.execute(select(SalesOrder).order_by(SalesOrder.order_date.desc()).options(selectinload(SalesOrder.lines)))
    ).scalars().all()
    return [SalesOrderOut.model_validate(r) for r in rows]


@router.get("/{order_id}", response_model=SalesOrderOut)
async def get_sales_order(order_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> SalesOrderOut:
    order = (
        await session.execute(select(SalesOrder).where(SalesOrder.id == order_id).options(selectinload(SalesOrder.lines)))
    ).scalar_one_or_none()
    if order is None:
        raise HTTPException(status_code=404, detail="Not found")
    return SalesOrderOut.model_validate(order)


@router.post("/{order_id}/finalize", response_model=SalesOrderOut)
async def finalize_sales_order_endpoint(
    order_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> SalesOrderOut:
    try:
        async with session.begin():
            order = await finalize_sales_order(session, actor=actor, order_id=order_id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    order = (
        await session.execute(select(SalesOrder).where(SalesOrder.id == order.id).options(selectinload(SalesOrder.lines)))
    ).scalar_one()
    return SalesOrderOut.model_validate(order)


@router.post("/{order_id}/generate-invoice-pdf", response_model=SalesOrderOut)
async def generate_sales_invoice_pdf_endpoint(
    order_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> SalesOrderOut:
    try:
        async with session.begin():
            order = await generate_sales_invoice_pdf(session, actor=actor, order_id=order_id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    order = (
        await session.execute(select(SalesOrder).where(SalesOrder.id == order.id).options(selectinload(SalesOrder.lines)))
    ).scalar_one()
    return SalesOrderOut.model_validate(order)


@router.post("/{order_id}/cancel", response_model=SalesOrderOut)
async def cancel_sales_order_endpoint(
    order_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> SalesOrderOut:
    try:
        async with session.begin():
            order = await cancel_sales_order(session, actor=actor, order_id=order_id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    order = (
        await session.execute(select(SalesOrder).where(SalesOrder.id == order.id).options(selectinload(SalesOrder.lines)))
    ).scalar_one()
    return SalesOrderOut.model_validate(order)


@router.post("/{order_id}/returns", response_model=SalesCorrectionOut)
async def create_return_endpoint(
    order_id: uuid.UUID,
    data: SalesCorrectionCreate,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> SalesCorrectionOut:
    try:
        async with session.begin():
            correction = await create_sales_correction(session, actor=actor, order_id=order_id, data=data)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    correction = (
        await session.execute(
            select(SalesCorrection)
            .where(SalesCorrection.id == correction.id)
            .options(selectinload(SalesCorrection.lines))
        )
    ).scalar_one()
    return SalesCorrectionOut.model_validate(correction)


@router.get("/{order_id}/returns", response_model=list[SalesCorrectionOut])
async def list_returns(order_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> list[SalesCorrectionOut]:
    rows = (
        await session.execute(
            select(SalesCorrection)
            .where(SalesCorrection.order_id == order_id)
            .order_by(SalesCorrection.correction_date.desc())
            .options(selectinload(SalesCorrection.lines))
        )
    ).scalars().all()
    return [SalesCorrectionOut.model_validate(r) for r in rows]


@router.post("/{order_id}/returns/{correction_id}/generate-pdf", response_model=SalesCorrectionOut)
async def generate_return_pdf_endpoint(
    order_id: uuid.UUID,
    correction_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> SalesCorrectionOut:
    try:
        async with session.begin():
            correction = await session.get(SalesCorrection, correction_id)
            if correction is None or correction.order_id != order_id:
                raise ValueError("Sales correction not found")
            correction = await generate_sales_correction_pdf(session, actor=actor, correction_id=correction_id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    correction = (
        await session.execute(
            select(SalesCorrection)
            .where(SalesCorrection.id == correction.id)
            .options(selectinload(SalesCorrection.lines))
        )
    ).scalar_one()
    return SalesCorrectionOut.model_validate(correction)
