from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from datetime import UTC

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.core.db import get_session
from app.core.enums import SourcingStatus
from app.core.security import require_basic_auth
from app.models.sourcing import SourcingItem, SourcingMatch, SourcingRun, SourcingSetting
from app.schemas.sourcing import (
    SourcingConversionPreviewIn,
    SourcingConversionPreviewOut,
    SourcingConvertIn,
    SourcingConvertOut,
    SourcingDiscardIn,
    SourcingHealthOut,
    SourcingItemDetailOut,
    SourcingItemListOut,
    SourcingItemListResponse,
    SourcingMatchMasterProductOut,
    SourcingMatchOut,
    SourcingMatchPatchIn,
    SourcingMatchPatchOut,
    SourcingScrapeTriggerIn,
    SourcingScrapeTriggerOut,
    SourcingSettingOut,
    SourcingSettingsUpdateIn,
    SourcingStatsOut,
)
from app.services.sourcing import (
    build_conversion_preview,
    convert_item_to_purchase,
    discard_item,
    execute_sourcing_run,
    load_resolved_settings,
    recalculate_item_from_matches,
    update_settings_values,
)


router = APIRouter()


@asynccontextmanager
async def _begin_tx(session: AsyncSession):
    if session.in_transaction():
        async with session.begin_nested():
            yield
    else:
        async with session.begin():
            yield


@router.post("/jobs/scrape", response_model=SourcingScrapeTriggerOut)
async def trigger_sourcing_scrape(data: SourcingScrapeTriggerIn) -> SourcingScrapeTriggerOut:
    settings = get_settings()
    if not settings.sourcing_enabled:
        raise HTTPException(status_code=409, detail="Sourcing is disabled")

    result = await execute_sourcing_run(
        force=data.force,
        search_terms=data.search_terms,
        trigger="manual",
        app_settings=settings,
    )
    return SourcingScrapeTriggerOut(
        run_id=result.run_id,
        status=result.status,
        started_at=result.started_at,
        finished_at=result.finished_at,
        items_scraped=result.items_scraped,
        items_new=result.items_new,
        items_ready=result.items_ready,
    )


@router.get("/health", response_model=SourcingHealthOut)
async def sourcing_health(session: AsyncSession = Depends(get_session)) -> SourcingHealthOut:
    last_run = (await session.execute(select(SourcingRun).order_by(SourcingRun.started_at.desc()).limit(1))).scalar_one_or_none()
    pending = (
        await session.scalar(
            select(func.count(SourcingItem.id)).where(SourcingItem.status.in_([SourcingStatus.NEW, SourcingStatus.ANALYZING]))
        )
    ) or 0

    if last_run is None:
        return SourcingHealthOut(
            status="degraded",
            last_scrape_at=None,
            scraper_status="idle",
            items_pending_analysis=int(pending),
            last_error_type=None,
            last_error_message=None,
        )

    finished_at = last_run.finished_at
    if finished_at is not None and finished_at.tzinfo is None:
        finished_at = finished_at.replace(tzinfo=UTC)

    status = "healthy"
    scraper_status = "running"
    if bool(last_run.blocked):
        status = "degraded"
        scraper_status = "blocked"
    elif bool(last_run.error_type):
        status = "degraded"
        scraper_status = "error"

    return SourcingHealthOut(
        status=status,
        last_scrape_at=finished_at,
        scraper_status=scraper_status,
        items_pending_analysis=int(pending),
        last_error_type=last_run.error_type,
        last_error_message=last_run.error_message,
    )


@router.get("/stats", response_model=SourcingStatsOut)
async def sourcing_stats(session: AsyncSession = Depends(get_session)) -> SourcingStatsOut:
    total = (await session.scalar(select(func.count(SourcingItem.id)))) or 0

    by_status_rows = (
        await session.execute(
            select(SourcingItem.status, func.count(SourcingItem.id))
            .group_by(SourcingItem.status)
            .order_by(SourcingItem.status.asc())
        )
    ).all()

    avg_profit = (
        await session.scalar(
            select(func.coalesce(func.avg(SourcingItem.estimated_profit_cents), 0)).where(SourcingItem.status == SourcingStatus.READY)
        )
    ) or 0

    converted = (
        await session.scalar(select(func.count(SourcingItem.id)).where(SourcingItem.status == SourcingStatus.CONVERTED))
    ) or 0

    conversion_rate_bp = int((int(converted) / int(total)) * 10_000) if int(total) > 0 else 0

    return SourcingStatsOut(
        total_items_scraped=int(total),
        items_by_status={str(status.value): int(count) for status, count in by_status_rows},
        avg_profit_cents=int(avg_profit),
        conversion_rate_bp=conversion_rate_bp,
    )


@router.get("/items", response_model=SourcingItemListResponse)
async def list_sourcing_items(
    status: SourcingStatus | None = None,
    min_profit_cents: int | None = Query(default=None, ge=0),
    sort_by: str = Query(default="scraped_at"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_session),
) -> SourcingItemListResponse:
    stmt = select(SourcingItem)
    count_stmt = select(func.count(SourcingItem.id))

    if status is not None:
        stmt = stmt.where(SourcingItem.status == status)
        count_stmt = count_stmt.where(SourcingItem.status == status)
    if min_profit_cents is not None:
        stmt = stmt.where(SourcingItem.estimated_profit_cents >= min_profit_cents)
        count_stmt = count_stmt.where(SourcingItem.estimated_profit_cents >= min_profit_cents)

    if sort_by == "profit":
        stmt = stmt.order_by(SourcingItem.estimated_profit_cents.desc().nullslast(), SourcingItem.scraped_at.desc())
    elif sort_by == "roi":
        stmt = stmt.order_by(SourcingItem.estimated_roi_bp.desc().nullslast(), SourcingItem.scraped_at.desc())
    else:
        stmt = stmt.order_by(SourcingItem.scraped_at.desc())

    total = (await session.scalar(count_stmt)) or 0
    items = (await session.execute(stmt.limit(limit).offset(offset))).scalars().all()

    out: list[SourcingItemListOut] = []
    for item in items:
        match_count = (
            await session.scalar(select(func.count(SourcingMatch.id)).where(SourcingMatch.sourcing_item_id == item.id))
        ) or 0
        out.append(
            SourcingItemListOut(
                id=item.id,
                platform=item.platform,
                title=item.title,
                price_cents=item.price_cents,
                location_city=item.location_city,
                primary_image_url=item.primary_image_url,
                estimated_profit_cents=item.estimated_profit_cents,
                estimated_roi_bp=item.estimated_roi_bp,
                status=item.status,
                scraped_at=item.scraped_at,
                url=item.url,
                match_count=int(match_count),
            )
        )

    return SourcingItemListResponse(items=out, total=int(total), limit=limit, offset=offset)


@router.get("/items/{item_id}", response_model=SourcingItemDetailOut)
async def get_sourcing_item(item_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> SourcingItemDetailOut:
    item = (
        await session.execute(
            select(SourcingItem)
            .where(SourcingItem.id == item_id)
            .options(selectinload(SourcingItem.matches).selectinload(SourcingMatch.master_product))
        )
    ).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=404, detail="Not found")

    matches = [
        SourcingMatchOut(
            id=match.id,
            master_product=SourcingMatchMasterProductOut(
                id=match.master_product.id,
                title=match.master_product.title,
                platform=match.master_product.platform,
                asin=match.master_product.asin,
            ),
            confidence_score=match.confidence_score,
            match_method=match.match_method,
            matched_substring=match.matched_substring,
            snapshot_bsr=match.snapshot_bsr,
            snapshot_new_price_cents=match.snapshot_new_price_cents,
            snapshot_used_price_cents=match.snapshot_used_price_cents,
            snapshot_fba_payout_cents=match.snapshot_fba_payout_cents,
            user_confirmed=match.user_confirmed,
            user_rejected=match.user_rejected,
            user_adjusted_condition=match.user_adjusted_condition,
        )
        for match in item.matches
    ]

    return SourcingItemDetailOut(
        id=item.id,
        platform=item.platform,
        title=item.title,
        description=item.description,
        price_cents=item.price_cents,
        image_urls=[str(v) for v in (item.image_urls or [])],
        location_zip=item.location_zip,
        location_city=item.location_city,
        status=item.status,
        status_reason=item.status_reason,
        estimated_revenue_cents=item.estimated_revenue_cents,
        estimated_profit_cents=item.estimated_profit_cents,
        estimated_roi_bp=item.estimated_roi_bp,
        scraped_at=item.scraped_at,
        analyzed_at=item.analyzed_at,
        url=item.url,
        matches=matches,
    )


@router.patch("/items/{item_id}/matches/{match_id}", response_model=SourcingMatchPatchOut)
async def patch_sourcing_match(
    item_id: uuid.UUID,
    match_id: uuid.UUID,
    data: SourcingMatchPatchIn,
    session: AsyncSession = Depends(get_session),
) -> SourcingMatchPatchOut:
    match = await session.get(SourcingMatch, match_id)
    if match is None or match.sourcing_item_id != item_id:
        raise HTTPException(status_code=404, detail="Match not found")

    item = await session.get(SourcingItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")

    changes = data.model_dump(exclude_unset=True)
    if "user_confirmed" in changes:
        match.user_confirmed = bool(changes["user_confirmed"])
        if match.user_confirmed:
            match.user_rejected = False
    if "user_rejected" in changes:
        match.user_rejected = bool(changes["user_rejected"])
        if match.user_rejected:
            match.user_confirmed = False
    if "user_adjusted_condition" in changes:
        match.user_adjusted_condition = changes["user_adjusted_condition"]

    await session.flush()

    item_matches = (
        await session.execute(select(SourcingMatch).where(SourcingMatch.sourcing_item_id == item.id))
    ).scalars().all()
    confirmed_only = any(m.user_confirmed and not m.user_rejected for m in item_matches)

    await recalculate_item_from_matches(session=session, item=item, confirmed_only=confirmed_only)
    await session.commit()

    return SourcingMatchPatchOut(
        item_id=item.id,
        match_id=match.id,
        status=item.status,
        estimated_revenue_cents=item.estimated_revenue_cents,
        estimated_profit_cents=item.estimated_profit_cents,
        estimated_roi_bp=item.estimated_roi_bp,
    )


@router.post("/items/{item_id}/conversion-preview", response_model=SourcingConversionPreviewOut)
async def conversion_preview(
    item_id: uuid.UUID,
    data: SourcingConversionPreviewIn,
    session: AsyncSession = Depends(get_session),
) -> SourcingConversionPreviewOut:
    item = (
        await session.execute(
            select(SourcingItem)
            .where(SourcingItem.id == item_id)
            .options(selectinload(SourcingItem.matches))
        )
    ).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=404, detail="Not found")

    cfg = await load_resolved_settings(session)
    try:
        return await build_conversion_preview(
            session=session,
            item=item,
            cfg=cfg,
            confirmed_match_ids=data.confirmed_match_ids,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e


@router.post("/items/{item_id}/convert", response_model=SourcingConvertOut)
async def convert_item(
    item_id: uuid.UUID,
    data: SourcingConvertIn,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> SourcingConvertOut:
    app_settings = get_settings()
    if not app_settings.sourcing_conversion_enabled:
        raise HTTPException(status_code=409, detail="Sourcing conversion is disabled")

    item = (
        await session.execute(
            select(SourcingItem)
            .where(SourcingItem.id == item_id)
            .options(selectinload(SourcingItem.matches))
        )
    ).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=404, detail="Not found")

    cfg = await load_resolved_settings(session, app_settings)

    try:
        async with _begin_tx(session):
            out = await convert_item_to_purchase(
                session=session,
                actor=actor,
                item=item,
                cfg=cfg,
                confirmed_match_ids=data.confirmed_match_ids,
            )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    return out


@router.post("/items/{item_id}/discard", status_code=200)
async def discard_sourcing_item(
    item_id: uuid.UUID,
    data: SourcingDiscardIn,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> None:
    item = await session.get(SourcingItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Not found")

    async with _begin_tx(session):
        await discard_item(session=session, actor=actor, item=item, reason=data.reason)


@router.get("/settings", response_model=list[SourcingSettingOut])
async def list_sourcing_settings(session: AsyncSession = Depends(get_session)) -> list[SourcingSettingOut]:
    rows = (await session.execute(select(SourcingSetting).order_by(SourcingSetting.key.asc()))).scalars().all()
    return [SourcingSettingOut.model_validate(row) for row in rows]


@router.put("/settings", response_model=list[SourcingSettingOut])
async def put_sourcing_settings(
    data: SourcingSettingsUpdateIn,
    session: AsyncSession = Depends(get_session),
    _actor: str = Depends(require_basic_auth),
) -> list[SourcingSettingOut]:
    payload = {
        key: value.model_dump(exclude_unset=True)
        for key, value in data.values.items()
    }

    async with _begin_tx(session):
        await update_settings_values(session=session, values=payload)

    rows = (await session.execute(select(SourcingSetting).order_by(SourcingSetting.key.asc()))).scalars().all()
    return [SourcingSettingOut.model_validate(row) for row in rows]
