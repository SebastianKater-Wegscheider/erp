from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.amazon_scrape import AmazonProductMetricsLatest, AmazonScrapeBestPrice, AmazonScrapeRun, AmazonScrapeSalesRank
from app.models.master_product import MasterProduct, master_product_sku_from_id
from app.services.amazon_scrape_metrics import (
    BUCKET_COLLECTIBLE,
    BUCKET_NEW,
    BUCKET_USED_GOOD,
    BUCKET_USED_LIKE_NEW,
    BUCKET_USED_VERY_GOOD,
    bucket_from_offer,
    compute_best_prices,
    parse_money_to_cents,
    persist_scrape_result,
)


@pytest.mark.asyncio
async def test_parse_money_to_cents() -> None:
    assert parse_money_to_cents(None) is None
    assert parse_money_to_cents("") is None
    assert parse_money_to_cents("0") == 0
    assert parse_money_to_cents("1.23") == 123
    assert parse_money_to_cents("10.00") == 1000
    assert parse_money_to_cents("nope") is None


@pytest.mark.asyncio
async def test_bucket_from_offer_mapping() -> None:
    assert bucket_from_offer(condition_group="new", condition_raw=None) == BUCKET_NEW
    assert bucket_from_offer(condition_group="used", condition_raw="Gebraucht - Wie neu") == BUCKET_USED_LIKE_NEW
    assert bucket_from_offer(condition_group="used", condition_raw="Gebraucht - Gut") == BUCKET_USED_GOOD
    assert bucket_from_offer(condition_group="collectible", condition_raw="Sammlerstueck - Gut") == BUCKET_COLLECTIBLE
    assert bucket_from_offer(condition_group="used", condition_raw="Gebraucht") is None


@pytest.mark.asyncio
async def test_compute_best_prices_selects_min_total() -> None:
    offers = [
        {"condition_group": "new", "condition_raw": "Neu", "price_total": "12.00", "currency": "EUR", "page": 1, "position": 1},
        {"condition_group": "new", "condition_raw": "Neu", "price_total": "10.00", "currency": "EUR", "page": 1, "position": 2},
        {"condition_group": "used", "condition_raw": "Gebraucht - Wie neu", "price_item": "9.00", "price_shipping": "1.00", "currency": "EUR", "page": 1, "position": 3},
    ]
    best = compute_best_prices(offers)
    assert best[BUCKET_NEW].total_cents == 1000
    assert best[BUCKET_USED_LIKE_NEW].total_cents == 1000


@pytest.mark.asyncio
async def test_persist_scrape_result_updates_snapshot(db_session: AsyncSession) -> None:
    mp_id = uuid.uuid4()
    mp = MasterProduct(
        id=mp_id,
        sku=master_product_sku_from_id(mp_id),
        kind="GAME",
        title="Test Product",
        platform="PS2",
        region="EU",
        variant="",
        asin="B000FC2BTQ",
    )
    db_session.add(mp)
    await db_session.commit()

    finished_at = datetime(2026, 2, 10, 20, 0, 10, tzinfo=UTC)
    data = {
        "ts_utc": "2026-02-10T20:00:00Z",
        "marketplace": "amazon.de",
        "asin": "B000FC2BTQ",
        "dp_url": "https://amazon.de/dp/B000FC2BTQ",
        "offer_listing_url": "https://amazon.de/gp/offer-listing/B000FC2BTQ",
        "delivery_zip": "80331",
        "blocked": False,
        "offers_truncated": False,
        "title": "Test Product",
        "buybox": {"total": "11.50", "currency": "EUR"},
        "sales_ranks": [
            {"rank": 12, "category": "Foo", "raw": "#12 in Foo"},
            {"rank": 3, "category": "Bar", "raw": "#3 in Bar"},
        ],
        "sales_rank_overall": {"rank": 12, "category": "Foo"},
        "sales_rank_specific": {"rank": 3, "category": "Bar"},
        "offers": [
            {"condition_group": "new", "condition_raw": "Neu", "price_total": "12.00", "currency": "EUR", "page": 1, "position": 1, "seller_name": "A"},
            {"condition_group": "new", "condition_raw": "Neu", "price_total": "10.00", "currency": "EUR", "page": 1, "position": 2, "seller_name": "B"},
            {"condition_group": "used", "condition_raw": "Gebraucht - Wie neu", "price_item": "9.00", "price_shipping": "1.00", "currency": "EUR", "page": 1, "position": 3, "seller_name": "C"},
            {"condition_group": "used", "condition_raw": "Gebraucht - Sehr gut", "price_total": "8.00", "currency": "EUR", "page": 1, "position": 4, "seller_name": "D"},
            {"condition_group": "used", "condition_raw": "Gebraucht - Gut", "price_total": None, "currency": "EUR", "page": 1, "position": 5, "seller_name": "E"},
        ],
    }

    async with db_session.begin():
        run_id = await persist_scrape_result(
            session=db_session,
            master_product_id=mp_id,
            asin="B000FC2BTQ",
            data=data,
            error=None,
            finished_at=finished_at,
        )

    run = await db_session.get(AmazonScrapeRun, run_id)
    assert run is not None
    assert run.ok is True
    assert run.blocked is False

    ranks = (await db_session.execute(select(AmazonScrapeSalesRank).where(AmazonScrapeSalesRank.run_id == run_id))).scalars().all()
    assert [r.rank for r in ranks] == [12, 3]

    prices = (await db_session.execute(select(AmazonScrapeBestPrice).where(AmazonScrapeBestPrice.run_id == run_id))).scalars().all()
    by_bucket = {p.condition_bucket: p.price_total_cents for p in prices}
    assert by_bucket[BUCKET_NEW] == 1000
    assert by_bucket[BUCKET_USED_LIKE_NEW] == 1000

    latest = await db_session.get(AmazonProductMetricsLatest, mp_id)
    assert latest is not None
    assert latest.last_success_at is not None
    stored = latest.last_success_at if latest.last_success_at.tzinfo is not None else latest.last_success_at.replace(tzinfo=UTC)
    assert stored == finished_at
    assert latest.rank_overall == 12
    assert latest.rank_specific == 3
    assert latest.price_new_cents == 1000
    assert latest.price_used_like_new_cents == 1000
    assert latest.price_used_very_good_cents == 800
    assert latest.buybox_total_cents == 1150
    assert latest.offers_count_total == 5
    assert latest.offers_count_priced_total == 4
    assert latest.offers_count_used_priced_total == 2


@pytest.mark.asyncio
async def test_persist_scrape_result_buybox_fallback_total(db_session: AsyncSession) -> None:
    mp_id = uuid.uuid4()
    mp = MasterProduct(
        id=mp_id,
        sku=master_product_sku_from_id(mp_id),
        kind="GAME",
        title="Test Product",
        platform="PS2",
        region="EU",
        variant="",
        asin="B000FC2BTQ",
    )
    db_session.add(mp)
    await db_session.commit()

    finished_at = datetime(2026, 2, 10, 20, 0, 10, tzinfo=UTC)
    data = {
        "ts_utc": "2026-02-10T20:00:00Z",
        "marketplace": "amazon.de",
        "asin": "B000FC2BTQ",
        "blocked": False,
        "offers_truncated": False,
        "buybox": {"price_item": "10.00", "shipping": "1.50", "currency": "EUR"},
        "sales_ranks": [],
        "offers": [],
    }

    async with db_session.begin():
        await persist_scrape_result(
            session=db_session,
            master_product_id=mp_id,
            asin="B000FC2BTQ",
            data=data,
            error=None,
            finished_at=finished_at,
        )

    latest = await db_session.get(AmazonProductMetricsLatest, mp_id)
    assert latest is not None
    assert latest.buybox_total_cents == 1150


@pytest.mark.asyncio
async def test_persist_scrape_result_persists_best_prices_without_sales_ranks(db_session: AsyncSession) -> None:
    mp_id = uuid.uuid4()
    mp = MasterProduct(
        id=mp_id,
        sku=master_product_sku_from_id(mp_id),
        kind="GAME",
        title="Test Product",
        platform="PS2",
        region="EU",
        variant="",
        asin="B000FC2BTQ",
    )
    db_session.add(mp)
    await db_session.commit()

    finished_at = datetime(2026, 2, 10, 20, 0, 10, tzinfo=UTC)
    data = {
        "ts_utc": "2026-02-10T20:00:00Z",
        "marketplace": "amazon.de",
        "asin": "B000FC2BTQ",
        "blocked": False,
        "offers_truncated": False,
        # Deliberately omit `sales_ranks` to ensure offers are still persisted.
        "offers": [
            {"condition_group": "used", "condition_raw": "Gebraucht - Sehr gut", "price_total": "8.00", "currency": "EUR", "page": 1, "position": 1, "seller_name": "D"},
        ],
    }

    async with db_session.begin():
        run_id = await persist_scrape_result(
            session=db_session,
            master_product_id=mp_id,
            asin="B000FC2BTQ",
            data=data,
            error=None,
            finished_at=finished_at,
        )

    prices = (await db_session.execute(select(AmazonScrapeBestPrice).where(AmazonScrapeBestPrice.run_id == run_id))).scalars().all()
    by_bucket = {p.condition_bucket: p.price_total_cents for p in prices}
    assert by_bucket[BUCKET_USED_VERY_GOOD] == 800
