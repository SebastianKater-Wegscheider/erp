from __future__ import annotations

import os
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_endpoint_import_test.db")
os.environ.setdefault("BASIC_AUTH_USERNAME", "test-user")
os.environ.setdefault("BASIC_AUTH_PASSWORD", "test-pass")

from app.api.v1.endpoints.inventory import list_inventory
from app.core.enums import InventoryCondition, InventoryQueue, InventoryStatus, PurchaseType
from app.models.amazon_scrape import AmazonProductMetricsLatest
from app.models.inventory_item import InventoryItem
from app.models.inventory_item_image import InventoryItemImage
from app.models.master_product import MasterProduct
from app.services.reports import company_dashboard


async def _create_master_product(
    session: AsyncSession,
    *,
    suffix: str,
    asin: str | None,
) -> MasterProduct:
    mp = MasterProduct(
        kind="GAME",
        title=f"Queue Product {suffix}",
        platform="PS5",
        region="EU",
        variant=suffix,
        asin=asin,
    )
    session.add(mp)
    await session.flush()
    return mp


async def _create_inventory_item(
    session: AsyncSession,
    *,
    master_product: MasterProduct,
    status: InventoryStatus,
    storage_location: str | None,
    acquired_date: date,
) -> InventoryItem:
    item = InventoryItem(
        master_product_id=master_product.id,
        condition=InventoryCondition.GOOD,
        purchase_type=PurchaseType.DIFF,
        purchase_price_cents=1_000,
        allocated_costs_cents=0,
        storage_location=storage_location,
        serial_number=None,
        status=status,
        acquired_date=acquired_date,
    )
    session.add(item)
    await session.flush()
    return item


def _metrics_row(
    *,
    master_product_id,
    now_utc: datetime,
    last_success_delta_hours: int | None,
    blocked_last: bool,
) -> AmazonProductMetricsLatest:
    last_success_at = None if last_success_delta_hours is None else now_utc - timedelta(hours=last_success_delta_hours)
    return AmazonProductMetricsLatest(
        master_product_id=master_product_id,
        last_attempt_at=now_utc,
        last_success_at=last_success_at,
        last_run_id=None,
        blocked_last=blocked_last,
        block_reason_last=None,
        last_error=None,
        rank_overall=None,
        rank_overall_category=None,
        rank_specific=None,
        rank_specific_category=None,
        price_new_cents=None,
        price_used_like_new_cents=None,
        price_used_very_good_cents=None,
        price_used_good_cents=None,
        price_used_acceptable_cents=None,
        price_collectible_cents=None,
        buybox_total_cents=None,
        offers_count_total=None,
        offers_count_priced_total=None,
        offers_count_used_priced_total=None,
        next_retry_at=None,
        consecutive_failures=0,
    )


@pytest.mark.asyncio
async def test_inventory_queue_filters_and_ordering(db_session: AsyncSession) -> None:
    now_utc = datetime.now(timezone.utc)
    today = now_utc.date()
    recent_date = today - timedelta(days=10)
    old_date = today - timedelta(days=120)

    async with db_session.begin():
        mp_photos_missing = await _create_master_product(db_session, suffix="photos-missing", asin=None)
        mp_with_photo = await _create_master_product(db_session, suffix="with-photo", asin=None)
        mp_storage_missing = await _create_master_product(db_session, suffix="storage-missing", asin=None)
        mp_storage_ok = await _create_master_product(db_session, suffix="storage-ok", asin=None)
        mp_stale = await _create_master_product(db_session, suffix="stale", asin="B00STALE01")
        mp_blocked = await _create_master_product(db_session, suffix="blocked", asin="B00BLOCK01")
        mp_never = await _create_master_product(db_session, suffix="never", asin="B00NEVER01")
        mp_fresh = await _create_master_product(db_session, suffix="fresh", asin="B00FRESH01")
        mp_no_asin = await _create_master_product(db_session, suffix="no-asin", asin=None)
        mp_old = await _create_master_product(db_session, suffix="old", asin=None)

        item_photos_missing = await _create_inventory_item(
            db_session,
            master_product=mp_photos_missing,
            status=InventoryStatus.AVAILABLE,
            storage_location="A-1",
            acquired_date=recent_date,
        )
        item_with_photo = await _create_inventory_item(
            db_session,
            master_product=mp_with_photo,
            status=InventoryStatus.AVAILABLE,
            storage_location="A-2",
            acquired_date=recent_date,
        )
        item_storage_missing = await _create_inventory_item(
            db_session,
            master_product=mp_storage_missing,
            status=InventoryStatus.DRAFT,
            storage_location=None,
            acquired_date=recent_date,
        )
        item_storage_ok = await _create_inventory_item(
            db_session,
            master_product=mp_storage_ok,
            status=InventoryStatus.DRAFT,
            storage_location="B-2",
            acquired_date=recent_date,
        )
        item_stale = await _create_inventory_item(
            db_session,
            master_product=mp_stale,
            status=InventoryStatus.AVAILABLE,
            storage_location="C-1",
            acquired_date=recent_date,
        )
        item_blocked = await _create_inventory_item(
            db_session,
            master_product=mp_blocked,
            status=InventoryStatus.AVAILABLE,
            storage_location="C-2",
            acquired_date=recent_date,
        )
        item_never = await _create_inventory_item(
            db_session,
            master_product=mp_never,
            status=InventoryStatus.AVAILABLE,
            storage_location="C-3",
            acquired_date=recent_date,
        )
        item_fresh = await _create_inventory_item(
            db_session,
            master_product=mp_fresh,
            status=InventoryStatus.AVAILABLE,
            storage_location="C-4",
            acquired_date=recent_date,
        )
        item_no_asin = await _create_inventory_item(
            db_session,
            master_product=mp_no_asin,
            status=InventoryStatus.AVAILABLE,
            storage_location="C-5",
            acquired_date=recent_date,
        )
        item_old = await _create_inventory_item(
            db_session,
            master_product=mp_old,
            status=InventoryStatus.AVAILABLE,
            storage_location="D-1",
            acquired_date=old_date,
        )

        db_session.add_all(
            [
                InventoryItemImage(inventory_item_id=item_with_photo.id, upload_path="uploads/with-photo.jpg"),
                InventoryItemImage(inventory_item_id=item_storage_missing.id, upload_path="uploads/storage-missing.jpg"),
                InventoryItemImage(inventory_item_id=item_storage_ok.id, upload_path="uploads/storage-ok.jpg"),
                InventoryItemImage(inventory_item_id=item_stale.id, upload_path="uploads/stale.jpg"),
                InventoryItemImage(inventory_item_id=item_blocked.id, upload_path="uploads/blocked.jpg"),
                InventoryItemImage(inventory_item_id=item_never.id, upload_path="uploads/never.jpg"),
                InventoryItemImage(inventory_item_id=item_fresh.id, upload_path="uploads/fresh.jpg"),
                InventoryItemImage(inventory_item_id=item_no_asin.id, upload_path="uploads/no-asin.jpg"),
                InventoryItemImage(inventory_item_id=item_old.id, upload_path="uploads/old.jpg"),
            ]
        )
        db_session.add_all(
            [
                _metrics_row(master_product_id=mp_stale.id, now_utc=now_utc, last_success_delta_hours=48, blocked_last=False),
                _metrics_row(master_product_id=mp_blocked.id, now_utc=now_utc, last_success_delta_hours=2, blocked_last=True),
                _metrics_row(master_product_id=mp_fresh.id, now_utc=now_utc, last_success_delta_hours=1, blocked_last=False),
            ]
        )

    photos_missing = await list_inventory(
        q=None,
        status=None,
        queue=InventoryQueue.PHOTOS_MISSING,
        limit=200,
        offset=0,
        session=db_session,
    )
    assert [item.id for item in photos_missing] == [item_photos_missing.id]

    storage_missing = await list_inventory(
        q=None,
        status=None,
        queue=InventoryQueue.STORAGE_MISSING,
        limit=200,
        offset=0,
        session=db_session,
    )
    assert [item.id for item in storage_missing] == [item_storage_missing.id]

    amazon_stale = await list_inventory(
        q=None,
        status=None,
        queue=InventoryQueue.AMAZON_STALE,
        limit=200,
        offset=0,
        session=db_session,
    )
    assert [item.id for item in amazon_stale] == [item_never.id, item_stale.id, item_blocked.id]

    old_stock = await list_inventory(
        q=None,
        status=None,
        queue=InventoryQueue.OLD_STOCK_90D,
        limit=200,
        offset=0,
        session=db_session,
    )
    assert [item.id for item in old_stock] == [item_old.id]


@pytest.mark.asyncio
async def test_company_dashboard_returns_work_queue_counts(db_session: AsyncSession) -> None:
    now_utc = datetime.now(timezone.utc)
    today = now_utc.date()
    recent_date = today - timedelta(days=10)
    old_date = today - timedelta(days=120)

    async with db_session.begin():
        mp_photos_missing = await _create_master_product(db_session, suffix="dash-photos-missing", asin=None)
        mp_storage_missing = await _create_master_product(db_session, suffix="dash-storage-missing", asin=None)
        mp_stale = await _create_master_product(db_session, suffix="dash-stale", asin="B00DASH003")
        mp_blocked = await _create_master_product(db_session, suffix="dash-blocked", asin="B00DASH004")
        mp_never = await _create_master_product(db_session, suffix="dash-never", asin="B00DASH005")
        mp_old = await _create_master_product(db_session, suffix="dash-old", asin=None)

        await _create_inventory_item(
            db_session,
            master_product=mp_photos_missing,
            status=InventoryStatus.AVAILABLE,
            storage_location="E-1",
            acquired_date=recent_date,
        )
        item_storage_missing = await _create_inventory_item(
            db_session,
            master_product=mp_storage_missing,
            status=InventoryStatus.DRAFT,
            storage_location=None,
            acquired_date=recent_date,
        )
        item_stale = await _create_inventory_item(
            db_session,
            master_product=mp_stale,
            status=InventoryStatus.AVAILABLE,
            storage_location="E-3",
            acquired_date=recent_date,
        )
        item_blocked = await _create_inventory_item(
            db_session,
            master_product=mp_blocked,
            status=InventoryStatus.AVAILABLE,
            storage_location="E-4",
            acquired_date=recent_date,
        )
        item_never = await _create_inventory_item(
            db_session,
            master_product=mp_never,
            status=InventoryStatus.AVAILABLE,
            storage_location="E-5",
            acquired_date=recent_date,
        )
        item_old = await _create_inventory_item(
            db_session,
            master_product=mp_old,
            status=InventoryStatus.AVAILABLE,
            storage_location="E-6",
            acquired_date=old_date,
        )

        db_session.add_all(
            [
                InventoryItemImage(inventory_item_id=item_storage_missing.id, upload_path="uploads/dash-storage.jpg"),
                InventoryItemImage(inventory_item_id=item_stale.id, upload_path="uploads/dash-stale.jpg"),
                InventoryItemImage(inventory_item_id=item_blocked.id, upload_path="uploads/dash-blocked.jpg"),
                InventoryItemImage(inventory_item_id=item_never.id, upload_path="uploads/dash-never.jpg"),
                InventoryItemImage(inventory_item_id=item_old.id, upload_path="uploads/dash-old.jpg"),
            ]
        )
        db_session.add_all(
            [
                _metrics_row(master_product_id=mp_stale.id, now_utc=now_utc, last_success_delta_hours=72, blocked_last=False),
                _metrics_row(master_product_id=mp_blocked.id, now_utc=now_utc, last_success_delta_hours=2, blocked_last=True),
            ]
        )

    out = await company_dashboard(db_session, today=today)

    assert out["inventory_missing_photos_count"] == 1
    assert out["inventory_missing_storage_location_count"] == 1
    assert out["inventory_amazon_stale_count"] == 3
    assert out["inventory_old_stock_90d_count"] == 1
