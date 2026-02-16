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
from app.models.amazon_scrape import AmazonProductMetricsLatest
from app.models.inventory_item import InventoryItem
from app.models.inventory_item_image import InventoryItemImage
from app.models.master_product import MasterProduct
from app.core.security import require_basic_auth
from app.schemas.inventory import (
    BulkTargetPricingApplyResponse,
    BulkTargetPricingPreviewResponse,
    BulkTargetPricingPreviewRow,
    BulkTargetPricingRequest,
    BulkTargetPricingFilters,
    InventoryItemOut,
    InventoryItemUpdate,
    InventoryStatusTransition,
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
    asin: str | None,
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


async def _load_asin_map(session: AsyncSession, master_product_ids: set[uuid.UUID]) -> dict[uuid.UUID, str | None]:
    """Batch-load ASINs for the given master product IDs."""
    if not master_product_ids:
        return {}
    rows = (await session.execute(
        select(MasterProduct.id, MasterProduct.asin)
        .where(MasterProduct.id.in_(master_product_ids))
    )).all()
    return {r[0]: (r[1].strip() if r[1] else None) for r in rows}


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
    asin_map = await _load_asin_map(session, mp_ids)

    return [
        _enrich_item(item, amazon_map.get(item.master_product_id), asin_map.get(item.master_product_id))
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

    # If switching to AUTO, clear manual price
    if changes.get("target_price_mode") == TargetPriceMode.AUTO:
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
    mp = await session.get(MasterProduct, item.master_product_id)
    asin = (mp.asin.strip() if mp and mp.asin else None)

    return _enrich_item(item, amazon, asin)


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
    mp = await session.get(MasterProduct, item.master_product_id)
    asin = (mp.asin.strip() if mp and mp.asin else None)

    return _enrich_item(item, amazon, asin)


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

# ---------------------------------------------------------------------------
# Bulk target pricing
# ---------------------------------------------------------------------------

async def _bulk_query(
    session: AsyncSession,
    filters: BulkTargetPricingFilters,
) -> list[tuple[InventoryItem, AmazonProductMetricsLatest | None, MasterProduct]]:
    """Build and execute the bulk-filter query, returning matched (item, amazon, mp) triples."""
    stmt = (
        select(InventoryItem, AmazonProductMetricsLatest, MasterProduct)
        .join(MasterProduct, MasterProduct.id == InventoryItem.master_product_id)
        .outerjoin(AmazonProductMetricsLatest, AmazonProductMetricsLatest.master_product_id == MasterProduct.id)
        .where(InventoryItem.status.in_(_BULK_ELIGIBLE_STATUSES))
    )

    if filters.match_status:
        stmt = stmt.where(InventoryItem.status.in_(filters.match_status))

    if filters.match_target_price_mode:
        stmt = stmt.where(InventoryItem.target_price_mode.in_(filters.match_target_price_mode))

    if filters.match_search_query:
        needle = filters.match_search_query.strip()
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
                    MasterProduct.ean.ilike(pat),
                    MasterProduct.asin.ilike(pat),
                )
            )

    if filters.match_asin_state:
        # Complex OR logic for multiple states is hard to combine efficiency.
        # We will add checks. If multiple are selected, we OR them.
        state_checks = []
        for state in filters.match_asin_state:
            if state == "MISSING":
                state_checks.append(or_(MasterProduct.asin.is_(None), func.trim(MasterProduct.asin) == ""))
            elif state == "BLOCKED":
                state_checks.append(AmazonProductMetricsLatest.blocked_last.is_(True))
            elif state == "FRESH":
                # Arbitrary: successfully scraped in last 48h (and not blocked)
                fresh_after = datetime.now(timezone.utc) - timedelta(hours=48)
                state_checks.append(
                    (AmazonProductMetricsLatest.last_success_at >= fresh_after) &
                    (AmazonProductMetricsLatest.blocked_last.is_not(True))
                )
            elif state == "STALE":
                 # Not fresh and not blocked (includes never scraped)
                fresh_after = datetime.now(timezone.utc) - timedelta(hours=48)
                state_checks.append(
                    or_(
                        AmazonProductMetricsLatest.last_success_at.is_(None),
                        AmazonProductMetricsLatest.last_success_at < fresh_after
                    ) & (AmazonProductMetricsLatest.blocked_last.is_not(True))
                )

        if state_checks:
            stmt = stmt.where(or_(*state_checks))

    stmt = stmt.order_by(InventoryItem.created_at.desc())
    rows = (await session.execute(stmt)).all()
    return [(r[0], r[1], r[2]) for r in rows]


@router.post("/target-pricing/preview", response_model=BulkTargetPricingPreviewResponse)
async def bulk_target_pricing_preview(
    body: BulkTargetPricingRequest,
    session: AsyncSession = Depends(get_session),
) -> BulkTargetPricingPreviewResponse:
    settings = get_settings()
    matched = await _bulk_query(session, body.filters)
    max_rows = 200
    preview_rows: list[BulkTargetPricingPreviewRow] = []
    
    changed_count = 0

    for item, amazon, mp in matched:
        # Calculate current effective price
        cond = item.condition.value if hasattr(item.condition, "value") else str(item.condition)
        rec = compute_recommendation(
            purchase_price_cents=item.purchase_price_cents,
            allocated_costs_cents=item.allocated_costs_cents,
            condition=cond,
            price_new_cents=getattr(amazon, "price_new_cents", None) if amazon else None,
            price_used_like_new_cents=getattr(amazon, "price_used_like_new_cents", None) if amazon else None,
            price_used_very_good_cents=getattr(amazon, "price_used_very_good_cents", None) if amazon else None,
            price_used_good_cents=getattr(amazon, "price_used_good_cents", None) if amazon else None,
            price_used_acceptable_cents=getattr(amazon, "price_used_acceptable_cents", None) if amazon else None,
            rank=getattr(amazon, "rank_specific", None) or getattr(amazon, "rank_overall", None) if amazon else None,
            offers_count=getattr(amazon, "offers_count_used_priced_total", None) or getattr(amazon, "offers_count_total", None) if amazon else None,
            settings=settings,
        )
        current_eff, _ = compute_effective_price(
            mode=item.target_price_mode,
            manual_target_sell_price_cents=item.manual_target_sell_price_cents,
            recommendation=rec,
        )

        # Calculate new effective price
        # logic: we simulate the change on the item
        sim_mode = body.set_target_price_mode
        sim_manual = body.set_manual_target_sell_price_cents if sim_mode == TargetPriceMode.MANUAL else None
        
        new_eff, new_source = compute_effective_price(
            mode=sim_mode,
            manual_target_sell_price_cents=sim_manual,
            recommendation=rec,
        )

        # Detect if meaningful change
        has_change = False
        if item.target_price_mode != sim_mode:
            has_change = True
        elif sim_mode == TargetPriceMode.MANUAL and item.manual_target_sell_price_cents != sim_manual:
            has_change = True
        
        # If result is strictly identical (same effective price and source), maybe user doesn't care?
        # But we track "configuration change".
        
        if has_change:
            changed_count += 1

        delta = (new_eff - current_eff) if current_eff is not None and new_eff is not None else None

        if len(preview_rows) < max_rows and has_change:
            preview_rows.append(BulkTargetPricingPreviewRow(
                item_id=item.id,
                item_code=item.item_code,
                title=mp.title,
                current_mode=TargetPriceMode(item.target_price_mode),
                current_effective_cents=current_eff,
                new_mode=sim_mode,
                new_manual_cents=sim_manual,
                new_effective_cents=new_eff,
                new_effective_source=new_source,
                diff_cents=delta,
            ))

    return BulkTargetPricingPreviewResponse(
        total_items_matched=len(matched),
        total_items_changed=changed_count,
        preview_rows=preview_rows,
    )


@router.post("/target-pricing/apply", response_model=BulkTargetPricingApplyResponse)
async def bulk_target_pricing_apply(
    body: BulkTargetPricingRequest,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> BulkTargetPricingApplyResponse:
    matched = await _bulk_query(session, body.filters)
    updated_count = 0

    for item, amazon, mp in matched:
        before = {
            "target_price_mode": item.target_price_mode,
            "manual_target_sell_price_cents": item.manual_target_sell_price_cents,
        }
        
        # Apply changes
        item.target_price_mode = body.set_target_price_mode
        if body.set_target_price_mode == TargetPriceMode.MANUAL:
             item.manual_target_sell_price_cents = body.set_manual_target_sell_price_cents
        else:
             item.manual_target_sell_price_cents = None

        after = {
            "target_price_mode": item.target_price_mode,
            "manual_target_sell_price_cents": item.manual_target_sell_price_cents,
        }

        if before == after:
            continue

        updated_count += 1
        await audit_log(
            session,
            actor=actor,
            entity_type="inventory_item",
            entity_id=item.id,
            action="bulk_target_price_update",
            before=before,
            after=after,
        )

    await session.commit()

    return BulkTargetPricingApplyResponse(
        updated_count=updated_count,
    )
