from __future__ import annotations

import io
import zipfile
from datetime import date

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.enums import InventoryCondition, OrderChannel, OpexCategory, PaymentSource, PurchaseKind, PurchaseType
from app.models.inventory_item import InventoryItem
from app.models.ledger_entry import LedgerEntry
from app.models.master_product import MasterProduct
from app.models.purchase import Purchase
from app.schemas.cost_allocation import CostAllocationCreate, CostAllocationLineCreate
from app.schemas.mileage import MileageCreate
from app.schemas.opex import OpexCreate
from app.schemas.purchase import PurchaseCreate, PurchaseLineCreate
from app.schemas.sales import SalesOrderCreate, SalesOrderLineCreate
from app.services.cost_allocations import create_cost_allocation
from app.services.mileage import create_mileage_log
from app.services.opex import create_opex
from app.services.purchases import create_purchase
from app.services.reports import dashboard, monthly_close_zip, vat_report
from app.services.sales import create_sales_order, finalize_sales_order


ACTOR = "tester"


async def _create_master_product(session: AsyncSession, suffix: str) -> MasterProduct:
    mp = MasterProduct(
        kind="GAME",
        title=f"Report Product {suffix}",
        platform="PS5",
        region="EU",
        variant=suffix,
    )
    session.add(mp)
    await session.flush()
    return mp


@pytest.mark.asyncio
async def test_create_cost_allocation_updates_inventory_costs_with_net(db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, "A")
        purchase = await create_purchase(
            db_session,
            actor=ACTOR,
            data=PurchaseCreate(
                kind=PurchaseKind.COMMERCIAL_REGULAR,
                purchase_date=date(2026, 2, 8),
                counterparty_name="Supplier GmbH",
                total_amount_cents=1_200,
                tax_rate_bp=2_000,
                payment_source=PaymentSource.BANK,
                external_invoice_number="SUP-1",
                receipt_upload_path="uploads/sup-1.pdf",
                lines=[
                    PurchaseLineCreate(
                        master_product_id=mp.id,
                        condition=InventoryCondition.GOOD,
                        purchase_type=PurchaseType.REGULAR,
                        purchase_price_cents=1_200,
                    )
                ],
            ),
        )

    purchase_row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    item = (
        await db_session.execute(select(InventoryItem).where(InventoryItem.purchase_line_id == purchase_row.lines[0].id))
    ).scalar_one()
    item_id = item.id
    await db_session.rollback()

    async with db_session.begin():
        allocation = await create_cost_allocation(
            db_session,
            actor=ACTOR,
            data=CostAllocationCreate(
                allocation_date=date(2026, 2, 9),
                description="Inbound Verpackung",
                amount_cents=120,
                tax_rate_bp=2_000,
                input_tax_deductible=True,
                payment_source=PaymentSource.BANK,
                lines=[CostAllocationLineCreate(inventory_item_id=item_id, amount_cents=120)],
            ),
        )

    updated_item = await db_session.get(InventoryItem, item_id)
    assert updated_item is not None
    # deductible -> only net amount (100) increases cost basis
    assert updated_item.allocated_costs_cents == 100

    ledger = (
        await db_session.execute(
            select(LedgerEntry).where(
                LedgerEntry.entity_type == "cost_allocation",
                LedgerEntry.entity_id == allocation.id,
            )
        )
    ).scalar_one()
    assert ledger.amount_cents == -120


@pytest.mark.asyncio
async def test_create_opex_and_mileage_create_expected_ledger_and_links(db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, "B")
        purchase = await create_purchase(
            db_session,
            actor=ACTOR,
            data=PurchaseCreate(
                kind=PurchaseKind.PRIVATE_DIFF,
                purchase_date=date(2026, 2, 8),
                counterparty_name="Privat",
                total_amount_cents=500,
                payment_source=PaymentSource.CASH,
                lines=[
                    PurchaseLineCreate(
                        master_product_id=mp.id,
                        condition=InventoryCondition.GOOD,
                        purchase_type=PurchaseType.DIFF,
                        purchase_price_cents=500,
                    )
                ],
            ),
        )

    async with db_session.begin():
        expense = await create_opex(
            db_session,
            actor=ACTOR,
            data=OpexCreate(
                expense_date=date(2026, 2, 9),
                recipient="Post AG",
                category=OpexCategory.POSTAGE,
                amount_cents=240,
                tax_rate_bp=2_000,
                input_tax_deductible=True,
                payment_source=PaymentSource.BANK,
            ),
        )

        log = await create_mileage_log(
            db_session,
            actor=ACTOR,
            data=MileageCreate(
                log_date=date(2026, 2, 9),
                start_location="A",
                destination="B",
                purpose="BUYING",
                km="12.345",
                purchase_ids=[purchase.id],
            ),
            rate_cents_per_km=42,
        )

    assert expense.amount_net_cents == 200
    assert expense.amount_tax_cents == 40

    ledger = (
        await db_session.execute(
            select(LedgerEntry).where(LedgerEntry.entity_type == "opex", LedgerEntry.entity_id == expense.id)
        )
    ).scalar_one()
    assert ledger.amount_cents == -240

    assert log.distance_meters == 12_345
    assert log.amount_cents == 518
    assert log.purchase_id == purchase.id


@pytest.mark.asyncio
async def test_dashboard_and_vat_report_calculations(db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, "C")
        purchase = await create_purchase(
            db_session,
            actor=ACTOR,
            data=PurchaseCreate(
                kind=PurchaseKind.COMMERCIAL_REGULAR,
                purchase_date=date(2026, 2, 1),
                counterparty_name="Supplier",
                total_amount_cents=1_200,
                tax_rate_bp=2_000,
                payment_source=PaymentSource.BANK,
                external_invoice_number="SUP-2",
                receipt_upload_path="uploads/sup-2.pdf",
                lines=[
                    PurchaseLineCreate(
                        master_product_id=mp.id,
                        condition=InventoryCondition.GOOD,
                        purchase_type=PurchaseType.REGULAR,
                        purchase_price_cents=1_200,
                    )
                ],
            ),
        )

    purchase_row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    item_id = (
        await db_session.execute(select(InventoryItem.id).where(InventoryItem.purchase_line_id == purchase_row.lines[0].id))
    ).scalar_one()
    await db_session.rollback()

    async with db_session.begin():
        order = await create_sales_order(
            db_session,
            actor=ACTOR,
            data=SalesOrderCreate(
                order_date=date(2026, 2, 2),
                channel=OrderChannel.EBAY,
                buyer_name="Buyer",
                shipping_gross_cents=0,
                payment_source=PaymentSource.BANK,
                lines=[SalesOrderLineCreate(inventory_item_id=item_id, sale_gross_cents=2_400)],
            ),
        )
    async with db_session.begin():
        await finalize_sales_order(db_session, actor=ACTOR, order_id=order.id)

    dash = await dashboard(db_session, today=date(2026, 2, 15))
    assert dash["inventory_value_cents"] == 0
    assert dash["cash_balance_cents"]["BANK"] == 1_200
    assert dash["gross_profit_month_cents"] == 1_400

    vat = await vat_report(db_session, year=2026, month=2)
    assert vat["output_vat_regular_cents"] == 400
    assert vat["output_vat_margin_cents"] == 0
    assert vat["input_vat_cents"] == 200
    assert vat["vat_payable_cents"] == 200


@pytest.mark.asyncio
async def test_monthly_close_zip_contains_core_csv_exports(db_session: AsyncSession, tmp_path) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, "D")
        await create_purchase(
            db_session,
            actor=ACTOR,
            data=PurchaseCreate(
                kind=PurchaseKind.PRIVATE_DIFF,
                purchase_date=date(2026, 2, 8),
                counterparty_name="Privat",
                total_amount_cents=500,
                payment_source=PaymentSource.CASH,
                lines=[
                    PurchaseLineCreate(
                        master_product_id=mp.id,
                        condition=InventoryCondition.GOOD,
                        purchase_type=PurchaseType.DIFF,
                        purchase_price_cents=500,
                    )
                ],
            ),
        )

    filename, content = await monthly_close_zip(db_session, year=2026, month=2, storage_dir=tmp_path)
    assert filename == "month-close-2026-02.zip"

    with zipfile.ZipFile(io.BytesIO(content), "r") as zf:
        names = set(zf.namelist())

    assert "csv/journal.csv" in names
    assert "csv/mileage.csv" in names
    assert "csv/vat_summary.csv" in names
    assert "csv/sales_lines.csv" in names
