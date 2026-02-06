from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.models.master_product import MasterProduct
from app.schemas.master_product import MasterProductCreate, MasterProductOut, MasterProductUpdate


router = APIRouter()


@router.post("", response_model=MasterProductOut)
async def create_master_product(
    data: MasterProductCreate, session: AsyncSession = Depends(get_session)
) -> MasterProductOut:
    mp = MasterProduct(**data.model_dump())
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
