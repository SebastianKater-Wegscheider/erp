from __future__ import annotations

import io
import uuid
import zipfile
from datetime import date, datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.core.enums import (
    InventoryCondition,
    InventoryStatus,
    OrderChannel,
    OpexCategory,
    PaymentSource,
    PurchaseKind,
    PurchaseType,
    TargetPriceMode,
)
from app.models.amazon_scrape import AmazonProductMetricsLatest
from app.models.inventory_item import InventoryItem
from app.models.ledger_entry import LedgerEntry
from app.models.master_product import MasterProduct
from app.models.purchase import Purchase
from app.models.sales_correction import SalesCorrection
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
from app.services.reports import company_dashboard, dashboard, monthly_close_zip, vat_report
from app.services.sales import create_sales_order, finalize_sales_order
from app.services.target_pricing import compute_effective_price, compute_recommendation, fba_payout_cents


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
async def test_company_dashboard_accounting_returns_monthly_cash_and_accrual_insights(db_session: AsyncSession) -> None:
    today = date(2026, 2, 15)

    async with db_session.begin():
        mp = await _create_master_product(db_session, "ACC")
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
                external_invoice_number="SUP-ACC-1",
                receipt_upload_path="uploads/sup-acc-1.pdf",
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
                channel=OrderChannel.AMAZON,
                buyer_name="Buyer Accounting",
                shipping_gross_cents=0,
                payment_source=PaymentSource.BANK,
                lines=[SalesOrderLineCreate(inventory_item_id=item_id, sale_gross_cents=2_400)],
            ),
        )
    async with db_session.begin():
        await finalize_sales_order(db_session, actor=ACTOR, order_id=order.id)

    async with db_session.begin():
        await create_opex(
            db_session,
            actor=ACTOR,
            data=OpexCreate(
                expense_date=date(2026, 2, 3),
                recipient="Accounting SaaS",
                category=OpexCategory.SOFTWARE,
                amount_cents=2_000,
                tax_rate_bp=2_000,
                input_tax_deductible=True,
                payment_source=PaymentSource.BANK,
            ),
        )

    async with db_session.begin():
        correction = SalesCorrection(
            order_id=order.id,
            correction_date=date(2026, 2, 4),
            correction_number="SC-2026-000001",
            pdf_path=None,
            refund_gross_cents=1_000,
            shipping_refund_gross_cents=0,
            shipping_refund_regular_gross_cents=0,
            shipping_refund_regular_net_cents=0,
            shipping_refund_regular_tax_cents=0,
            shipping_refund_margin_gross_cents=0,
            payment_source=PaymentSource.BANK,
        )
        db_session.add(correction)
        await db_session.flush()
        db_session.add(
            LedgerEntry(
                entry_date=correction.correction_date,
                account=correction.payment_source,
                amount_cents=-1_000,
                entity_type="sales_correction",
                entity_id=correction.id,
                memo=correction.correction_number,
            )
        )

        db_session.add_all(
            [
                LedgerEntry(
                    entry_date=date(2025, 9, 5),
                    account=PaymentSource.BANK,
                    amount_cents=3_500,
                    entity_type="sale",
                    entity_id=uuid.uuid4(),
                    memo="seed-cash-in",
                ),
                LedgerEntry(
                    entry_date=date(2025, 12, 5),
                    account=PaymentSource.BANK,
                    amount_cents=-1_000,
                    entity_type="opex",
                    entity_id=uuid.uuid4(),
                    memo="seed-dec-outflow",
                ),
                LedgerEntry(
                    entry_date=date(2026, 1, 5),
                    account=PaymentSource.BANK,
                    amount_cents=-1_000,
                    entity_type="opex",
                    entity_id=uuid.uuid4(),
                    memo="seed-jan-outflow",
                ),
            ]
        )

    out = await company_dashboard(db_session, today=today)
    accounting = out["accounting"]
    months = accounting["months"]
    by_month = {m["month"]: m for m in months}

    assert accounting["window_months"] == 6
    assert accounting["current_month"] == "2026-02"
    assert [m["month"] for m in months] == ["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02"]

    assert by_month["2025-10"]["cash_inflow_cents"] == 0
    assert by_month["2025-10"]["cash_outflow_cents"] == 0
    assert by_month["2025-10"]["accrual_income_cents"] == 0
    assert by_month["2025-10"]["accrual_expenses_cents"] == 0

    assert by_month["2026-02"]["cash_inflow_cents"] == 2_400
    assert by_month["2026-02"]["cash_outflow_cents"] == 4_200
    assert by_month["2026-02"]["cash_net_cents"] == -1_800
    assert by_month["2026-02"]["accrual_income_cents"] == 2_400
    assert by_month["2026-02"]["accrual_expenses_cents"] == 4_000
    assert by_month["2026-02"]["accrual_operating_result_cents"] == -1_600

    assert accounting["current_outflow_breakdown_cents"] == {
        "purchase": 1_200,
        "opex": 2_000,
        "cost_allocation": 0,
        "sales_correction": 1_000,
        "other": 0,
    }
    assert accounting["current_opex_by_category_cents"] == {"SOFTWARE": 2_000}

    vat = await vat_report(db_session, year=2026, month=2)
    assert accounting["current_vat_payable_cents"] == vat["vat_payable_cents"]

    assert accounting["average_cash_burn_3m_cents"] == 1_266
    assert accounting["estimated_runway_months"] == 0

    assert [i["key"] for i in accounting["insights"]] == ["runway_low", "cash_negative", "accrual_negative"]
    assert len(accounting["insights"]) == 3


@pytest.mark.asyncio
async def test_company_dashboard_uses_effective_target_prices_for_sell_value(db_session: AsyncSession) -> None:
    today = date(2026, 2, 15)
    settings = get_settings()

    async with db_session.begin():
        mp_manual = await _create_master_product(db_session, "SELL-MANUAL")
        mp_auto = await _create_master_product(db_session, "SELL-AUTO")

        manual_item = InventoryItem(
            master_product_id=mp_manual.id,
            condition=InventoryCondition.GOOD,
            purchase_type=PurchaseType.DIFF,
            purchase_price_cents=1_000,
            allocated_costs_cents=100,
            status=InventoryStatus.AVAILABLE,
            target_price_mode=TargetPriceMode.MANUAL,
            manual_target_sell_price_cents=5_000,
        )
        auto_item = InventoryItem(
            master_product_id=mp_auto.id,
            condition=InventoryCondition.GOOD,
            purchase_type=PurchaseType.DIFF,
            purchase_price_cents=1_200,
            allocated_costs_cents=0,
            status=InventoryStatus.AVAILABLE,
            target_price_mode=TargetPriceMode.AUTO,
            manual_target_sell_price_cents=None,
        )
        db_session.add_all([manual_item, auto_item])
        await db_session.flush()

        db_session.add(
            AmazonProductMetricsLatest(
                master_product_id=mp_auto.id,
                last_attempt_at=datetime(2026, 2, 15, tzinfo=timezone.utc),
                last_success_at=datetime(2026, 2, 15, tzinfo=timezone.utc),
                last_run_id=None,
                blocked_last=False,
                block_reason_last=None,
                last_error=None,
                rank_overall=8_000,
                rank_overall_category=None,
                rank_specific=None,
                rank_specific_category=None,
                price_new_cents=None,
                price_used_like_new_cents=4_000,
                price_used_very_good_cents=3_800,
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

    out = await company_dashboard(db_session, today=today)
    amazon = out["amazon_inventory"]

    auto_rec = compute_recommendation(
        purchase_price_cents=1_200,
        allocated_costs_cents=0,
        condition="GOOD",
        price_new_cents=None,
        price_used_like_new_cents=4_000,
        price_used_very_good_cents=3_800,
        price_used_good_cents=3_700,
        price_used_acceptable_cents=3_500,
        price_buybox_cents=3_600,
        rank=8_000,
        offers_count=3,
        settings=settings,
    )
    auto_effective, _ = compute_effective_price(
        mode="AUTO",
        manual_target_sell_price_cents=None,
        recommendation=auto_rec,
    )
    assert auto_effective is not None

    expected_payout = fba_payout_cents(
        market_price_cents=5_000,
        referral_fee_bp=settings.amazon_fba_referral_fee_bp,
        fulfillment_fee_cents=settings.amazon_fba_fulfillment_fee_cents,
        inbound_shipping_cents=settings.amazon_fba_inbound_shipping_cents,
    ) + fba_payout_cents(
        market_price_cents=auto_effective,
        referral_fee_bp=settings.amazon_fba_referral_fee_bp,
        fulfillment_fee_cents=settings.amazon_fba_fulfillment_fee_cents,
        inbound_shipping_cents=settings.amazon_fba_inbound_shipping_cents,
    )
    assert amazon["in_stock_units_total"] == 2
    assert amazon["in_stock_units_manual_priced"] == 1
    assert amazon["in_stock_units_auto_priced"] == 1
    assert amazon["in_stock_units_unpriced"] == 0
    assert amazon["in_stock_units_effective_priced"] == 2
    assert amazon["in_stock_fba_payout_cents"] == expected_payout


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
    (uploads_dir / "market-comp-1.png").write_bytes(b"marketcomp1")

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
                        "upload_path": "uploads/market-comp-1.png",
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
                    "upload_path": "uploads/market-comp-1.png",
                    "kind": "MARKET_COMP",
                    "purchase_line_id": str(purchase_line_id),
                },
            ]
        ),
        session=db_session,
    )
    assert market_comp[0].purchase_line_id == purchase_line_id

    listed = await list_purchase_attachments(purchase_id=purchase.id, session=db_session)
    assert len(listed) == 3
    assert {item.kind for item in listed} == {"CHAT", "LISTING", "MARKET_COMP"}

    await delete_purchase_attachment(
        purchase_id=purchase.id,
        attachment_id=created[0].id,
        session=db_session,
    )
    after_delete = await list_purchase_attachments(purchase_id=purchase.id, session=db_session)
    assert len(after_delete) == 2

    filename, content = await monthly_close_zip(db_session, year=2026, month=2, storage_dir=tmp_path)
    assert filename == "month-close-2026-02.zip"

    with zipfile.ZipFile(io.BytesIO(content), "r") as zf:
        names = set(zf.namelist())
        csv_content = zf.read("csv/purchase_attachments.csv").decode("utf-8")

    assert "csv/purchase_attachments.csv" in names
    assert "csv/private_equity_bookings.csv" in names
    assert "input_docs/purchase_attachments/uploads/listing-1.png" in names
    assert "input_docs/purchase_attachments/uploads/market-comp-1.png" in names
    assert "willhaben.at" in csv_content
    assert "LISTING" in csv_content
    assert "MARKET_COMP" in csv_content


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
