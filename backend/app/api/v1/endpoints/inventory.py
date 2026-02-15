from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import exists, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.enums import InventoryQueue, InventoryStatus
from app.models.amazon_scrape import AmazonProductMetricsLatest
from app.models.inventory_item import InventoryItem
from app.models.inventory_item_image import InventoryItemImage
from app.models.master_product import MasterProduct
from app.core.security import require_basic_auth
from app.schemas.inventory import InventoryItemOut, InventoryItemUpdate, InventoryStatusTransition
from app.schemas.inventory_item_image import InventoryItemImageCreate, InventoryItemImageOut
from app.services.inventory import transition_status


router = APIRouter()

QUEUE_STATUSES_PHOTOS_MISSING = (
    InventoryStatus.DRAFT,
    InventoryStatus.AVAILABLE,
    InventoryStatus.RETURNED,
    InventoryStatus.DISCREPANCY,
)

QUEUE_STATUSES_STORAGE_MISSING = QUEUE_STATUSES_PHOTOS_MISSING

QUEUE_STATUSES_AMAZON_STALE = (
    InventoryStatus.AVAILABLE,
    InventoryStatus.FBA_WAREHOUSE,
    InventoryStatus.RETURNED,
    InventoryStatus.DISCREPANCY,
)

QUEUE_STATUSES_OLD_STOCK_90D = (
    InventoryStatus.DRAFT,
    InventoryStatus.AVAILABLE,
    InventoryStatus.FBA_WAREHOUSE,
    InventoryStatus.RETURNED,
    InventoryStatus.DISCREPANCY,
)


@router.get("", response_model=list[InventoryItemOut])
async def list_inventory(
    q: str | None = Query(default=None, description="Search by title/EAN/ASIN (ILIKE) or master product UUID"),
    status: InventoryStatus | None = None,
    queue: InventoryQueue | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_session),
) -> list[InventoryItemOut]:
    stmt = select(InventoryItem).join(MasterProduct, MasterProduct.id == InventoryItem.master_product_id)
    order_by = [InventoryItem.created_at.desc()]

    if status:
        stmt = stmt.where(InventoryItem.status == status)

    if q:
        needle = q.strip()
        try:
            mp_id = uuid.UUID(needle)
            stmt = stmt.where(InventoryItem.master_product_id == mp_id)
        except ValueError:
            pat = f"%{needle}%"
            stmt = stmt.where(
                or_(
                    InventoryItem.item_code.ilike(pat),
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

    effective_date = func.coalesce(InventoryItem.acquired_date, func.date(InventoryItem.created_at))
    if queue == InventoryQueue.PHOTOS_MISSING:
        missing_images = ~exists(
            select(1)
            .select_from(InventoryItemImage)
            .where(InventoryItemImage.inventory_item_id == InventoryItem.id)
        )
        stmt = stmt.where(InventoryItem.status.in_(QUEUE_STATUSES_PHOTOS_MISSING)).where(missing_images)
        order_by = [effective_date.asc(), InventoryItem.created_at.asc()]
    elif queue == InventoryQueue.STORAGE_MISSING:
        stmt = stmt.where(
            InventoryItem.status.in_(QUEUE_STATUSES_STORAGE_MISSING),
            or_(InventoryItem.storage_location.is_(None), func.trim(InventoryItem.storage_location) == ""),
        )
        order_by = [effective_date.asc(), InventoryItem.created_at.asc()]
    elif queue == InventoryQueue.AMAZON_STALE:
        stale_before = datetime.now(timezone.utc) - timedelta(hours=24)
        stmt = stmt.outerjoin(AmazonProductMetricsLatest, AmazonProductMetricsLatest.master_product_id == MasterProduct.id)
        stmt = stmt.where(
            InventoryItem.status.in_(QUEUE_STATUSES_AMAZON_STALE),
            MasterProduct.asin.is_not(None),
            func.trim(MasterProduct.asin) != "",
            or_(
                AmazonProductMetricsLatest.master_product_id.is_(None),
                AmazonProductMetricsLatest.last_success_at.is_(None),
                AmazonProductMetricsLatest.last_success_at < stale_before,
                AmazonProductMetricsLatest.blocked_last.is_(True),
            ),
        )
        order_by = [
            AmazonProductMetricsLatest.last_success_at.is_(None).desc(),
            AmazonProductMetricsLatest.last_success_at.asc(),
            InventoryItem.created_at.asc(),
        ]
    elif queue == InventoryQueue.OLD_STOCK_90D:
        old_before = datetime.now(timezone.utc).date() - timedelta(days=90)
        stmt = stmt.where(
            InventoryItem.status.in_(QUEUE_STATUSES_OLD_STOCK_90D),
            effective_date <= old_before,
        )
        order_by = [effective_date.asc(), InventoryItem.created_at.asc()]

    stmt = stmt.order_by(*order_by).limit(limit).offset(offset)
    rows = (await session.execute(stmt)).scalars().all()
    return [InventoryItemOut.model_validate(r) for r in rows]


@router.get("/images", response_model=list[InventoryItemImageOut])
async def list_inventory_images_for_items(
    item_ids: list[uuid.UUID] = Query(default=[]),
    session: AsyncSession = Depends(get_session),
) -> list[InventoryItemImageOut]:
    if not item_ids:
        return []
    rows = (
        await session.execute(
            select(InventoryItemImage)
            .where(InventoryItemImage.inventory_item_id.in_(item_ids))
            .order_by(InventoryItemImage.inventory_item_id.asc(), InventoryItemImage.created_at.desc())
        )
    ).scalars().all()
    return [InventoryItemImageOut.model_validate(r) for r in rows]


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
