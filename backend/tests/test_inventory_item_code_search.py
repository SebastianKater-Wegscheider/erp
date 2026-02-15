from __future__ import annotations

import os

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_endpoint_import_test.db")
os.environ.setdefault("BASIC_AUTH_USERNAME", "test-user")
os.environ.setdefault("BASIC_AUTH_PASSWORD", "test-pass")

from app.api.v1.endpoints.inventory import list_inventory
from app.core.enums import InventoryCondition, InventoryStatus, PurchaseType
from app.models.inventory_item import InventoryItem
from app.models.master_product import MasterProduct


@pytest.mark.asyncio
async def test_inventory_search_finds_by_item_code(db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = MasterProduct(kind="GAME", title="Item Code Search", platform="PS5", region="EU", variant="")
        db_session.add(mp)
        await db_session.flush()

        item = InventoryItem(
            master_product_id=mp.id,
            condition=InventoryCondition.GOOD,
            purchase_type=PurchaseType.DIFF,
            purchase_price_cents=1_000,
            allocated_costs_cents=0,
            storage_location=None,
            serial_number=None,
            status=InventoryStatus.AVAILABLE,
            acquired_date=None,
        )
        db_session.add(item)
        await db_session.flush()

        assert item.item_code

    rows = await list_inventory(q=item.item_code, status=None, queue=None, limit=50, offset=0, session=db_session)
    assert [r.id for r in rows] == [item.id]

