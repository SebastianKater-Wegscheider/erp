from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.endpoints.master_products import list_master_products
from app.core.enums import InventoryCondition, InventoryStatus, PurchaseType
from app.models.inventory_item import InventoryItem
from app.models.master_product import MasterProduct


@pytest.mark.asyncio
async def test_list_master_products_in_stock_only_filters_on_inventory_statuses(db_session: AsyncSession) -> None:
    async with db_session.begin():
        in_stock_product = MasterProduct(
            kind="GAME",
            title="In Stock Product",
            platform="PS2",
            region="EU",
            variant="Standard",
        )
        sold_out_product = MasterProduct(
            kind="GAME",
            title="Sold Out Product",
            platform="PS2",
            region="EU",
            variant="Standard",
        )
        db_session.add_all([in_stock_product, sold_out_product])
        await db_session.flush()

        db_session.add(
            InventoryItem(
                master_product_id=in_stock_product.id,
                purchase_line_id=None,
                condition=InventoryCondition.GOOD,
                purchase_type=PurchaseType.DIFF,
                purchase_price_cents=1_000,
                allocated_costs_cents=0,
                storage_location="A-01",
                serial_number=None,
                status=InventoryStatus.AVAILABLE,
                acquired_date=date(2026, 2, 11),
            )
        )
        db_session.add(
            InventoryItem(
                master_product_id=sold_out_product.id,
                purchase_line_id=None,
                condition=InventoryCondition.GOOD,
                purchase_type=PurchaseType.DIFF,
                purchase_price_cents=1_000,
                allocated_costs_cents=0,
                storage_location="A-02",
                serial_number=None,
                status=InventoryStatus.SOLD,
                acquired_date=date(2026, 2, 11),
            )
        )

    all_rows = await list_master_products(session=db_session)
    in_stock_rows = await list_master_products(in_stock_only=True, session=db_session)

    assert {str(row.id) for row in all_rows} == {str(in_stock_product.id), str(sold_out_product.id)}
    assert {str(row.id) for row in in_stock_rows} == {str(in_stock_product.id)}
