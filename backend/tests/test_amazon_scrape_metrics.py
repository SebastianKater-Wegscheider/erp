from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.amazon_scrape import AmazonProductMetricsLatest, AmazonScrapeBestPrice, AmazonScrapeRun, AmazonScrapeSalesRank
from app.models.master_product import MasterProduct, master_product_sku_from_id
from app.services.amazon_scrape_metrics import (
    BUCKET_COLLECTIBLE,
    BUCKET_NEW,
    ScraperBusyError,
    _store_reference_image_locally,
    BUCKET_USED_GOOD,
    BUCKET_USED_LIKE_NEW,
    BUCKET_USED_VERY_GOOD,
    bucket_from_offer,
    compute_best_prices,
    fetch_scraper_json,
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
async def test_fetch_scraper_json_retries_transport_error_then_succeeds(monkeypatch) -> None:
    settings = get_settings()
    calls: list[int] = []

    async def _fast_sleep(_seconds: float) -> None:
        return None

    class _Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

        async def get(self, _url: str, *, params: dict[str, str]):
            calls.append(1)
            req = httpx.Request("GET", "http://scraper.local/api/scrape", params=params)
            if len(calls) == 1:
                raise httpx.ConnectError("connect failed", request=req)
            return httpx.Response(200, request=req, json={"asin": params["asin"], "blocked": False, "offers": []})

    monkeypatch.setattr("app.services.amazon_scrape_metrics.httpx.AsyncClient", _Client)
    monkeypatch.setattr("app.services.amazon_scrape_metrics.asyncio.sleep", _fast_sleep)

    out = await fetch_scraper_json(settings=settings, asin="B000FC2BTQ")
    assert out["asin"] == "B000FC2BTQ"
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_fetch_scraper_json_retries_retryable_5xx_then_succeeds(monkeypatch) -> None:
    settings = get_settings()
    calls: list[int] = []

    async def _fast_sleep(_seconds: float) -> None:
        return None

    class _Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

        async def get(self, _url: str, *, params: dict[str, str]):
            calls.append(1)
            req = httpx.Request("GET", "http://scraper.local/api/scrape", params=params)
            if len(calls) == 1:
                return httpx.Response(500, request=req, text="upstream failed")
            return httpx.Response(200, request=req, json={"asin": params["asin"], "blocked": False, "offers": []})

    monkeypatch.setattr("app.services.amazon_scrape_metrics.httpx.AsyncClient", _Client)
    monkeypatch.setattr("app.services.amazon_scrape_metrics.asyncio.sleep", _fast_sleep)

    out = await fetch_scraper_json(settings=settings, asin="B000FC2BTQ")
    assert out["asin"] == "B000FC2BTQ"
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_fetch_scraper_json_raises_busy_without_retry(monkeypatch) -> None:
    settings = get_settings()
    calls: list[int] = []

    class _Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

        async def get(self, _url: str, *, params: dict[str, str]):
            calls.append(1)
            req = httpx.Request("GET", "http://scraper.local/api/scrape", params=params)
            return httpx.Response(429, request=req, headers={"retry-after": "12"})

    monkeypatch.setattr("app.services.amazon_scrape_metrics.httpx.AsyncClient", _Client)

    with pytest.raises(ScraperBusyError) as exc:
        await fetch_scraper_json(settings=settings, asin="B000FC2BTQ")

    assert exc.value.retry_after_seconds == 12
    assert len(calls) == 1


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
        "image_url": "https://m.media-amazon.com/images/I/81example.jpg",
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
            settings=None,
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

    mp_updated = await db_session.get(MasterProduct, mp_id)
    assert mp_updated is not None
    assert mp_updated.reference_image_url == "https://m.media-amazon.com/images/I/81example.jpg"


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
            settings=None,
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
async def test_persist_scrape_result_image_fallback_from_asin(db_session: AsyncSession) -> None:
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
        "title": "Test Product",
        "sales_ranks": [],
        "offers": [],
    }

    async with db_session.begin():
        await persist_scrape_result(
            session=db_session,
            settings=None,
            master_product_id=mp_id,
            asin="B000FC2BTQ",
            data=data,
            error=None,
            finished_at=finished_at,
        )

    mp_updated = await db_session.get(MasterProduct, mp_id)
    assert mp_updated is not None
    assert mp_updated.reference_image_url == "https://images-eu.ssl-images-amazon.com/images/P/B000FC2BTQ.01.LZZZZZZZ.jpg"


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
            settings=None,
            master_product_id=mp_id,
            asin="B000FC2BTQ",
            data=data,
            error=None,
            finished_at=finished_at,
        )

    prices = (await db_session.execute(select(AmazonScrapeBestPrice).where(AmazonScrapeBestPrice.run_id == run_id))).scalars().all()
    by_bucket = {p.condition_bucket: p.price_total_cents for p in prices}
    assert by_bucket[BUCKET_USED_VERY_GOOD] == 800


@pytest.mark.asyncio
async def test_persist_scrape_result_keeps_rank_and_offers_on_empty_success_payload(db_session: AsyncSession) -> None:
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

    first_finished_at = datetime(2026, 2, 10, 20, 0, 10, tzinfo=UTC)
    first_data = {
        "ts_utc": "2026-02-10T20:00:00Z",
        "marketplace": "amazon.de",
        "asin": "B000FC2BTQ",
        "blocked": False,
        "offers_truncated": False,
        "sales_rank_overall": {"rank": 12, "category": "Foo"},
        "sales_rank_specific": {"rank": 3, "category": "Bar"},
        "offers": [
            {"condition_group": "new", "condition_raw": "Neu", "price_total": "12.00", "currency": "EUR", "page": 1, "position": 1},
            {"condition_group": "used", "condition_raw": "Gebraucht - Wie neu", "price_total": "10.00", "currency": "EUR", "page": 1, "position": 2},
        ],
    }
    second_finished_at = datetime(2026, 2, 10, 21, 0, 10, tzinfo=UTC)
    second_data = {
        "ts_utc": "2026-02-10T21:00:00Z",
        "marketplace": "amazon.de",
        "asin": "B000FC2BTQ",
        "blocked": False,
        "offers_truncated": False,
        "title": "Amazon.de",
        "sales_ranks": [],
        "offers": [],
    }

    async with db_session.begin():
        await persist_scrape_result(
            session=db_session,
            settings=None,
            master_product_id=mp_id,
            asin="B000FC2BTQ",
            data=first_data,
            error=None,
            finished_at=first_finished_at,
        )
    async with db_session.begin():
        await persist_scrape_result(
            session=db_session,
            settings=None,
            master_product_id=mp_id,
            asin="B000FC2BTQ",
            data=second_data,
            error=None,
            finished_at=second_finished_at,
        )

    latest = await db_session.get(AmazonProductMetricsLatest, mp_id)
    assert latest is not None
    assert latest.rank_overall == 12
    assert latest.rank_specific == 3
    assert latest.offers_count_total == 2
    assert latest.offers_count_priced_total == 2
    assert latest.offers_count_used_priced_total == 1


@pytest.mark.asyncio
async def test_store_reference_image_locally_retries_then_succeeds(monkeypatch, tmp_path) -> None:
    settings = get_settings().model_copy(update={"app_storage_dir": tmp_path})
    master_product_id = uuid.uuid4()

    class _Response:
        headers = {"content-type": "image/jpeg"}
        content = b"test-image-bytes"

        def raise_for_status(self) -> None:
            return

    calls: list[int] = []

    class _Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

        async def get(self, _url: str):
            calls.append(1)
            if len(calls) == 1:
                raise httpx.ReadTimeout("timeout")
            return _Response()

    async def _fast_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr("app.services.amazon_scrape_metrics.httpx.AsyncClient", _Client)
    monkeypatch.setattr("app.services.amazon_scrape_metrics.asyncio.sleep", _fast_sleep)

    rel_path = await _store_reference_image_locally(
        settings=settings,
        master_product_id=master_product_id,
        image_url="https://images-eu.ssl-images-amazon.com/images/P/B000FC2BTQ.01.LZZZZZZZ.jpg",
    )

    assert len(calls) == 2
    assert rel_path is not None
    file_path = settings.app_storage_dir / rel_path
    assert file_path.exists()
    assert file_path.read_bytes() == b"test-image-bytes"


@pytest.mark.asyncio
async def test_store_reference_image_locally_logs_failure_after_retries(monkeypatch, caplog, tmp_path) -> None:
    settings = get_settings().model_copy(update={"app_storage_dir": tmp_path})
    master_product_id = uuid.uuid4()

    calls: list[int] = []

    class _Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

        async def get(self, _url: str):
            calls.append(1)
            raise httpx.ReadTimeout("timeout")

    async def _fast_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr("app.services.amazon_scrape_metrics.httpx.AsyncClient", _Client)
    monkeypatch.setattr("app.services.amazon_scrape_metrics.asyncio.sleep", _fast_sleep)

    with caplog.at_level(logging.WARNING):
        rel_path = await _store_reference_image_locally(
            settings=settings,
            master_product_id=master_product_id,
            image_url="https://images-eu.ssl-images-amazon.com/images/P/B000FC2BTQ.01.LZZZZZZZ.jpg",
        )

    assert rel_path is None
    assert len(calls) == 3
    assert "Reference image download failed; retrying" in caplog.text
    assert "Reference image download failed" in caplog.text


@pytest.mark.asyncio
async def test_persist_scrape_result_keeps_rank_and_offers_on_error_failure(db_session: AsyncSession) -> None:
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

    success_finished_at = datetime(2026, 2, 10, 20, 0, 10, tzinfo=UTC)
    success_data = {
        "ts_utc": "2026-02-10T20:00:00Z",
        "marketplace": "amazon.de",
        "asin": "B000FC2BTQ",
        "blocked": False,
        "offers_truncated": False,
        "sales_rank_overall": {"rank": 12, "category": "Foo"},
        "sales_rank_specific": {"rank": 3, "category": "Bar"},
        "offers": [
            {"condition_group": "new", "condition_raw": "Neu", "price_total": "12.00", "currency": "EUR", "page": 1, "position": 1},
            {"condition_group": "used", "condition_raw": "Gebraucht - Wie neu", "price_total": "10.00", "currency": "EUR", "page": 1, "position": 2},
        ],
    }
    fail_finished_at = datetime(2026, 2, 10, 21, 0, 10, tzinfo=UTC)

    async with db_session.begin():
        await persist_scrape_result(
            session=db_session,
            settings=None,
            master_product_id=mp_id,
            asin="B000FC2BTQ",
            data=success_data,
            error=None,
            finished_at=success_finished_at,
        )
    async with db_session.begin():
        await persist_scrape_result(
            session=db_session,
            settings=None,
            master_product_id=mp_id,
            asin="B000FC2BTQ",
            data=None,
            error="ReadTimeout: scraper request timed out",
            finished_at=fail_finished_at,
        )

    latest = await db_session.get(AmazonProductMetricsLatest, mp_id)
    assert latest is not None
    stored_success = latest.last_success_at if latest.last_success_at.tzinfo is not None else latest.last_success_at.replace(tzinfo=UTC)
    assert stored_success == success_finished_at
    assert latest.rank_overall == 12
    assert latest.rank_specific == 3
    assert latest.offers_count_total == 2
    assert latest.offers_count_priced_total == 2
    assert latest.offers_count_used_priced_total == 1
