from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import uuid4

from app.api.v1.endpoints.inventory import (
    bulk_target_pricing_apply,
    bulk_target_pricing_preview,
    update_inventory_item,
)
from app.core.enums import InventoryCondition, InventoryStatus, PurchaseType, TargetPriceMode
from app.models.inventory_item import InventoryItem
from app.models.master_product import MasterProduct
from app.schemas.inventory import (
    BulkTargetPricingFilters,
    BulkTargetPricingRequest,
    InventoryItemUpdate,
)

@pytest.mark.asyncio
async def test_bulk_target_pricing_preview(db_session: AsyncSession) -> None:
    # Setup: Create 3 items
    # 1. Auto mode, no manual price
    # 2. Manual mode, manual price 10.00
    # 3. Auto mode, but SOLD (should be ignored by default filters if we implemented status filter correctly)
    
    mp = MasterProduct(
        id=uuid4(),
        kind="GAME",
        title="Zelda",
        platform="Switch",
        region="EU",
        variant="Standard",
        ean="1234567890123",
        asin="ASIN123"
    )
    db_session.add(mp)
    await db_session.flush()

    item1 = InventoryItem(
        id=uuid4(),
        master_product_id=mp.id,
        condition=InventoryCondition.GOOD,
        purchase_type=PurchaseType.DIFF,
        purchase_price_cents=1000,
        allocated_costs_cents=0,
        status=InventoryStatus.AVAILABLE,
        target_price_mode=TargetPriceMode.AUTO,
        manual_target_sell_price_cents=None,
        item_code="ITEM-001"
    )
    item2 = InventoryItem(
        id=uuid4(),
        master_product_id=mp.id,
        condition=InventoryCondition.GOOD,
        purchase_type=PurchaseType.DIFF,
        purchase_price_cents=1000,
        allocated_costs_cents=0,
        status=InventoryStatus.AVAILABLE,
        target_price_mode=TargetPriceMode.MANUAL,
        manual_target_sell_price_cents=2000,
        item_code="ITEM-002"
    )
    item3 = InventoryItem(
        id=uuid4(),
        master_product_id=mp.id,
        condition=InventoryCondition.GOOD,
        purchase_type=PurchaseType.DIFF,
        purchase_price_cents=1000,
        allocated_costs_cents=0,
        status=InventoryStatus.SOLD,
        target_price_mode=TargetPriceMode.AUTO,
        manual_target_sell_price_cents=None,
        item_code="ITEM-003"
    )
    db_session.add_all([item1, item2, item3])
    await db_session.commit()

    # Test 1: Preview setting all AVAILABLE items to MANUAL 50.00 filter by Status
    req = BulkTargetPricingRequest(
        filters=BulkTargetPricingFilters(
            match_status=[InventoryStatus.AVAILABLE]
        ),
        set_target_price_mode=TargetPriceMode.MANUAL,
        set_manual_target_sell_price_cents=5000,
    )

    res = await bulk_target_pricing_preview(req, session=db_session)
    
    assert res.total_items_matched == 2 # item1 and item2
    assert res.total_items_changed == 2
    assert len(res.preview_rows) == 2
    
    # Check item1: Auto -> Manual 50.00
    row1 = next(r for r in res.preview_rows if r.item_code == "ITEM-001")
    assert row1.current_mode == TargetPriceMode.AUTO
    assert row1.new_mode == TargetPriceMode.MANUAL
    assert row1.new_manual_cents == 5000
    assert row1.new_effective_cents == 5000

    # Check item2: Manual 20.00 -> Manual 50.00
    row2 = next(r for r in res.preview_rows if r.item_code == "ITEM-002")
    assert row2.current_mode == TargetPriceMode.MANUAL
    assert row2.current_effective_cents == 2000
    assert row2.new_manual_cents == 5000
    assert row2.new_effective_cents == 5000


@pytest.mark.asyncio
async def test_bulk_target_pricing_apply(db_session: AsyncSession) -> None:
    # Setup
    mp = MasterProduct(id=uuid4(), kind="GAME", title="Mario", platform="Switch", region="EU", variant="")
    db_session.add(mp)
    await db_session.flush()

    item1 = InventoryItem(
        id=uuid4(),
        master_product_id=mp.id,
        condition=InventoryCondition.GOOD,
        purchase_type=PurchaseType.DIFF,
        purchase_price_cents=1000,
        allocated_costs_cents=0,
        status=InventoryStatus.AVAILABLE,
        target_price_mode=TargetPriceMode.AUTO,
        manual_target_sell_price_cents=None,
        item_code="ITEM-TEST-APPLY"
    )
    db_session.add(item1)
    await db_session.commit()

    # Apply: Set to Manual 30.00
    req = BulkTargetPricingRequest(
        filters=BulkTargetPricingFilters(match_search_query="ITEM-TEST-APPLY"),
        set_target_price_mode=TargetPriceMode.MANUAL,
        set_manual_target_sell_price_cents=3000,
    )

    res = await bulk_target_pricing_apply(req, session=db_session, actor="test-user")
    
    assert res.updated_count == 1
    
    # Verify DB
    await db_session.refresh(item1)
    assert item1.target_price_mode == TargetPriceMode.MANUAL
    assert item1.manual_target_sell_price_cents == 3000
    # assert item1.effective_target_sell_price_cents == 3000 # Computed column usually, but here relies on Python model or DB refresh? 
    # Wait, effective_target_sell_price_cents is NOT a DB column in InventoryItem model (it's enriched in API Out).
    # The DB column is `manual_target_sell_price_cents`.
    
    # Re-apply same change -> should skip
    res2 = await bulk_target_pricing_apply(req, session=db_session, actor="test-user")
    assert res2.updated_count == 0


@pytest.mark.asyncio
async def test_single_item_update_clears_manual_price(db_session: AsyncSession) -> None:
    # Test that PATCH switching to AUTO clears the manual price
    mp = MasterProduct(id=uuid4(), kind="GAME", title="Sonic", platform="PS5", region="EU", variant="")
    db_session.add(mp)
    await db_session.flush()

    item = InventoryItem(
        id=uuid4(),
        master_product_id=mp.id,
        condition=InventoryCondition.NEW,
        purchase_type=PurchaseType.DIFF,
        purchase_price_cents=5000,
        allocated_costs_cents=0,
        status=InventoryStatus.AVAILABLE,
        target_price_mode=TargetPriceMode.MANUAL,
        manual_target_sell_price_cents=9999,
        item_code="SONIC-001"
    )
    db_session.add(item)
    await db_session.commit()

    # Update to AUTO
    update_data = InventoryItemUpdate(target_price_mode=TargetPriceMode.AUTO)
    
    await update_inventory_item(item.id, update_data, session=db_session, actor="test-user")
    
    await db_session.refresh(item)
    assert item.target_price_mode == TargetPriceMode.AUTO
    assert item.manual_target_sell_price_cents is None
