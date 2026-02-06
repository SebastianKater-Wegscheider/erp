from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.enums import InventoryStatus
from app.models.inventory_item import InventoryItem
from app.models.inventory_item_image import InventoryItemImage
from app.models.master_product import MasterProduct
from app.schemas.inventory import InventoryItemOut, InventoryItemUpdate, InventoryStatusTransition
from app.schemas.inventory_item_image import InventoryItemImageCreate, InventoryItemImageOut
from app.services.inventory import transition_status
from app.core.security import require_basic_auth


router = APIRouter()


@router.get("", response_model=list[InventoryItemOut])
async def list_inventory(
    q: str | None = Query(default=None, description="Search by title/EAN/ASIN (ILIKE) or master product UUID"),
    status: InventoryStatus | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_session),
) -> list[InventoryItemOut]:
    stmt = select(InventoryItem).order_by(InventoryItem.created_at.desc()).limit(limit).offset(offset)
    if status:
        stmt = stmt.where(InventoryItem.status == status)
    if q:
        try:
            mp_id = uuid.UUID(q)
            stmt = stmt.where(InventoryItem.master_product_id == mp_id)
        except ValueError:
            pat = f"%{q}%"
            stmt = (
                stmt.join(MasterProduct, MasterProduct.id == InventoryItem.master_product_id).where(
                    or_(
                        MasterProduct.title.ilike(pat),
                        MasterProduct.sku.ilike(pat),
                        MasterProduct.platform.ilike(pat),
                        MasterProduct.region.ilike(pat),
                        MasterProduct.variant.ilike(pat),
                        MasterProduct.ean.ilike(pat),
                        MasterProduct.asin.ilike(pat),
                        MasterProduct.manufacturer.ilike(pat),
                        MasterProduct.model.ilike(pat),
                    )
                )
            )

    rows = (await session.execute(stmt)).scalars().all()
    return [InventoryItemOut.model_validate(r) for r in rows]


@router.patch("/{inventory_item_id}", response_model=InventoryItemOut)
async def update_inventory_item(
    inventory_item_id: uuid.UUID,
    data: InventoryItemUpdate,
    session: AsyncSession = Depends(get_session),
) -> InventoryItemOut:
    item = await session.get(InventoryItem, inventory_item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Not found")

    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(item, k, v)
    await session.commit()
    await session.refresh(item)
    return InventoryItemOut.model_validate(item)


@router.post("/{inventory_item_id}/status", response_model=InventoryItemOut)
async def change_inventory_status(
    inventory_item_id: uuid.UUID,
    data: InventoryStatusTransition,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> InventoryItemOut:
    item = await session.get(InventoryItem, inventory_item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Not found")
    try:
        await transition_status(session, actor=actor, item=item, new_status=data.new_status)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    await session.commit()
    await session.refresh(item)
    return InventoryItemOut.model_validate(item)


@router.get("/{inventory_item_id}/images", response_model=list[InventoryItemImageOut])
async def list_inventory_item_images(
    inventory_item_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> list[InventoryItemImageOut]:
    if await session.get(InventoryItem, inventory_item_id) is None:
        raise HTTPException(status_code=404, detail="Not found")
    rows = (
        (await session.execute(
            select(InventoryItemImage)
            .where(InventoryItemImage.inventory_item_id == inventory_item_id)
            .order_by(InventoryItemImage.created_at.desc())
        ))
        .scalars()
        .all()
    )
    return [InventoryItemImageOut.model_validate(r) for r in rows]


@router.post("/{inventory_item_id}/images", response_model=InventoryItemImageOut)
async def add_inventory_item_image(
    inventory_item_id: uuid.UUID,
    data: InventoryItemImageCreate,
    session: AsyncSession = Depends(get_session),
) -> InventoryItemImageOut:
    if await session.get(InventoryItem, inventory_item_id) is None:
        raise HTTPException(status_code=404, detail="Not found")

    rel = data.upload_path.lstrip("/")
    if not rel.startswith("uploads/"):
        raise HTTPException(status_code=400, detail="upload_path must start with uploads/")

    img = InventoryItemImage(inventory_item_id=inventory_item_id, upload_path=rel)
    session.add(img)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(status_code=409, detail="Image already attached") from e
    await session.refresh(img)
    return InventoryItemImageOut.model_validate(img)


@router.delete("/{inventory_item_id}/images/{image_id}", status_code=204)
async def delete_inventory_item_image(
    inventory_item_id: uuid.UUID,
    image_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> Response:
    img = await session.get(InventoryItemImage, image_id)
    if img is None or img.inventory_item_id != inventory_item_id:
        raise HTTPException(status_code=404, detail="Not found")
    await session.delete(img)
    await session.commit()
    return Response(status_code=204)
