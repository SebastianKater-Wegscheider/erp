from __future__ import annotations

import os
from datetime import date

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_endpoint_import_test.db")
os.environ.setdefault("BASIC_AUTH_USERNAME", "test-user")
os.environ.setdefault("BASIC_AUTH_PASSWORD", "test-pass")

from app.api.v1.endpoints.marketplace import import_marketplace_payouts
from app.core.enums import CashRecognition, InventoryCondition, InventoryStatus, OrderChannel, PaymentSource, PurchaseType
from app.models.inventory_item import InventoryItem
from app.models.ledger_entry import LedgerEntry
from app.models.master_product import MasterProduct
from app.schemas.marketplace_payout import MarketplacePayoutImportIn
from app.schemas.sales import SalesOrderCreate, SalesOrderLineCreate
from app.services.sales import create_sales_order, finalize_sales_order


@pytest.mark.asyncio
async def test_payout_import_creates_ledger_entry_and_is_idempotent(db_session: AsyncSession) -> None:
    csv_text = "\n".join(
        [
            "channel,external_payout_id,payout_date,net_amount_eur",
            "AMAZON,PO-1,2026-02-01,123.45",
        ]
    )

    out = await import_marketplace_payouts(
        data=MarketplacePayoutImportIn(csv_text=csv_text),
        session=db_session,
        actor="test-user",
    )
    assert out.imported_count == 1
    assert out.failed_count == 0

    ledger = (
        (await db_session.execute(select(LedgerEntry).where(LedgerEntry.entity_type == "marketplace_payout")))
        .scalars()
        .all()
    )
    assert len(ledger) == 1
    assert ledger[0].account == PaymentSource.BANK
    assert ledger[0].amount_cents == 12_345
    assert ledger[0].entry_date == date(2026, 2, 1)

    # Re-import same payout: skipped, no new ledger entries.
    out2 = await import_marketplace_payouts(
        data=MarketplacePayoutImportIn(csv_text=csv_text),
        session=db_session,
        actor="test-user",
    )
    assert out2.imported_count == 0
    assert out2.skipped_count == 1

    ledger2 = (
        (await db_session.execute(select(LedgerEntry).where(LedgerEntry.entity_type == "marketplace_payout")))
        .scalars()
        .all()
    )
    assert len(ledger2) == 1


@pytest.mark.asyncio
async def test_finalize_sale_skips_ledger_entry_when_cash_recognition_at_payout(db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = MasterProduct(kind="GAME", title="Payout Sale", platform="PS5", region="EU", variant="")
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

        order = await create_sales_order(
            db_session,
            actor="test-user",
            data=SalesOrderCreate(
                order_date=date(2026, 2, 2),
                channel=OrderChannel.AMAZON,
                buyer_name="Amazon Buyer",
                buyer_address=None,
                shipping_gross_cents=0,
                payment_source=PaymentSource.BANK,
                lines=[SalesOrderLineCreate(inventory_item_id=item.id, sale_gross_cents=2_000)],
            ),
        )
        order.cash_recognition = CashRecognition.AT_PAYOUT

    async with db_session.begin():
        await finalize_sales_order(db_session, actor="test-user", order_id=order.id)

    sale_ledgers = (
        (await db_session.execute(select(LedgerEntry).where(LedgerEntry.entity_type == "sale", LedgerEntry.entity_id == order.id)))
        .scalars()
        .all()
    )
    assert sale_ledgers == []

