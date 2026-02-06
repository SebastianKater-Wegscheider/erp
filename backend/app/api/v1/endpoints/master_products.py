from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.models.inventory_item import InventoryItem
from app.models.master_product import MasterProduct, master_product_sku_from_id
from app.models.purchase import PurchaseLine
from app.schemas.master_product import MasterProductCreate, MasterProductOut, MasterProductUpdate


router = APIRouter()


@router.post("", response_model=MasterProductOut)
async def create_master_product(
    data: MasterProductCreate, session: AsyncSession = Depends(get_session)
) -> MasterProductOut:
    mp_id = uuid.uuid4()
    mp = MasterProduct(
        id=mp_id,
        sku=master_product_sku_from_id(mp_id),
        **data.model_dump(),
    )
    session.add(mp)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(status_code=409, detail="Master product already exists") from e
    await session.refresh(mp)
    return MasterProductOut.model_validate(mp)


@router.get("", response_model=list[MasterProductOut])
async def list_master_products(session: AsyncSession = Depends(get_session)) -> list[MasterProductOut]:
    rows = (
        (await session.execute(
            select(MasterProduct).order_by(
                MasterProduct.kind,
                MasterProduct.title,
                MasterProduct.platform,
                MasterProduct.region,
                MasterProduct.variant,
            )
        ))
        .scalars()
        .all()
    )
    return [MasterProductOut.model_validate(r) for r in rows]


@router.get("/{master_product_id}", response_model=MasterProductOut)
async def get_master_product(master_product_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> MasterProductOut:
    mp = await session.get(MasterProduct, master_product_id)
    if mp is None:
        raise HTTPException(status_code=404, detail="Not found")
    return MasterProductOut.model_validate(mp)


@router.patch("/{master_product_id}", response_model=MasterProductOut)
async def update_master_product(
    master_product_id: uuid.UUID,
    data: MasterProductUpdate,
    session: AsyncSession = Depends(get_session),
) -> MasterProductOut:
    mp = await session.get(MasterProduct, master_product_id)
    if mp is None:
        raise HTTPException(status_code=404, detail="Not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(mp, k, v)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(status_code=409, detail="Master product already exists") from e
    await session.refresh(mp)
    return MasterProductOut.model_validate(mp)


@router.delete("/{master_product_id}", status_code=204)
async def delete_master_product(
    master_product_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> Response:
    mp = await session.get(MasterProduct, master_product_id)
    if mp is None:
        raise HTTPException(status_code=404, detail="Not found")

    # Provide a helpful, deterministic 409 instead of a generic FK integrity error.
    inv_count = (
        await session.scalar(
            select(func.count()).select_from(InventoryItem).where(InventoryItem.master_product_id == master_product_id)
        )
    ) or 0
    purchase_line_count = (
        await session.scalar(
            select(func.count()).select_from(PurchaseLine).where(PurchaseLine.master_product_id == master_product_id)
        )
    ) or 0

    if inv_count or purchase_line_count:
        parts: list[str] = []
        if inv_count:
            parts.append(f"{inv_count} inventory items")
        if purchase_line_count:
            parts.append(f"{purchase_line_count} purchase lines")
        raise HTTPException(status_code=409, detail=f"Cannot delete: referenced by {', '.join(parts)}")

    await session.delete(mp)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(status_code=409, detail="Cannot delete: master product is still referenced") from e
    return Response(status_code=204)
