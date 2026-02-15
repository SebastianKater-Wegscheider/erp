from __future__ import annotations

import os
from datetime import date

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_endpoint_import_test.db")
os.environ.setdefault("BASIC_AUTH_USERNAME", "test-user")
os.environ.setdefault("BASIC_AUTH_PASSWORD", "test-pass")

from app.api.v1.endpoints.marketplace import apply_staged_orders, import_marketplace_orders  # noqa: E402
from app.core.enums import (  # noqa: E402
    CashRecognition,
    InventoryCondition,
    InventoryStatus,
    MarketplaceStagedOrderStatus,
    OrderChannel,
    OrderStatus,
    PaymentSource,
    PurchaseType,
)
from app.models.inventory_item import InventoryItem  # noqa: E402
from app.models.ledger_entry import LedgerEntry  # noqa: E402
from app.models.marketplace_staged_order import MarketplaceStagedOrder  # noqa: E402
from app.models.master_product import MasterProduct  # noqa: E402
from app.models.sales import SalesOrder, SalesOrderLine  # noqa: E402
from app.schemas.marketplace_orders import (  # noqa: E402
    MarketplaceOrdersImportIn,
    MarketplaceStagedOrderApplyIn,
)


@pytest.mark.asyncio
async def test_marketplace_orders_import_item_code_auto_matches_and_apply_creates_finalized_sale(
    db_session: AsyncSession,
) -> None:
    async with db_session.begin():
        mp = MasterProduct(kind="GAME", title="Import IT", platform="PS5", region="EU", variant="")
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
            status=InventoryStatus.FBA_WAREHOUSE,
            acquired_date=None,
        )
        db_session.add(item)
        await db_session.flush()
        item_code = item.item_code

    csv_text = "\n".join(
        [
            "channel,external_order_id,order_date,sku,sale_gross_eur,shipping_gross_eur",
            f"AMAZON,AO-1,2026-02-01,{item_code},29.99,0",
        ]
    )

    out = await import_marketplace_orders(
        data=MarketplaceOrdersImportIn(csv_text=csv_text),
        session=db_session,
        actor="test-user",
    )
    assert out.total_rows == 1
    assert out.staged_orders_count == 1
    assert out.staged_lines_count == 1
    assert out.ready_orders_count == 1
    assert out.needs_attention_orders_count == 0

    staged = (
        (
            await db_session.execute(
                select(MarketplaceStagedOrder)
                .where(MarketplaceStagedOrder.external_order_id == "AO-1")
                .options(selectinload(MarketplaceStagedOrder.lines))
            )
        )
        .scalars()
        .one()
    )
    assert staged.status == MarketplaceStagedOrderStatus.READY
    assert staged.channel == OrderChannel.AMAZON
    assert staged.shipping_gross_cents == 0
    assert len(staged.lines) == 1
    assert staged.lines[0].matched_inventory_item_id == item.id

    apply_out = await apply_staged_orders(
        data=MarketplaceStagedOrderApplyIn(staged_order_ids=[staged.id]),
        session=db_session,
        actor="test-user",
    )
    assert len(apply_out.results) == 1
    assert apply_out.results[0].ok is True
    sale_id = apply_out.results[0].sales_order_id
    assert sale_id is not None

    sale = (await db_session.execute(select(SalesOrder).where(SalesOrder.id == sale_id))).scalars().one()
    assert sale.status == OrderStatus.FINALIZED
    assert sale.channel == OrderChannel.AMAZON
    assert sale.external_order_id == "AO-1"
    assert sale.cash_recognition == CashRecognition.AT_PAYOUT
    assert sale.payment_source == PaymentSource.BANK
    assert sale.order_date == date(2026, 2, 1)

    sale_lines = (
        (await db_session.execute(select(SalesOrderLine).where(SalesOrderLine.order_id == sale.id)))
        .scalars()
        .all()
    )
    assert len(sale_lines) == 1
    assert sale_lines[0].inventory_item_id == item.id

    ledger = (
        (
            await db_session.execute(
                select(LedgerEntry).where(LedgerEntry.entity_type == "sale", LedgerEntry.entity_id == sale.id)
            )
        )
        .scalars()
        .all()
    )
    assert ledger == []

    item_db = await db_session.get(InventoryItem, item.id)
    assert item_db is not None
    assert item_db.status == InventoryStatus.SOLD

    # Idempotent-safe: cannot apply the same staged order twice.
    apply_out2 = await apply_staged_orders(
        data=MarketplaceStagedOrderApplyIn(staged_order_ids=[staged.id]),
        session=db_session,
        actor="test-user",
    )
    assert apply_out2.results[0].ok is False


@pytest.mark.asyncio
async def test_marketplace_orders_master_sku_fifo_prefers_fba_and_is_deterministic_over_multiple_orders(
    db_session: AsyncSession,
) -> None:
    async with db_session.begin():
        mp = MasterProduct(kind="GAME", title="Import MP", platform="PS5", region="EU", variant="")
        db_session.add(mp)
        await db_session.flush()

        available_old = InventoryItem(
            master_product_id=mp.id,
            condition=InventoryCondition.GOOD,
            purchase_type=PurchaseType.DIFF,
            purchase_price_cents=1_000,
            allocated_costs_cents=0,
            storage_location=None,
            serial_number=None,
            status=InventoryStatus.AVAILABLE,
            acquired_date=date(2025, 12, 1),
        )
        fba_1 = InventoryItem(
            master_product_id=mp.id,
            condition=InventoryCondition.GOOD,
            purchase_type=PurchaseType.DIFF,
            purchase_price_cents=1_000,
            allocated_costs_cents=0,
            storage_location=None,
            serial_number=None,
            status=InventoryStatus.FBA_WAREHOUSE,
            acquired_date=date(2026, 1, 1),
        )
        fba_2 = InventoryItem(
            master_product_id=mp.id,
            condition=InventoryCondition.GOOD,
            purchase_type=PurchaseType.DIFF,
            purchase_price_cents=1_000,
            allocated_costs_cents=0,
            storage_location=None,
            serial_number=None,
            status=InventoryStatus.FBA_WAREHOUSE,
            acquired_date=date(2026, 1, 2),
        )
        db_session.add_all([available_old, fba_1, fba_2])
        await db_session.flush()

        mp_sku = mp.sku

    csv_1 = "\n".join(
        [
            "channel,external_order_id,order_date,sku,sale_gross_eur,shipping_gross_eur,quantity",
            f"EBAY,EO-1,2026-02-02,{mp_sku},10.00,0,1",
        ]
    )
    out_1 = await import_marketplace_orders(
        data=MarketplaceOrdersImportIn(csv_text=csv_1),
        session=db_session,
        actor="test-user",
    )
    assert out_1.ready_orders_count == 1

    staged_1 = (
        (
            await db_session.execute(
                select(MarketplaceStagedOrder)
                .where(MarketplaceStagedOrder.external_order_id == "EO-1")
                .options(selectinload(MarketplaceStagedOrder.lines))
            )
        )
        .scalars()
        .one()
    )
    assert staged_1.status == MarketplaceStagedOrderStatus.READY
    assert len(staged_1.lines) == 1
    assert staged_1.lines[0].matched_inventory_item_id == fba_1.id  # FBA preferred over AVAILABLE, FIFO within FBA

    apply_1 = await apply_staged_orders(
        data=MarketplaceStagedOrderApplyIn(staged_order_ids=[staged_1.id]),
        session=db_session,
        actor="test-user",
    )
    assert apply_1.results[0].ok is True

    csv_2 = "\n".join(
        [
            "channel,external_order_id,order_date,sku,sale_gross_eur,shipping_gross_eur,quantity",
            f"EBAY,EO-2,2026-02-03,{mp_sku},10.00,0,1",
        ]
    )
    out_2 = await import_marketplace_orders(
        data=MarketplaceOrdersImportIn(csv_text=csv_2),
        session=db_session,
        actor="test-user",
    )
    assert out_2.ready_orders_count == 1

    staged_2 = (
        (
            await db_session.execute(
                select(MarketplaceStagedOrder)
                .where(MarketplaceStagedOrder.external_order_id == "EO-2")
                .options(selectinload(MarketplaceStagedOrder.lines))
            )
        )
        .scalars()
        .one()
    )
    assert staged_2.status == MarketplaceStagedOrderStatus.READY
    assert len(staged_2.lines) == 1
    assert staged_2.lines[0].matched_inventory_item_id == fba_2.id
