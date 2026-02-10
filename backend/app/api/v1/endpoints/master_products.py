from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.models.amazon_scrape import AmazonProductMetricsLatest
from app.models.inventory_item import InventoryItem
from app.models.master_product import MasterProduct, master_product_sku_from_id
from app.models.purchase import PurchaseLine
from app.schemas.master_product import MasterProductCreate, MasterProductOut, MasterProductOutWithAmazon, MasterProductUpdate


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


@router.get("", response_model=list[MasterProductOutWithAmazon])
async def list_master_products(session: AsyncSession = Depends(get_session)) -> list[MasterProductOutWithAmazon]:
    rows = (
        await session.execute(
            select(MasterProduct, AmazonProductMetricsLatest)
            .outerjoin(AmazonProductMetricsLatest, AmazonProductMetricsLatest.master_product_id == MasterProduct.id)
            .order_by(
                MasterProduct.kind,
                MasterProduct.title,
                MasterProduct.platform,
                MasterProduct.region,
                MasterProduct.variant,
            )
        )
    ).all()

    out: list[MasterProductOutWithAmazon] = []
    for mp, latest in rows:
        base = MasterProductOut.model_validate(mp)
        out.append(
            MasterProductOutWithAmazon(
                **base.model_dump(),
                amazon_last_attempt_at=getattr(latest, "last_attempt_at", None),
                amazon_last_success_at=getattr(latest, "last_success_at", None),
                amazon_last_run_id=getattr(latest, "last_run_id", None),
                amazon_blocked_last=getattr(latest, "blocked_last", None),
                amazon_block_reason_last=getattr(latest, "block_reason_last", None),
                amazon_last_error=getattr(latest, "last_error", None),
                amazon_rank_overall=getattr(latest, "rank_overall", None),
                amazon_rank_overall_category=getattr(latest, "rank_overall_category", None),
                amazon_rank_specific=getattr(latest, "rank_specific", None),
                amazon_rank_specific_category=getattr(latest, "rank_specific_category", None),
                amazon_price_new_cents=getattr(latest, "price_new_cents", None),
                amazon_price_used_like_new_cents=getattr(latest, "price_used_like_new_cents", None),
                amazon_price_used_very_good_cents=getattr(latest, "price_used_very_good_cents", None),
                amazon_price_used_good_cents=getattr(latest, "price_used_good_cents", None),
                amazon_price_used_acceptable_cents=getattr(latest, "price_used_acceptable_cents", None),
                amazon_price_collectible_cents=getattr(latest, "price_collectible_cents", None),
                amazon_next_retry_at=getattr(latest, "next_retry_at", None),
                amazon_consecutive_failures=getattr(latest, "consecutive_failures", None),
            )
        )
    return out


@router.get("/{master_product_id}", response_model=MasterProductOutWithAmazon)
async def get_master_product(
    master_product_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> MasterProductOutWithAmazon:
    row = (
        (
            await session.execute(
                select(MasterProduct, AmazonProductMetricsLatest)
                .outerjoin(AmazonProductMetricsLatest, AmazonProductMetricsLatest.master_product_id == MasterProduct.id)
                .where(MasterProduct.id == master_product_id)
            )
        )
        .all()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    mp, latest = row[0]
    base = MasterProductOut.model_validate(mp)
    return MasterProductOutWithAmazon(
        **base.model_dump(),
        amazon_last_attempt_at=getattr(latest, "last_attempt_at", None),
        amazon_last_success_at=getattr(latest, "last_success_at", None),
        amazon_last_run_id=getattr(latest, "last_run_id", None),
        amazon_blocked_last=getattr(latest, "blocked_last", None),
        amazon_block_reason_last=getattr(latest, "block_reason_last", None),
        amazon_last_error=getattr(latest, "last_error", None),
        amazon_rank_overall=getattr(latest, "rank_overall", None),
        amazon_rank_overall_category=getattr(latest, "rank_overall_category", None),
        amazon_rank_specific=getattr(latest, "rank_specific", None),
        amazon_rank_specific_category=getattr(latest, "rank_specific_category", None),
        amazon_price_new_cents=getattr(latest, "price_new_cents", None),
        amazon_price_used_like_new_cents=getattr(latest, "price_used_like_new_cents", None),
        amazon_price_used_very_good_cents=getattr(latest, "price_used_very_good_cents", None),
        amazon_price_used_good_cents=getattr(latest, "price_used_good_cents", None),
        amazon_price_used_acceptable_cents=getattr(latest, "price_used_acceptable_cents", None),
        amazon_price_collectible_cents=getattr(latest, "price_collectible_cents", None),
        amazon_next_retry_at=getattr(latest, "next_retry_at", None),
        amazon_consecutive_failures=getattr(latest, "consecutive_failures", None),
    )


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
