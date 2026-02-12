from __future__ import annotations

import io
import zipfile
from datetime import date

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.enums import InventoryCondition, OrderChannel, OpexCategory, PaymentSource, PurchaseKind, PurchaseType
from app.models.inventory_item import InventoryItem
from app.models.ledger_entry import LedgerEntry
from app.models.master_product import MasterProduct
from app.models.purchase import Purchase
from app.schemas.purchase_attachment import PurchaseAttachmentBatchCreate
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


@pytest.mark.asyncio
async def test_purchase_source_platform_suggestions_include_defaults_and_saved_values(db_session: AsyncSession) -> None:
    from app.api.v1.endpoints.purchases import list_purchase_source_platforms

    async with db_session.begin():
        mp = await _create_master_product(db_session, "E")
        await create_purchase(
            db_session,
            actor=ACTOR,
            data=PurchaseCreate(
                kind=PurchaseKind.PRIVATE_DIFF,
                purchase_date=date(2026, 2, 8),
                counterparty_name="Privat",
                source_platform="Flohmarkt Dornbirn",
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

    suggestions = await list_purchase_source_platforms(session=db_session)
    assert "Kleinanzeigen" in suggestions
    assert "eBay" in suggestions
    assert "willhaben.at" in suggestions
    assert "Laendleanzeiger.at" in suggestions
    assert "Flohmarkt Dornbirn" in suggestions


@pytest.mark.asyncio
async def test_purchase_attachments_crud_and_monthly_close_export(db_session: AsyncSession, tmp_path) -> None:
    from app.api.v1.endpoints.purchases import (
        add_purchase_attachments,
        delete_purchase_attachment,
        list_purchase_attachments,
    )

    async with db_session.begin():
        mp = await _create_master_product(db_session, "F")
        purchase = await create_purchase(
            db_session,
            actor=ACTOR,
            data=PurchaseCreate(
                kind=PurchaseKind.PRIVATE_DIFF,
                purchase_date=date(2026, 2, 8),
                counterparty_name="Privat",
                source_platform="willhaben.at",
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
    purchase_row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    purchase_line_id = purchase_row.lines[0].id

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)
    (uploads_dir / "chat-1.png").write_bytes(b"chat1")
    (uploads_dir / "listing-1.png").write_bytes(b"listing1")

    created = await add_purchase_attachments(
        purchase_id=purchase.id,
        data=PurchaseAttachmentBatchCreate(
            attachments=[
                {
                    "upload_path": "uploads/chat-1.png",
                    "kind": "CHAT",
                    "note": "Preis vereinbart",
                },
                {
                    "upload_path": "uploads/listing-1.png",
                    "kind": "LISTING",
                },
            ]
        ),
        session=db_session,
    )
    assert len(created) == 2

    with pytest.raises(HTTPException):
        await add_purchase_attachments(
            purchase_id=purchase.id,
            data=PurchaseAttachmentBatchCreate(
                attachments=[
                    {
                        "upload_path": "uploads/listing-1.png",
                        "kind": "MARKET_COMP",
                    },
                ]
            ),
            session=db_session,
        )

    market_comp = await add_purchase_attachments(
        purchase_id=purchase.id,
        data=PurchaseAttachmentBatchCreate(
            attachments=[
                {
                    "upload_path": "uploads/listing-1.png",
                    "kind": "MARKET_COMP",
                    "purchase_line_id": str(purchase_line_id),
                },
            ]
        ),
        session=db_session,
    )
    assert market_comp[0].purchase_line_id == purchase_line_id

    listed = await list_purchase_attachments(purchase_id=purchase.id, session=db_session)
    assert len(listed) == 2
    assert {item.kind for item in listed} == {"CHAT", "LISTING"}

    await delete_purchase_attachment(
        purchase_id=purchase.id,
        attachment_id=created[0].id,
        session=db_session,
    )
    after_delete = await list_purchase_attachments(purchase_id=purchase.id, session=db_session)
    assert len(after_delete) == 1

    filename, content = await monthly_close_zip(db_session, year=2026, month=2, storage_dir=tmp_path)
    assert filename == "month-close-2026-02.zip"

    with zipfile.ZipFile(io.BytesIO(content), "r") as zf:
        names = set(zf.namelist())
        csv_content = zf.read("csv/purchase_attachments.csv").decode("utf-8")

    assert "csv/purchase_attachments.csv" in names
    assert "csv/private_equity_bookings.csv" in names
    assert "input_docs/purchase_attachments/uploads/listing-1.png" in names
    assert "willhaben.at" in csv_content
    assert "LISTING" in csv_content


@pytest.mark.asyncio
async def test_month_close_includes_private_equity_booking_rows(db_session: AsyncSession, tmp_path) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, "PAIV")
        await create_purchase(
            db_session,
            actor=ACTOR,
            data=PurchaseCreate(
                kind=PurchaseKind.PRIVATE_EQUITY,
                purchase_date=date(2026, 2, 13),
                counterparty_name="Inhaber",
                total_amount_cents=1700,
                payment_source=PaymentSource.CASH,
                lines=[
                    PurchaseLineCreate(
                        master_product_id=mp.id,
                        condition=InventoryCondition.GOOD,
                        purchase_type=PurchaseType.DIFF,
                        market_value_cents=2000,
                        purchase_price_cents=None,
                        held_privately_over_12_months=True,
                    )
                ],
            ),
        )

    filename, content = await monthly_close_zip(db_session, year=2026, month=2, storage_dir=tmp_path)
    assert filename == "month-close-2026-02.zip"
    with zipfile.ZipFile(io.BytesIO(content), "r") as zf:
        pe_csv = zf.read("csv/private_equity_bookings.csv").decode("utf-8")

    assert "Privateinlagen" in pe_csv
    assert "Wareneingang 19%" in pe_csv or "Wareneingang 0%" in pe_csv
