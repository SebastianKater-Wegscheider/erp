from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from datetime import UTC, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.enums import InventoryStatus, SourcingEvaluationStatus, SourcingPlatform, SourcingStatus
from app.core.config import get_settings
from app.core.db import get_session
from app.core.security import require_basic_auth
from app.models.amazon_scrape import AmazonProductMetricsLatest
from app.models.inventory_item import InventoryItem
from app.models.master_product import MasterProduct
from app.models.sourcing import SourcingAgent, SourcingAgentQuery, SourcingItem, SourcingRun, SourcingSetting
from app.schemas.sourcing import (
    SourcingAgentCreateIn,
    SourcingAgentOut,
    SourcingAgentPatchIn,
    SourcingAgentQueryOut,
    SourcingAgentRunOut,
    SourcingAgentRunQueryOut,
    SourcingCleanseIn,
    SourcingCleanseOut,
    SourcingDiscardIn,
    SourcingEvaluateOut,
    SourcingEvaluationMatchedProductOut,
    SourcingEvaluationResultOut,
    SourcingHealthOut,
    SourcingReviewCatalogAmazonOut,
    SourcingReviewCatalogEntryOut,
    SourcingReviewPacketOut,
    SourcingReviewRunOut,
    SourcingItemDetailOut,
    SourcingItemListOut,
    SourcingItemListResponse,
    SourcingScrapeTriggerIn,
    SourcingScrapeTriggerOut,
    SourcingSettingOut,
    SourcingSettingsUpdateIn,
    SourcingStatsOut,
)
from app.services.sourcing import (
    _merge_detail_payload_into_item,
    _scraper_fetch_listing_detail,
    cleanse_stale_sourcing_items,
    discard_item,
    execute_sourcing_run,
    update_settings_values,
    utcnow,
)
from app.services.sourcing_codex import ensure_supported_platform, queue_item_for_evaluation


router = APIRouter()
_REVIEW_IN_STOCK_STATUSES = (
    InventoryStatus.DRAFT,
    InventoryStatus.AVAILABLE,
    InventoryStatus.FBA_INBOUND,
    InventoryStatus.FBA_WAREHOUSE,
    InventoryStatus.RESERVED,
)


@asynccontextmanager
async def _begin_tx(session: AsyncSession):
    if session.in_transaction():
        async with session.begin_nested():
            yield
        await session.commit()
    else:
        async with session.begin():
            yield


def _evaluation_out(item: SourcingItem) -> SourcingEvaluationResultOut | None:
    if item.evaluation_status != SourcingEvaluationStatus.COMPLETED:
        return None
    payload = item.evaluation_result_json if isinstance(item.evaluation_result_json, dict) else None
    if payload is None:
        return None
    matched = []
    raw_matches = payload.get("matched_products")
    if isinstance(raw_matches, list):
        for entry in raw_matches:
            if not isinstance(entry, dict):
                continue
            matched.append(
                SourcingEvaluationMatchedProductOut(
                    master_product_id=entry.get("master_product_id"),
                    sku=entry.get("sku"),
                    title=entry.get("title"),
                    asin=entry.get("asin"),
                    confidence=entry.get("confidence"),
                    basis=entry.get("basis"),
                )
            )
    return SourcingEvaluationResultOut(
        recommendation=payload.get("recommendation"),
        summary=payload.get("summary"),
        expected_profit_cents=payload.get("expected_profit_cents"),
        expected_roi_bp=payload.get("expected_roi_bp"),
        max_buy_price_cents=payload.get("max_buy_price_cents"),
        confidence=payload.get("confidence"),
        amazon_source_used=payload.get("amazon_source_used"),
        matched_products=matched,
        risks=[str(v) for v in payload.get("risks", []) if isinstance(v, str)],
        reasoning_notes=[str(v) for v in payload.get("reasoning_notes", []) if isinstance(v, str)],
    )


def _item_list_out(item: SourcingItem) -> SourcingItemListOut:
    evaluation_is_current = item.evaluation_status == SourcingEvaluationStatus.COMPLETED
    return SourcingItemListOut(
        id=item.id,
        platform=item.platform,
        agent_id=item.agent_id,
        agent_query_id=item.agent_query_id,
        title=item.title,
        price_cents=item.price_cents,
        location_city=item.location_city,
        primary_image_url=item.primary_image_url,
        status=item.status,
        evaluation_status=item.evaluation_status,
        recommendation=item.recommendation if evaluation_is_current else None,
        evaluation_summary=item.evaluation_summary if evaluation_is_current else None,
        expected_profit_cents=item.expected_profit_cents if evaluation_is_current else None,
        expected_roi_bp=item.expected_roi_bp if evaluation_is_current else None,
        max_buy_price_cents=item.max_buy_price_cents if evaluation_is_current else None,
        evaluation_finished_at=item.evaluation_finished_at,
        evaluation_last_error=item.evaluation_last_error,
        scraped_at=item.scraped_at,
        posted_at=item.posted_at,
        url=item.url,
    )


def _item_detail_out(item: SourcingItem) -> SourcingItemDetailOut:
    evaluation_is_current = item.evaluation_status == SourcingEvaluationStatus.COMPLETED
    return SourcingItemDetailOut(
        id=item.id,
        platform=item.platform,
        external_id=item.external_id,
        agent_id=item.agent_id,
        agent_query_id=item.agent_query_id,
        title=item.title,
        description=item.description,
        price_cents=item.price_cents,
        image_urls=[str(v) for v in (item.image_urls or []) if str(v).strip()],
        primary_image_url=item.primary_image_url,
        location_zip=item.location_zip,
        location_city=item.location_city,
        seller_type=item.seller_type,
        auction_end_at=item.auction_end_at,
        auction_current_price_cents=item.auction_current_price_cents,
        auction_bid_count=item.auction_bid_count,
        status=item.status,
        status_reason=item.status_reason,
        evaluation_status=item.evaluation_status,
        evaluation_queued_at=item.evaluation_queued_at,
        evaluation_started_at=item.evaluation_started_at,
        evaluation_finished_at=item.evaluation_finished_at,
        evaluation_attempt_count=item.evaluation_attempt_count,
        evaluation_last_error=item.evaluation_last_error,
        evaluation_summary=item.evaluation_summary if evaluation_is_current else None,
        evaluation_prompt_version=item.evaluation_prompt_version,
        recommendation=item.recommendation if evaluation_is_current else None,
        expected_profit_cents=item.expected_profit_cents if evaluation_is_current else None,
        expected_roi_bp=item.expected_roi_bp if evaluation_is_current else None,
        max_buy_price_cents=item.max_buy_price_cents if evaluation_is_current else None,
        evaluation_confidence=item.evaluation_confidence if evaluation_is_current else None,
        amazon_source_used=item.amazon_source_used if evaluation_is_current else None,
        evaluation=_evaluation_out(item),
        raw_data=item.raw_data if isinstance(item.raw_data, dict) else None,
        scraped_at=item.scraped_at,
        posted_at=item.posted_at,
        url=item.url,
    )


def _item_has_detail_enrichment(item: SourcingItem) -> bool:
    raw = item.raw_data if isinstance(item.raw_data, dict) else {}
    description_full = str(raw.get("description_full") or "").strip()
    image_urls = raw.get("image_urls") if isinstance(raw.get("image_urls"), list) else item.image_urls or []
    posted_at_text = str(raw.get("posted_at_text") or "").strip()
    description = str(item.description or "").strip()
    has_description = bool(description_full) or (bool(description) and not description.endswith("..."))
    return bool(has_description and image_urls and (posted_at_text or item.posted_at is not None))


async def _ensure_review_item_detail(
    *,
    session: AsyncSession,
    items: list[SourcingItem],
) -> None:
    if not items:
        return

    settings = get_settings()
    changed = False
    for item in items:
        if _item_has_detail_enrichment(item):
            continue
        if not str(item.url or "").strip():
            continue
        try:
            detail_payload = await _scraper_fetch_listing_detail(
                app_settings=settings,
                platform=item.platform,
                url=item.url,
            )
        except Exception:
            continue
        detail = detail_payload.get("listing") if isinstance(detail_payload.get("listing"), dict) else detail_payload
        if not isinstance(detail, dict) or not detail:
            continue
        _merge_detail_payload_into_item(item=item, detail=detail)
        changed = True

    if changed:
        await session.commit()


def _catalog_amazon_out(metrics: AmazonProductMetricsLatest | None) -> SourcingReviewCatalogAmazonOut:
    return SourcingReviewCatalogAmazonOut(
        last_success_at=metrics.last_success_at if metrics else None,
        rank_overall=metrics.rank_overall if metrics else None,
        rank_specific=metrics.rank_specific if metrics else None,
        price_new_cents=metrics.price_new_cents if metrics else None,
        price_used_like_new_cents=metrics.price_used_like_new_cents if metrics else None,
        price_used_very_good_cents=metrics.price_used_very_good_cents if metrics else None,
        price_used_good_cents=metrics.price_used_good_cents if metrics else None,
        price_used_acceptable_cents=metrics.price_used_acceptable_cents if metrics else None,
        buybox_total_cents=metrics.buybox_total_cents if metrics else None,
        offers_count_total=metrics.offers_count_total if metrics else None,
        offers_count_used_priced_total=metrics.offers_count_used_priced_total if metrics else None,
    )


async def _review_catalog(
    *,
    session: AsyncSession,
    in_stock_only: bool,
) -> list[SourcingReviewCatalogEntryOut]:
    stock_counts = (
        select(
            InventoryItem.master_product_id.label("master_product_id"),
            func.count(InventoryItem.id).label("in_stock_count"),
        )
        .where(InventoryItem.status.in_(_REVIEW_IN_STOCK_STATUSES))
        .group_by(InventoryItem.master_product_id)
        .subquery()
    )

    stmt = (
        select(MasterProduct, AmazonProductMetricsLatest, stock_counts.c.in_stock_count)
        .outerjoin(AmazonProductMetricsLatest, AmazonProductMetricsLatest.master_product_id == MasterProduct.id)
        .outerjoin(stock_counts, stock_counts.c.master_product_id == MasterProduct.id)
        .order_by(MasterProduct.kind, MasterProduct.title, MasterProduct.platform, MasterProduct.region, MasterProduct.variant)
    )
    if in_stock_only:
        stmt = stmt.where(func.coalesce(stock_counts.c.in_stock_count, 0) > 0)

    rows = (await session.execute(stmt)).all()
    return [
        SourcingReviewCatalogEntryOut(
            id=mp.id,
            sku=mp.sku,
            kind=mp.kind,
            title=mp.title,
            platform=mp.platform,
            region=mp.region,
            variant=mp.variant,
            asin=mp.asin,
            ean=mp.ean,
            in_stock_count=int(in_stock_count or 0),
            amazon_cached=_catalog_amazon_out(metrics),
        )
        for mp, metrics, in_stock_count in rows
    ]


def _agent_out(row: SourcingAgent) -> SourcingAgentOut:
    return SourcingAgentOut(
        id=row.id,
        name=row.name,
        enabled=row.enabled,
        interval_seconds=row.interval_seconds,
        last_run_at=row.last_run_at,
        next_run_at=row.next_run_at,
        last_error_type=row.last_error_type,
        last_error_message=row.last_error_message,
        created_at=row.created_at,
        updated_at=row.updated_at,
        queries=[
            SourcingAgentQueryOut(
                id=query.id,
                platform=query.platform,
                keyword=query.keyword,
                enabled=query.enabled,
                max_pages=query.max_pages,
                detail_enrichment_enabled=query.detail_enrichment_enabled,
                options_json=query.options_json,
                created_at=query.created_at,
                updated_at=query.updated_at,
            )
            for query in sorted(row.queries, key=lambda q: (q.created_at, q.keyword))
        ],
    )


@router.post("/jobs/scrape", response_model=SourcingScrapeTriggerOut)
async def trigger_sourcing_scrape(data: SourcingScrapeTriggerIn) -> SourcingScrapeTriggerOut:
    settings = get_settings()
    if not settings.sourcing_enabled:
        raise HTTPException(status_code=409, detail="Sourcing is disabled")
    if data.platform is not None:
        try:
            ensure_supported_platform(data.platform)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    result = await execute_sourcing_run(
        force=data.force,
        search_terms=data.search_terms,
        trigger="manual",
        app_settings=settings,
        platform=data.platform,
        options=data.options,
        agent_id=data.agent_id,
        agent_query_id=data.agent_query_id,
    )
    return SourcingScrapeTriggerOut(
        run_id=result.run_id,
        status=result.status,
        started_at=result.started_at,
        finished_at=result.finished_at,
        items_scraped=result.items_scraped,
        items_new=result.items_new,
        items_queued=result.items_queued,
    )


@router.post("/jobs/cleanse", response_model=SourcingCleanseOut)
async def cleanse_sourcing_items(
    data: SourcingCleanseIn,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> SourcingCleanseOut:
    settings = get_settings()
    if not settings.sourcing_enabled:
        raise HTTPException(status_code=409, detail="Sourcing is disabled")
    if data.platform is not None:
        try:
            ensure_supported_platform(data.platform)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    out = await cleanse_stale_sourcing_items(
        session=session,
        actor=actor,
        older_than_days=data.older_than_days,
        limit=data.limit,
        platform=data.platform,
        app_settings=settings,
    )
    return SourcingCleanseOut(
        checked=out.checked,
        discarded=out.discarded,
        kept=out.kept,
        errors=out.errors,
        blocked=out.blocked,
        blocked_reason=out.blocked_reason,
    )


@router.get("/health", response_model=SourcingHealthOut)
async def sourcing_health(session: AsyncSession = Depends(get_session)) -> SourcingHealthOut:
    last_run = (await session.execute(select(SourcingRun).order_by(SourcingRun.started_at.desc()).limit(1))).scalar_one_or_none()
    pending = (
        await session.scalar(
            select(func.count(SourcingItem.id)).where(SourcingItem.evaluation_status == SourcingEvaluationStatus.PENDING)
        )
    ) or 0
    failed = (
        await session.scalar(
            select(func.count(SourcingItem.id)).where(SourcingItem.evaluation_status == SourcingEvaluationStatus.FAILED)
        )
    ) or 0

    if last_run is None:
        return SourcingHealthOut(
            status="degraded",
            last_scrape_at=None,
            scraper_status="idle",
            items_pending_evaluation=int(pending),
            items_failed_evaluation=int(failed),
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
        items_pending_evaluation=int(pending),
        items_failed_evaluation=int(failed),
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
    by_eval_rows = (
        await session.execute(
            select(SourcingItem.evaluation_status, func.count(SourcingItem.id))
            .group_by(SourcingItem.evaluation_status)
            .order_by(SourcingItem.evaluation_status.asc())
        )
    ).all()
    by_rec_rows = (
        await session.execute(
            select(SourcingItem.recommendation, func.count(SourcingItem.id))
            .group_by(SourcingItem.recommendation)
            .order_by(SourcingItem.recommendation.asc().nullslast())
        )
    ).all()

    return SourcingStatsOut(
        total_items_scraped=int(total),
        items_by_status={str(status.value): int(count) for status, count in by_status_rows},
        items_by_evaluation_status={str(status.value): int(count) for status, count in by_eval_rows},
        items_by_recommendation={str(recommendation or "UNSET"): int(count) for recommendation, count in by_rec_rows},
    )


@router.get("/items", response_model=SourcingItemListResponse)
async def list_sourcing_items(
    status: SourcingStatus | None = None,
    evaluation_status: SourcingEvaluationStatus | None = None,
    recommendation: str | None = Query(default=None, max_length=32),
    platform: SourcingPlatform | None = None,
    agent_id: uuid.UUID | None = None,
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
    if evaluation_status is not None:
        stmt = stmt.where(SourcingItem.evaluation_status == evaluation_status)
        count_stmt = count_stmt.where(SourcingItem.evaluation_status == evaluation_status)
    if recommendation is not None and recommendation.strip():
        stmt = stmt.where(SourcingItem.recommendation == recommendation.strip().upper())
        count_stmt = count_stmt.where(SourcingItem.recommendation == recommendation.strip().upper())
    if platform is not None:
        stmt = stmt.where(SourcingItem.platform == platform)
        count_stmt = count_stmt.where(SourcingItem.platform == platform)
    if agent_id is not None:
        stmt = stmt.where(SourcingItem.agent_id == agent_id)
        count_stmt = count_stmt.where(SourcingItem.agent_id == agent_id)

    if sort_by == "posted_at":
        stmt = stmt.order_by(SourcingItem.posted_at.desc().nullslast(), SourcingItem.scraped_at.desc())
    elif sort_by == "evaluation_finished_at":
        stmt = stmt.order_by(SourcingItem.evaluation_finished_at.desc().nullslast(), SourcingItem.scraped_at.desc())
    elif sort_by == "expected_profit":
        stmt = stmt.order_by(SourcingItem.expected_profit_cents.desc().nullslast(), SourcingItem.scraped_at.desc())
    else:
        stmt = stmt.order_by(SourcingItem.scraped_at.desc())

    total = (await session.scalar(count_stmt)) or 0
    items = (await session.execute(stmt.limit(limit).offset(offset))).scalars().all()
    return SourcingItemListResponse(
        items=[_item_list_out(item) for item in items],
        total=int(total),
        limit=limit,
        offset=offset,
    )


@router.get("/items/{item_id}", response_model=SourcingItemDetailOut)
async def get_sourcing_item(item_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> SourcingItemDetailOut:
    item = await session.get(SourcingItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Not found")

    return _item_detail_out(item)


@router.get("/review/latest-packet", response_model=SourcingReviewPacketOut)
async def sourcing_review_latest_packet(
    platform: SourcingPlatform = Query(default=SourcingPlatform.KLEINANZEIGEN),
    limit: int = Query(default=10, ge=1, le=50),
    in_stock_only: bool = Query(default=False),
    ensure_detail: bool = Query(default=True),
    session: AsyncSession = Depends(get_session),
) -> SourcingReviewPacketOut:
    ensure_supported_platform(platform)
    latest_run = (
        await session.execute(
            select(SourcingRun)
            .where(SourcingRun.platform == platform)
            .order_by(SourcingRun.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    stmt = select(SourcingItem).where(SourcingItem.platform == platform)
    if latest_run is not None:
        stmt = stmt.where(SourcingItem.last_run_id == latest_run.id)
    items = (
        await session.execute(
            stmt.order_by(SourcingItem.scraped_at.desc(), SourcingItem.posted_at.desc().nullslast()).limit(limit)
        )
    ).scalars().all()
    if ensure_detail:
        await _ensure_review_item_detail(session=session, items=items)

    return SourcingReviewPacketOut(
        generated_at=utcnow(),
        platform=platform,
        latest_run=(
            SourcingReviewRunOut(
                id=latest_run.id,
                platform=latest_run.platform,
                started_at=latest_run.started_at,
                finished_at=latest_run.finished_at,
                ok=bool(latest_run.ok),
                blocked=bool(latest_run.blocked),
                error_type=latest_run.error_type,
                error_message=latest_run.error_message,
                items_scraped=latest_run.items_scraped,
                items_new=latest_run.items_new,
            )
            if latest_run is not None
            else None
        ),
        items=[_item_detail_out(item) for item in items],
        catalog=await _review_catalog(session=session, in_stock_only=in_stock_only),
    )


@router.post("/items/{item_id}/evaluate", response_model=SourcingEvaluateOut)
async def requeue_sourcing_evaluation(
    item_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    _actor: str = Depends(require_basic_auth),
) -> SourcingEvaluateOut:
    item = await session.get(SourcingItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Not found")
    try:
        ensure_supported_platform(item.platform)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    async with _begin_tx(session):
        queue_item_for_evaluation(item)

    return SourcingEvaluateOut(
        item_id=item.id,
        evaluation_status=item.evaluation_status,
        evaluation_queued_at=item.evaluation_queued_at or utcnow(),
    )


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


@router.get("/agents", response_model=list[SourcingAgentOut])
async def list_sourcing_agents(session: AsyncSession = Depends(get_session)) -> list[SourcingAgentOut]:
    rows = (
        await session.execute(
            select(SourcingAgent)
            .options(selectinload(SourcingAgent.queries))
            .order_by(SourcingAgent.created_at.desc())
        )
    ).scalars().all()
    return [_agent_out(row) for row in rows]


@router.post("/agents", response_model=SourcingAgentOut)
async def create_sourcing_agent(
    data: SourcingAgentCreateIn,
    session: AsyncSession = Depends(get_session),
    _actor: str = Depends(require_basic_auth),
) -> SourcingAgentOut:
    for query in data.queries:
        try:
            ensure_supported_platform(query.platform)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    try:
        async with _begin_tx(session):
            next_run_at = utcnow() if data.enabled else None
            agent = SourcingAgent(
                name=data.name.strip(),
                enabled=data.enabled,
                interval_seconds=int(data.interval_seconds),
                next_run_at=next_run_at,
            )
            session.add(agent)
            await session.flush()

            for query in data.queries:
                session.add(
                    SourcingAgentQuery(
                        agent_id=agent.id,
                        platform=query.platform,
                        keyword=query.keyword.strip(),
                        enabled=query.enabled,
                        max_pages=int(query.max_pages),
                        detail_enrichment_enabled=query.detail_enrichment_enabled,
                        options_json=query.options_json,
                    )
                )
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Duplicate query for platform+keyword") from exc

    row = (
        await session.execute(
            select(SourcingAgent)
            .where(SourcingAgent.id == agent.id)
            .options(selectinload(SourcingAgent.queries))
        )
    ).scalar_one()
    return _agent_out(row)


@router.patch("/agents/{agent_id}", response_model=SourcingAgentOut)
async def patch_sourcing_agent(
    agent_id: uuid.UUID,
    data: SourcingAgentPatchIn,
    session: AsyncSession = Depends(get_session),
    _actor: str = Depends(require_basic_auth),
) -> SourcingAgentOut:
    if data.queries is not None:
        for query in data.queries:
            try:
                ensure_supported_platform(query.platform)
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc

    row = (
        await session.execute(
            select(SourcingAgent)
            .where(SourcingAgent.id == agent_id)
            .options(selectinload(SourcingAgent.queries))
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Not found")

    try:
        async with _begin_tx(session):
            if data.name is not None:
                row.name = data.name.strip()
            if data.enabled is not None:
                row.enabled = bool(data.enabled)
                if row.enabled and row.next_run_at is None:
                    row.next_run_at = utcnow()
                if not row.enabled:
                    row.next_run_at = None
            if data.interval_seconds is not None:
                row.interval_seconds = int(data.interval_seconds)

            if data.queries is not None:
                row.queries.clear()
                await session.flush()
                for query in data.queries:
                    row.queries.append(
                        SourcingAgentQuery(
                            agent_id=row.id,
                            platform=query.platform,
                            keyword=query.keyword.strip(),
                            enabled=query.enabled,
                            max_pages=int(query.max_pages),
                            detail_enrichment_enabled=query.detail_enrichment_enabled,
                            options_json=query.options_json,
                        )
                    )
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Duplicate query for platform+keyword") from exc

    refreshed = (
        await session.execute(
            select(SourcingAgent)
            .where(SourcingAgent.id == agent_id)
            .options(selectinload(SourcingAgent.queries))
        )
    ).scalar_one()
    return _agent_out(refreshed)


@router.delete("/agents/{agent_id}", status_code=200)
async def delete_sourcing_agent(
    agent_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    _actor: str = Depends(require_basic_auth),
) -> None:
    row = await session.get(SourcingAgent, agent_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Not found")
    async with _begin_tx(session):
        await session.delete(row)


@router.post("/agents/{agent_id}/run", response_model=SourcingAgentRunOut)
async def run_sourcing_agent_now(
    agent_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    _actor: str = Depends(require_basic_auth),
) -> SourcingAgentRunOut:
    agent = (
        await session.execute(
            select(SourcingAgent)
            .where(SourcingAgent.id == agent_id)
            .options(selectinload(SourcingAgent.queries))
        )
    ).scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail="Not found")

    started = utcnow()
    results: list[SourcingAgentRunQueryOut] = []
    app_settings = get_settings()
    for query in [q for q in agent.queries if q.enabled]:
        try:
            ensure_supported_platform(query.platform)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        run_result = await execute_sourcing_run(
            force=True,
            search_terms=[query.keyword],
            trigger="manual-agent",
            app_settings=app_settings,
            platform=query.platform,
            options=query.options_json if isinstance(query.options_json, dict) else None,
            agent_id=agent.id,
            agent_query_id=query.id,
            max_pages=query.max_pages,
            detail_enrichment_enabled=query.detail_enrichment_enabled,
        )
        results.append(
            SourcingAgentRunQueryOut(
                agent_query_id=query.id,
                run_id=run_result.run_id,
                status=run_result.status,
                items_scraped=run_result.items_scraped,
                items_new=run_result.items_new,
                items_queued=run_result.items_queued,
            )
        )

    async with _begin_tx(session):
        agent.last_run_at = utcnow()
        agent.next_run_at = agent.last_run_at
        if agent.interval_seconds:
            agent.next_run_at = agent.last_run_at + timedelta(seconds=max(3600, int(agent.interval_seconds)))
        agent.last_error_type = None
        agent.last_error_message = None

    return SourcingAgentRunOut(agent_id=agent.id, run_started_at=started, results=results)


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
