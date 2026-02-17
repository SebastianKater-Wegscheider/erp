from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import exists, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.db import get_session
from app.core.enums import InventoryQueue, InventoryStatus, TargetPriceMode
from app.core.security import require_basic_auth
from app.models.amazon_scrape import AmazonProductMetricsLatest
from app.models.inventory_item import InventoryItem
from app.models.inventory_item_image import InventoryItemImage
from app.models.master_product import MasterProduct
from app.schemas.inventory import (
    InventoryItemOut,
    InventoryItemUpdate,
    InventoryStatusTransition,
    TargetPricingAsinState,
    TargetPricingBulkApplyOut,
    TargetPricingBulkFilters,
    TargetPricingBulkOperation,
    TargetPricingBulkPreviewOut,
    TargetPricingBulkPreviewRowOut,
    TargetPricingBulkRequest,
    TargetPriceRecommendationOut,
)
from app.schemas.inventory_item_image import InventoryItemImageCreate, InventoryItemImageOut
from app.services.audit import audit_log
from app.services.inventory import transition_status
from app.services.target_pricing import compute_effective_price, compute_recommendation


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

# Statuses considered "in stock" for target-pricing bulk operations.
_BULK_ELIGIBLE_STATUSES = (
    InventoryStatus.DRAFT,
    InventoryStatus.AVAILABLE,
    InventoryStatus.FBA_INBOUND,
    InventoryStatus.FBA_WAREHOUSE,
    InventoryStatus.RESERVED,
    InventoryStatus.RETURNED,
    InventoryStatus.DISCREPANCY,
)


def _enrich_item(
    item: InventoryItem,
    amazon: AmazonProductMetricsLatest | None,
) -> InventoryItemOut:
    """Build an enriched InventoryItemOut with target-pricing recommendation."""
    settings = get_settings()
    rec = compute_recommendation(
        purchase_price_cents=item.purchase_price_cents,
        allocated_costs_cents=item.allocated_costs_cents,
        condition=item.condition.value if hasattr(item.condition, "value") else str(item.condition),
        price_new_cents=getattr(amazon, "price_new_cents", None) if amazon else None,
        price_used_like_new_cents=getattr(amazon, "price_used_like_new_cents", None) if amazon else None,
        price_used_very_good_cents=getattr(amazon, "price_used_very_good_cents", None) if amazon else None,
        price_used_good_cents=getattr(amazon, "price_used_good_cents", None) if amazon else None,
        price_used_acceptable_cents=getattr(amazon, "price_used_acceptable_cents", None) if amazon else None,
        price_buybox_cents=getattr(amazon, "buybox_total_cents", None) if amazon else None,
        rank=getattr(amazon, "rank_specific", None) or getattr(amazon, "rank_overall", None) if amazon else None,
        offers_count=getattr(amazon, "offers_count_used_priced_total", None) or getattr(amazon, "offers_count_total", None) if amazon else None,
        settings=settings,
    )
    effective_cents, source = compute_effective_price(
        mode=item.target_price_mode,
        manual_target_sell_price_cents=item.manual_target_sell_price_cents,
        recommendation=rec,
    )

    base = InventoryItemOut.model_validate(item)
    base.target_price_mode = TargetPriceMode(item.target_price_mode)
    base.manual_target_sell_price_cents = item.manual_target_sell_price_cents
    base.recommended_target_sell_price_cents = rec.recommended_target_sell_price_cents
    base.effective_target_sell_price_cents = effective_cents
    base.effective_target_price_source = source
    base.target_price_recommendation = TargetPriceRecommendationOut(
        strategy=rec.strategy,
        recommended_target_sell_price_cents=rec.recommended_target_sell_price_cents,
        anchor_price_cents=rec.anchor_price_cents,
        anchor_source=rec.anchor_source,
        rank=rec.rank,
        offers_count=rec.offers_count,
        adjustment_bp=rec.adjustment_bp,
        margin_floor_net_cents=rec.margin_floor_net_cents,
        margin_floor_price_cents=rec.margin_floor_price_cents,
        summary=rec.summary,
    )
    return base


async def _load_amazon_map(session: AsyncSession, master_product_ids: set[uuid.UUID]) -> dict[uuid.UUID, AmazonProductMetricsLatest]:
    """Batch-load Amazon metrics for the given master product IDs."""
    if not master_product_ids:
        return {}
    rows = (await session.execute(
        select(AmazonProductMetricsLatest)
        .where(AmazonProductMetricsLatest.master_product_id.in_(master_product_ids))
    )).scalars().all()
    return {r.master_product_id: r for r in rows}


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
    items = (await session.execute(stmt)).scalars().all()

    # Batch-load Amazon metrics + ASINs for enrichment
    mp_ids = {item.master_product_id for item in items}
    amazon_map = await _load_amazon_map(session, mp_ids)

    return [
        _enrich_item(item, amazon_map.get(item.master_product_id))
        for item in items
    ]


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
    actor: str = Depends(require_basic_auth),
) -> InventoryItemOut:
    item = await session.get(InventoryItem, inventory_item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Not found")

    changes = data.model_dump(exclude_unset=True)

    effective_mode = changes.get("target_price_mode", item.target_price_mode)
    # In AUTO mode manual price is always ignored/cleared.
    if effective_mode == TargetPriceMode.AUTO:
        changes["manual_target_sell_price_cents"] = None

    before = {
        "target_price_mode": item.target_price_mode,
        "manual_target_sell_price_cents": item.manual_target_sell_price_cents,
    }

    for k, v in changes.items():
        setattr(item, k, v)
    await session.flush()

    after = {
        "target_price_mode": item.target_price_mode,
        "manual_target_sell_price_cents": item.manual_target_sell_price_cents,
    }
    # Only audit if pricing fields actually changed
    if before != after:
        await audit_log(
            session,
            actor=actor,
            entity_type="inventory_item",
            entity_id=inventory_item_id,
            action="target_price_update",
            before=before,
            after=after,
        )

    await session.commit()
    await session.refresh(item)

    # Load amazon metrics for enrichment
    amazon = (await session.execute(
        select(AmazonProductMetricsLatest)
        .where(AmazonProductMetricsLatest.master_product_id == item.master_product_id)
    )).scalar_one_or_none()
    return _enrich_item(item, amazon)


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

    amazon = (await session.execute(
        select(AmazonProductMetricsLatest)
        .where(AmazonProductMetricsLatest.master_product_id == item.master_product_id)
    )).scalar_one_or_none()
    return _enrich_item(item, amazon)


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


# ---------------------------------------------------------------------------
# Bulk target pricing
# ---------------------------------------------------------------------------

async def _bulk_query(
    session: AsyncSession,
    filters: TargetPricingBulkFilters,
) -> list[tuple[InventoryItem, AmazonProductMetricsLatest | None, MasterProduct]]:
    stmt = (
        select(InventoryItem, AmazonProductMetricsLatest, MasterProduct)
        .join(MasterProduct, MasterProduct.id == InventoryItem.master_product_id)
        .outerjoin(AmazonProductMetricsLatest, AmazonProductMetricsLatest.master_product_id == MasterProduct.id)
        .where(InventoryItem.status.in_(_BULK_ELIGIBLE_STATUSES))
    )

    if filters.conditions:
        stmt = stmt.where(InventoryItem.condition.in_(filters.conditions))

    if filters.asin_state == TargetPricingAsinState.WITH_ASIN:
        stmt = stmt.where(MasterProduct.asin.is_not(None), func.trim(MasterProduct.asin) != "")
    elif filters.asin_state == TargetPricingAsinState.WITHOUT_ASIN:
        stmt = stmt.where(or_(MasterProduct.asin.is_(None), func.trim(MasterProduct.asin) == ""))

    rank_expr = func.coalesce(AmazonProductMetricsLatest.rank_specific, AmazonProductMetricsLatest.rank_overall)
    if filters.bsr_min is not None:
        stmt = stmt.where(rank_expr >= filters.bsr_min)
    if filters.bsr_max is not None:
        stmt = stmt.where(rank_expr <= filters.bsr_max)

    offers_expr = func.coalesce(
        AmazonProductMetricsLatest.offers_count_used_priced_total,
        AmazonProductMetricsLatest.offers_count_total,
    )
    if filters.offers_min is not None:
        stmt = stmt.where(offers_expr >= filters.offers_min)
    if filters.offers_max is not None:
        stmt = stmt.where(offers_expr <= filters.offers_max)

    stmt = stmt.order_by(InventoryItem.created_at.desc())
    rows = (await session.execute(stmt)).all()
    return [(r[0], r[1], r[2]) for r in rows]


def _target_state_for_operation(
    *,
    operation: TargetPricingBulkOperation,
    recommendation_cents: int,
) -> tuple[TargetPriceMode, int | None]:
    if operation == TargetPricingBulkOperation.APPLY_RECOMMENDED_MANUAL:
        return TargetPriceMode.MANUAL, recommendation_cents
    return TargetPriceMode.AUTO, None


@router.post("/target-pricing/preview", response_model=TargetPricingBulkPreviewOut)
async def bulk_target_pricing_preview(
    body: TargetPricingBulkRequest,
    session: AsyncSession = Depends(get_session),
) -> TargetPricingBulkPreviewOut:
    settings = get_settings()
    matched = await _bulk_query(session, body.filters)
    max_rows = 200
    preview_rows: list[TargetPricingBulkPreviewRowOut] = []
    applicable_count = 0

    for item, amazon, mp in matched:
        cond = item.condition.value if hasattr(item.condition, "value") else str(item.condition)
        rank = getattr(amazon, "rank_specific", None) or getattr(amazon, "rank_overall", None) if amazon else None
        offers = (
            getattr(amazon, "offers_count_used_priced_total", None) or getattr(amazon, "offers_count_total", None)
            if amazon
            else None
        )
        rec = compute_recommendation(
            purchase_price_cents=item.purchase_price_cents,
            allocated_costs_cents=item.allocated_costs_cents,
            condition=cond,
            price_new_cents=getattr(amazon, "price_new_cents", None) if amazon else None,
            price_used_like_new_cents=getattr(amazon, "price_used_like_new_cents", None) if amazon else None,
            price_used_very_good_cents=getattr(amazon, "price_used_very_good_cents", None) if amazon else None,
            price_used_good_cents=getattr(amazon, "price_used_good_cents", None) if amazon else None,
            price_used_acceptable_cents=getattr(amazon, "price_used_acceptable_cents", None) if amazon else None,
            price_buybox_cents=getattr(amazon, "buybox_total_cents", None) if amazon else None,
            rank=rank,
            offers_count=offers,
            settings=settings,
        )
        current_eff, current_source = compute_effective_price(
            mode=item.target_price_mode,
            manual_target_sell_price_cents=item.manual_target_sell_price_cents,
            recommendation=rec,
        )

        after_mode, after_manual = _target_state_for_operation(
            operation=body.operation,
            recommendation_cents=rec.recommended_target_sell_price_cents,
        )
        new_eff, new_source = compute_effective_price(
            mode=after_mode,
            manual_target_sell_price_cents=after_manual,
            recommendation=rec,
        )
        before_cfg = (TargetPriceMode(item.target_price_mode), item.manual_target_sell_price_cents)
        after_cfg = (after_mode, after_manual)
        if before_cfg == after_cfg:
            continue

        applicable_count += 1
        delta = (new_eff - current_eff) if current_eff is not None and new_eff is not None else None
        if len(preview_rows) < max_rows:
            asin = mp.asin.strip() if isinstance(mp.asin, str) and mp.asin.strip() else None
            preview_rows.append(
                TargetPricingBulkPreviewRowOut(
                item_id=item.id,
                item_code=item.item_code,
                title=mp.title,
                condition=item.condition,
                asin=asin,
                rank=rank,
                offers_count=offers,
                before_target_price_mode=TargetPriceMode(item.target_price_mode),
                before_effective_target_sell_price_cents=current_eff,
                before_effective_target_price_source=current_source,
                after_target_price_mode=after_mode,
                after_effective_target_sell_price_cents=new_eff,
                after_effective_target_price_source=new_source,
                delta_cents=delta,
                )
            )

    return TargetPricingBulkPreviewOut(
        matched_count=len(matched),
        applicable_count=applicable_count,
        truncated=applicable_count > max_rows,
        rows=preview_rows,
    )


@router.post("/target-pricing/apply", response_model=TargetPricingBulkApplyOut)
async def bulk_target_pricing_apply(
    body: TargetPricingBulkRequest,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> TargetPricingBulkApplyOut:
    settings = get_settings()
    matched = await _bulk_query(session, body.filters)
    updated_count = 0
    skipped_count = 0
    sample_updated_item_ids: list[uuid.UUID] = []

    for item, amazon, _mp in matched:
        cond = item.condition.value if hasattr(item.condition, "value") else str(item.condition)
        rank = getattr(amazon, "rank_specific", None) or getattr(amazon, "rank_overall", None) if amazon else None
        offers = (
            getattr(amazon, "offers_count_used_priced_total", None) or getattr(amazon, "offers_count_total", None)
            if amazon
            else None
        )
        recommendation = compute_recommendation(
            purchase_price_cents=item.purchase_price_cents,
            allocated_costs_cents=item.allocated_costs_cents,
            condition=cond,
            price_new_cents=getattr(amazon, "price_new_cents", None) if amazon else None,
            price_used_like_new_cents=getattr(amazon, "price_used_like_new_cents", None) if amazon else None,
            price_used_very_good_cents=getattr(amazon, "price_used_very_good_cents", None) if amazon else None,
            price_used_good_cents=getattr(amazon, "price_used_good_cents", None) if amazon else None,
            price_used_acceptable_cents=getattr(amazon, "price_used_acceptable_cents", None) if amazon else None,
            price_buybox_cents=getattr(amazon, "buybox_total_cents", None) if amazon else None,
            rank=rank,
            offers_count=offers,
            settings=settings,
        )
        after_mode, after_manual = _target_state_for_operation(
            operation=body.operation,
            recommendation_cents=recommendation.recommended_target_sell_price_cents,
        )
        before = {
            "target_price_mode": item.target_price_mode,
            "manual_target_sell_price_cents": item.manual_target_sell_price_cents,
        }
        item.target_price_mode = after_mode
        item.manual_target_sell_price_cents = after_manual

        after = {
            "target_price_mode": item.target_price_mode,
            "manual_target_sell_price_cents": item.manual_target_sell_price_cents,
        }

        if before == after:
            skipped_count += 1
            continue

        updated_count += 1
        if len(sample_updated_item_ids) < 20:
            sample_updated_item_ids.append(item.id)
        await audit_log(
            session,
            actor=actor,
            entity_type="inventory_item",
            entity_id=item.id,
            action="bulk_target_pricing_apply",
            before=before,
            after=after,
        )

    await session.commit()

    return TargetPricingBulkApplyOut(
        matched_count=len(matched),
        updated_count=updated_count,
        skipped_count=skipped_count,
        sample_updated_item_ids=sample_updated_item_ids,
    )
