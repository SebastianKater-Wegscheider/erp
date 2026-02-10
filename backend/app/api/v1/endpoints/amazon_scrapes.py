from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.core.db import get_session
from app.models.amazon_scrape import AmazonScrapeRun
from app.models.master_product import MasterProduct
from app.schemas.amazon_scrape import (
    AmazonScrapeRunOut,
    AmazonScrapeStatusOut,
    AmazonScrapeTriggerIn,
    AmazonScrapeTriggerOut,
    AmazonScrapeSalesRankOut,
    AmazonScrapeBestPriceOut,
)
from app.services.amazon_scrape_metrics import ScraperBusyError, scrape_master_product_once
from app.services.amazon_scrape_scheduler import amazon_scrape_due_counts


router = APIRouter()


@router.get("/status", response_model=AmazonScrapeStatusOut)
async def amazon_scrape_status() -> AmazonScrapeStatusOut:
    settings = get_settings()
    counts = await amazon_scrape_due_counts(settings)
    return AmazonScrapeStatusOut(enabled=settings.amazon_scraper_enabled, **counts)


@router.post("/trigger", response_model=AmazonScrapeTriggerOut, status_code=202)
async def trigger_amazon_scrape(
    data: AmazonScrapeTriggerIn, session: AsyncSession = Depends(get_session)
) -> AmazonScrapeTriggerOut:
    settings = get_settings()
    mp = await session.get(MasterProduct, data.master_product_id)
    if mp is None:
        raise HTTPException(status_code=404, detail="Master product not found")
    asin = (mp.asin or "").strip()
    if not asin:
        raise HTTPException(status_code=400, detail="Master product has no ASIN")

    try:
        async with session.begin():
            run_id = await scrape_master_product_once(
                session=session,
                settings=settings,
                master_product_id=mp.id,
                asin=asin,
            )
            run = await session.get(AmazonScrapeRun, run_id)
    except ScraperBusyError:
        raise HTTPException(status_code=429, detail="Scraper busy")

    return AmazonScrapeTriggerOut(
        run_id=run_id,
        ok=bool(run.ok) if run is not None else False,
        blocked=bool(run.blocked) if run is not None else False,
        error=run.error if run is not None else None,
    )


@router.get("/runs/{run_id}", response_model=AmazonScrapeRunOut)
async def get_amazon_scrape_run(
    run_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> AmazonScrapeRunOut:
    run = (
        (
            await session.execute(
                select(AmazonScrapeRun)
                .where(AmazonScrapeRun.id == run_id)
                .options(
                    selectinload(AmazonScrapeRun.sales_ranks),
                    selectinload(AmazonScrapeRun.best_prices),
                )
            )
        )
        .scalars()
        .one_or_none()
    )
    if run is None:
        raise HTTPException(status_code=404, detail="Not found")

    return AmazonScrapeRunOut(
        id=run.id,
        master_product_id=run.master_product_id,
        asin=run.asin,
        marketplace=run.marketplace,
        started_at=run.started_at,
        finished_at=run.finished_at,
        ok=run.ok,
        blocked=run.blocked,
        block_reason=run.block_reason,
        offers_truncated=run.offers_truncated,
        error=run.error,
        title=run.title,
        dp_url=run.dp_url,
        offer_listing_url=run.offer_listing_url,
        delivery_zip=run.delivery_zip,
        sales_ranks=[
            AmazonScrapeSalesRankOut(idx=r.idx, rank=r.rank, category=r.category, raw=r.raw)
            for r in (run.sales_ranks or [])
        ],
        best_prices=[
            AmazonScrapeBestPriceOut(
                condition_bucket=b.condition_bucket,
                price_total_cents=b.price_total_cents,
                currency=b.currency,
                source_offer_page=b.source_offer_page,
                source_offer_position=b.source_offer_position,
                source_seller_name=b.source_seller_name,
            )
            for b in (run.best_prices or [])
        ],
    )

