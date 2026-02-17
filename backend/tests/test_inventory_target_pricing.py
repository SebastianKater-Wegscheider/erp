from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.endpoints.inventory import bulk_target_pricing_apply, bulk_target_pricing_preview
from app.core.config import get_settings
from app.core.enums import InventoryCondition, InventoryStatus, PurchaseType, TargetPriceMode
from app.models.amazon_scrape import AmazonProductMetricsLatest
from app.models.audit_log import AuditLog
from app.models.inventory_item import InventoryItem
from app.models.master_product import MasterProduct
from app.schemas.inventory import (
    InventoryItemUpdate,
    TargetPricingAsinState,
    TargetPricingBulkFilters,
    TargetPricingBulkOperation,
    TargetPricingBulkRequest,
)
from app.services.target_pricing import compute_effective_price, compute_recommendation


@pytest.fixture(autouse=True)
def _prepare_settings_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "sqlite+aiosqlite:///./_target_pricing_test.db")
    monkeypatch.setenv("BASIC_AUTH_USERNAME", "test-user")
    monkeypatch.setenv("BASIC_AUTH_PASSWORD", "test-pass")
    monkeypatch.setenv("COMPANY_SMALL_BUSINESS_NOTICE", "")
    monkeypatch.setenv("COMPANY_VAT_ID", "ATU12345678")
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_recommendation_uses_buybox_anchor_when_condition_anchor_missing() -> None:
    settings = get_settings()
    recommendation = compute_recommendation(
        purchase_price_cents=1_000,
        allocated_costs_cents=0,
        condition="DEFECT",
        price_new_cents=None,
        price_used_like_new_cents=None,
        price_used_very_good_cents=None,
        price_used_good_cents=None,
        price_used_acceptable_cents=None,
        price_buybox_cents=2_990,
        rank=3_000,
        offers_count=2,
        settings=settings,
    )
    assert recommendation.anchor_source == "AMAZON_BUYBOX"
    assert recommendation.anchor_price_cents == 2_990
    assert recommendation.recommended_target_sell_price_cents >= recommendation.margin_floor_price_cents
    assert recommendation.recommended_target_sell_price_cents % 10 == 0


@pytest.mark.asyncio
async def test_recommendation_without_amazon_falls_back_to_cost_floor() -> None:
    settings = get_settings()
    recommendation = compute_recommendation(
        purchase_price_cents=1_500,
        allocated_costs_cents=300,
        condition="GOOD",
        price_new_cents=None,
        price_used_like_new_cents=None,
        price_used_very_good_cents=None,
        price_used_good_cents=None,
        price_used_acceptable_cents=None,
        price_buybox_cents=None,
        rank=None,
        offers_count=None,
        settings=settings,
    )
    assert recommendation.anchor_source == "NONE"
    assert recommendation.anchor_price_cents is None
    assert recommendation.recommended_target_sell_price_cents >= recommendation.margin_floor_price_cents
    assert recommendation.recommended_target_sell_price_cents % 10 == 0


@pytest.mark.asyncio
async def test_manual_override_precedence() -> None:
    settings = get_settings()
    recommendation = compute_recommendation(
        purchase_price_cents=2_000,
        allocated_costs_cents=0,
        condition="GOOD",
        price_new_cents=None,
        price_used_like_new_cents=3_500,
        price_used_very_good_cents=3_400,
        price_used_good_cents=3_300,
        price_used_acceptable_cents=3_200,
        price_buybox_cents=3_000,
        rank=8_000,
        offers_count=6,
        settings=settings,
    )
    manual_effective, manual_source = compute_effective_price(
        mode=TargetPriceMode.MANUAL,
        manual_target_sell_price_cents=0,
        recommendation=recommendation,
    )
    assert manual_effective == 0
    assert manual_source == "MANUAL"

    auto_effective, auto_source = compute_effective_price(
        mode=TargetPriceMode.AUTO,
        manual_target_sell_price_cents=5_000,
        recommendation=recommendation,
    )
    assert auto_effective == recommendation.recommended_target_sell_price_cents
    assert auto_source in {"AUTO_AMAZON", "AUTO_COST_FLOOR"}


def test_inventory_item_update_validation_rules() -> None:
    with pytest.raises(ValueError):
        InventoryItemUpdate(target_price_mode=TargetPriceMode.MANUAL)
    with pytest.raises(ValueError):
        InventoryItemUpdate(manual_target_sell_price_cents=-1)

    valid = InventoryItemUpdate(target_price_mode=TargetPriceMode.MANUAL, manual_target_sell_price_cents=100)
    assert valid.target_price_mode == TargetPriceMode.MANUAL
    assert valid.manual_target_sell_price_cents == 100


@pytest.mark.asyncio
async def test_bulk_preview_and_apply_filters_counts_and_audit(db_session: AsyncSession) -> None:
    mp_with_asin = MasterProduct(
        id=uuid4(),
        kind="GAME",
        title="Bulk Mario",
        platform="Switch",
        region="EU",
        variant="",
        asin="BULK1234",
    )
    mp_without_asin = MasterProduct(
        id=uuid4(),
        kind="GAME",
        title="Bulk Zelda",
        platform="Switch",
        region="EU",
        variant="",
        asin=None,
    )
    db_session.add_all([mp_with_asin, mp_without_asin])
    await db_session.flush()

    item_with_asin = InventoryItem(
        id=uuid4(),
        master_product_id=mp_with_asin.id,
        condition=InventoryCondition.GOOD,
        purchase_type=PurchaseType.DIFF,
        purchase_price_cents=1_000,
        allocated_costs_cents=0,
        status=InventoryStatus.AVAILABLE,
        target_price_mode=TargetPriceMode.AUTO,
        manual_target_sell_price_cents=None,
        item_code="BULK-A",
    )
    item_without_asin = InventoryItem(
        id=uuid4(),
        master_product_id=mp_without_asin.id,
        condition=InventoryCondition.GOOD,
        purchase_type=PurchaseType.DIFF,
        purchase_price_cents=1_100,
        allocated_costs_cents=0,
        status=InventoryStatus.AVAILABLE,
        target_price_mode=TargetPriceMode.MANUAL,
        manual_target_sell_price_cents=2_500,
        item_code="BULK-B",
    )
    item_sold = InventoryItem(
        id=uuid4(),
        master_product_id=mp_with_asin.id,
        condition=InventoryCondition.GOOD,
        purchase_type=PurchaseType.DIFF,
        purchase_price_cents=900,
        allocated_costs_cents=0,
        status=InventoryStatus.SOLD,
        target_price_mode=TargetPriceMode.AUTO,
        manual_target_sell_price_cents=None,
        item_code="BULK-C",
    )
    db_session.add_all([item_with_asin, item_without_asin, item_sold])
    now_utc = datetime.now(timezone.utc)

    db_session.add(
        AmazonProductMetricsLatest(
            master_product_id=mp_with_asin.id,
            last_attempt_at=now_utc,
            last_success_at=now_utc,
            last_run_id=None,
            blocked_last=False,
            block_reason_last=None,
            last_error=None,
            rank_overall=5_000,
            rank_overall_category=None,
            rank_specific=None,
            rank_specific_category=None,
            price_new_cents=None,
            price_used_like_new_cents=4_000,
            price_used_very_good_cents=3_900,
            price_used_good_cents=3_700,
            price_used_acceptable_cents=3_500,
            price_collectible_cents=None,
            buybox_total_cents=3_600,
            offers_count_total=4,
            offers_count_priced_total=None,
            offers_count_used_priced_total=3,
            next_retry_at=None,
            consecutive_failures=0,
        )
    )
    await db_session.commit()

    preview_req = TargetPricingBulkRequest(
        filters=TargetPricingBulkFilters(
            conditions=[InventoryCondition.GOOD],
            asin_state=TargetPricingAsinState.WITH_ASIN,
            bsr_max=10_000,
            offers_max=5,
        ),
        operation=TargetPricingBulkOperation.APPLY_RECOMMENDED_MANUAL,
    )
    preview = await bulk_target_pricing_preview(preview_req, session=db_session)
    assert preview.matched_count == 1
    assert preview.applicable_count == 1
    assert preview.rows[0].item_id == item_with_asin.id
    assert preview.rows[0].after_target_price_mode == TargetPriceMode.MANUAL

    apply_out = await bulk_target_pricing_apply(preview_req, session=db_session, actor="tester")
    assert apply_out.matched_count == 1
    assert apply_out.updated_count == 1
    assert apply_out.skipped_count == 0
    assert apply_out.sample_updated_item_ids == [item_with_asin.id]

    await db_session.refresh(item_with_asin)
    assert item_with_asin.target_price_mode == TargetPriceMode.MANUAL
    assert isinstance(item_with_asin.manual_target_sell_price_cents, int)

    logs = (
        await db_session.execute(
            select(AuditLog).where(
                AuditLog.entity_type == "inventory_item",
                AuditLog.entity_id == item_with_asin.id,
                AuditLog.action == "bulk_target_pricing_apply",
            )
        )
    ).scalars().all()
    assert len(logs) == 1

    apply_again = await bulk_target_pricing_apply(preview_req, session=db_session, actor="tester")
    assert apply_again.matched_count == 1
    assert apply_again.updated_count == 0
    assert apply_again.skipped_count == 1

    clear_req = TargetPricingBulkRequest(
        filters=TargetPricingBulkFilters(
            conditions=[InventoryCondition.GOOD],
            asin_state=TargetPricingAsinState.WITHOUT_ASIN,
        ),
        operation=TargetPricingBulkOperation.CLEAR_MANUAL_USE_AUTO,
    )
    clear_preview = await bulk_target_pricing_preview(clear_req, session=db_session)
    assert clear_preview.matched_count == 1
    assert clear_preview.applicable_count == 1
    assert clear_preview.rows[0].item_id == item_without_asin.id
    assert clear_preview.rows[0].after_target_price_mode == TargetPriceMode.AUTO

    clear_apply = await bulk_target_pricing_apply(clear_req, session=db_session, actor="tester")
    assert clear_apply.matched_count == 1
    assert clear_apply.updated_count == 1
    assert clear_apply.skipped_count == 0

    await db_session.refresh(item_without_asin)
    assert item_without_asin.target_price_mode == TargetPriceMode.AUTO
    assert item_without_asin.manual_target_sell_price_cents is None
