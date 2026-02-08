from __future__ import annotations

import csv
import io
import zipfile
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.enums import InventoryStatus, OrderStatus, PurchaseKind, PurchaseType
from app.models.cost_allocation import CostAllocation
from app.models.inventory_item import InventoryItem
from app.models.ledger_entry import LedgerEntry
from app.models.master_product import MasterProduct
from app.models.mileage_log import MileageLog
from app.models.opex_expense import OpexExpense
from app.models.purchase import Purchase
from app.models.sales import SalesOrder, SalesOrderLine
from app.models.sales_correction import SalesCorrection, SalesCorrectionLine


@dataclass(frozen=True)
class MonthRange:
    start: date
    end: date


def month_range(*, year: int, month: int) -> MonthRange:
    start = date(year, month, 1)
    if month == 12:
        end = date(year + 1, 1, 1)
    else:
        end = date(year, month + 1, 1)
    return MonthRange(start=start, end=end)


async def dashboard(session: AsyncSession, *, today: date) -> dict:
    in_stock_statuses = [
        InventoryStatus.DRAFT,
        InventoryStatus.AVAILABLE,
        InventoryStatus.FBA_INBOUND,
        InventoryStatus.FBA_WAREHOUSE,
        InventoryStatus.RESERVED,
        InventoryStatus.RETURNED,
        InventoryStatus.DISCREPANCY,
    ]
    inv_value_stmt = select(
        func.coalesce(func.sum(InventoryItem.purchase_price_cents + InventoryItem.allocated_costs_cents), 0)
    ).where(InventoryItem.status.in_(in_stock_statuses))
    inventory_value_cents = int((await session.execute(inv_value_stmt)).scalar_one())

    cash_stmt = select(LedgerEntry.account, func.coalesce(func.sum(LedgerEntry.amount_cents), 0)).group_by(
        LedgerEntry.account
    )
    cash_rows = (await session.execute(cash_stmt)).all()
    cash_balance_cents = {account.value: int(total) for account, total in cash_rows}

    mr = month_range(year=today.year, month=today.month)
    sales_revenue_stmt = (
        select(func.coalesce(func.sum(SalesOrderLine.sale_gross_cents), 0))
        .select_from(SalesOrderLine)
        .join(SalesOrder, SalesOrder.id == SalesOrderLine.order_id)
        .where(
            and_(
                SalesOrder.status == OrderStatus.FINALIZED,
                SalesOrder.order_date >= mr.start,
                SalesOrder.order_date < mr.end,
            )
        )
    )
    sales_revenue_cents = int((await session.execute(sales_revenue_stmt)).scalar_one())

    shipping_stmt = select(func.coalesce(func.sum(SalesOrder.shipping_gross_cents), 0)).where(
        and_(
            SalesOrder.status == OrderStatus.FINALIZED,
            SalesOrder.order_date >= mr.start,
            SalesOrder.order_date < mr.end,
        )
    )
    shipping_revenue_cents = int((await session.execute(shipping_stmt)).scalar_one())

    cogs_stmt = (
        select(func.coalesce(func.sum(InventoryItem.purchase_price_cents + InventoryItem.allocated_costs_cents), 0))
        .select_from(SalesOrderLine)
        .join(SalesOrder, SalesOrder.id == SalesOrderLine.order_id)
        .join(InventoryItem, InventoryItem.id == SalesOrderLine.inventory_item_id)
        .where(
            and_(
                SalesOrder.status == OrderStatus.FINALIZED,
                SalesOrder.order_date >= mr.start,
                SalesOrder.order_date < mr.end,
            )
        )
    )
    cogs_cents = int((await session.execute(cogs_stmt)).scalar_one())

    gross_profit_month_cents = (sales_revenue_cents + shipping_revenue_cents) - cogs_cents

    return {
        "inventory_value_cents": inventory_value_cents,
        "cash_balance_cents": cash_balance_cents,
        "gross_profit_month_cents": gross_profit_month_cents,
    }


async def reseller_dashboard(session: AsyncSession, *, today: date, days: int = 90) -> dict:
    base = await dashboard(session, today=today)

    start_90 = today - timedelta(days=days - 1)
    start_30 = today - timedelta(days=29)

    revenue_expr = SalesOrderLine.sale_gross_cents + SalesOrderLine.shipping_allocated_cents
    profit_expr = revenue_expr - SalesOrderLine.cost_basis_cents

    sales_30d_stmt = (
        select(
            func.coalesce(func.sum(revenue_expr), 0),
            func.coalesce(func.sum(profit_expr), 0),
        )
        .select_from(SalesOrderLine)
        .join(SalesOrder, SalesOrder.id == SalesOrderLine.order_id)
        .where(
            and_(
                SalesOrder.status == OrderStatus.FINALIZED,
                SalesOrder.order_date >= start_30,
                SalesOrder.order_date <= today,
            )
        )
    )
    sales_revenue_30d_cents, gross_profit_30d_cents = (await session.execute(sales_30d_stmt)).one()
    sales_revenue_30d_cents = int(sales_revenue_30d_cents)
    gross_profit_30d_cents = int(gross_profit_30d_cents)

    series_stmt = (
        select(
            SalesOrder.order_date,
            func.coalesce(func.sum(revenue_expr), 0).label("revenue_cents"),
            func.coalesce(func.sum(profit_expr), 0).label("profit_cents"),
            func.count(func.distinct(SalesOrder.id)).label("orders_count"),
        )
        .select_from(SalesOrderLine)
        .join(SalesOrder, SalesOrder.id == SalesOrderLine.order_id)
        .where(
            and_(
                SalesOrder.status == OrderStatus.FINALIZED,
                SalesOrder.order_date >= start_90,
                SalesOrder.order_date <= today,
            )
        )
        .group_by(SalesOrder.order_date)
        .order_by(SalesOrder.order_date.asc())
    )
    series_rows = (await session.execute(series_stmt)).all()
    series_by_date = {r.order_date: r for r in series_rows}

    sales_timeseries = []
    for i in range(days):
        d = start_90 + timedelta(days=i)
        r = series_by_date.get(d)
        sales_timeseries.append(
            {
                "date": d.isoformat(),
                "revenue_cents": int(r.revenue_cents) if r else 0,
                "profit_cents": int(r.profit_cents) if r else 0,
                "orders_count": int(r.orders_count) if r else 0,
            }
        )

    channel_stmt = (
        select(SalesOrder.channel, func.coalesce(func.sum(revenue_expr), 0))
        .select_from(SalesOrderLine)
        .join(SalesOrder, SalesOrder.id == SalesOrderLine.order_id)
        .where(
            and_(
                SalesOrder.status == OrderStatus.FINALIZED,
                SalesOrder.order_date >= start_30,
                SalesOrder.order_date <= today,
            )
        )
        .group_by(SalesOrder.channel)
    )
    channel_rows = (await session.execute(channel_stmt)).all()
    revenue_by_channel_30d_cents = {channel.value: int(total) for channel, total in channel_rows}

    inventory_status_stmt = select(InventoryItem.status, func.count(InventoryItem.id)).group_by(InventoryItem.status)
    inventory_status_rows = (await session.execute(inventory_status_stmt)).all()
    inventory_status_counts = {status.value: int(count) for status, count in inventory_status_rows}

    in_stock_statuses = [
        InventoryStatus.DRAFT,
        InventoryStatus.AVAILABLE,
        InventoryStatus.FBA_INBOUND,
        InventoryStatus.FBA_WAREHOUSE,
        InventoryStatus.RESERVED,
        InventoryStatus.RETURNED,
        InventoryStatus.DISCREPANCY,
    ]
    inv_age_rows = (
        await session.execute(
            select(
                InventoryItem.purchase_price_cents,
                InventoryItem.allocated_costs_cents,
                InventoryItem.acquired_date,
                InventoryItem.created_at,
            ).where(InventoryItem.status.in_(in_stock_statuses))
        )
    ).all()

    buckets = [
        {"label": "0-30T", "days_min": 0, "days_max": 30, "count": 0, "value_cents": 0},
        {"label": "31-90T", "days_min": 31, "days_max": 90, "count": 0, "value_cents": 0},
        {"label": ">90T", "days_min": 91, "days_max": None, "count": 0, "value_cents": 0},
    ]
    for r in inv_age_rows:
        basis_cents = int(r.purchase_price_cents) + int(r.allocated_costs_cents)
        effective_date = r.acquired_date or r.created_at.date()
        age_days = (today - effective_date).days
        for b in buckets:
            if age_days < b["days_min"]:
                continue
            if b["days_max"] is not None and age_days > b["days_max"]:
                continue
            b["count"] += 1
            b["value_cents"] += basis_cents
            break

    inventory_aging = [{"label": b["label"], "count": b["count"], "value_cents": b["value_cents"]} for b in buckets]

    sales_orders_draft_count_stmt = select(func.count(SalesOrder.id)).where(SalesOrder.status == OrderStatus.DRAFT)
    sales_orders_draft_count = int((await session.execute(sales_orders_draft_count_stmt)).scalar_one())

    finalized_missing_pdf_stmt = select(func.count(SalesOrder.id)).where(
        and_(
            SalesOrder.status == OrderStatus.FINALIZED,
            or_(SalesOrder.invoice_pdf_path.is_(None), SalesOrder.invoice_pdf_path == ""),
        )
    )
    finalized_orders_missing_invoice_pdf_count = int((await session.execute(finalized_missing_pdf_stmt)).scalar_one())

    negative_profit_orders_stmt = (
        select(SalesOrder.id.label("order_id"))
        .select_from(SalesOrderLine)
        .join(SalesOrder, SalesOrder.id == SalesOrderLine.order_id)
        .where(
            and_(
                SalesOrder.status == OrderStatus.FINALIZED,
                SalesOrder.order_date >= start_30,
                SalesOrder.order_date <= today,
            )
        )
        .group_by(SalesOrder.id)
        .having(func.sum(profit_expr) < 0)
    ).subquery()
    negative_profit_orders_30d_count = int((await session.execute(select(func.count()).select_from(negative_profit_orders_stmt))).scalar_one())

    master_products_missing_asin_stmt = select(func.count(MasterProduct.id)).where(
        or_(MasterProduct.asin.is_(None), MasterProduct.asin == "")
    )
    master_products_missing_asin_count = int((await session.execute(master_products_missing_asin_stmt)).scalar_one())

    product_base_stmt = (
        select(
            MasterProduct.id,
            MasterProduct.sku,
            MasterProduct.title,
            MasterProduct.platform,
            MasterProduct.region,
            MasterProduct.variant,
            func.count(SalesOrderLine.id).label("units_sold"),
            func.coalesce(func.sum(revenue_expr), 0).label("revenue_cents"),
            func.coalesce(func.sum(profit_expr), 0).label("profit_cents"),
        )
        .select_from(SalesOrderLine)
        .join(SalesOrder, SalesOrder.id == SalesOrderLine.order_id)
        .join(InventoryItem, InventoryItem.id == SalesOrderLine.inventory_item_id)
        .join(MasterProduct, MasterProduct.id == InventoryItem.master_product_id)
        .where(
            and_(
                SalesOrder.status == OrderStatus.FINALIZED,
                SalesOrder.order_date >= start_30,
                SalesOrder.order_date <= today,
            )
        )
        .group_by(
            MasterProduct.id,
            MasterProduct.sku,
            MasterProduct.title,
            MasterProduct.platform,
            MasterProduct.region,
            MasterProduct.variant,
        )
    )
    top_products_rows = (
        await session.execute(
            product_base_stmt.order_by(func.sum(profit_expr).desc(), func.sum(revenue_expr).desc()).limit(5)
        )
    ).all()
    worst_products_rows = (
        await session.execute(
            product_base_stmt.order_by(func.sum(profit_expr).asc(), func.sum(revenue_expr).desc()).limit(5)
        )
    ).all()

    def _product_row_to_dict(r) -> dict:
        return {
            "master_product_id": str(r.id),
            "sku": r.sku,
            "title": r.title,
            "platform": r.platform,
            "region": r.region,
            "variant": r.variant,
            "units_sold": int(r.units_sold),
            "revenue_cents": int(r.revenue_cents),
            "profit_cents": int(r.profit_cents),
        }

    return {
        **base,
        "sales_revenue_30d_cents": sales_revenue_30d_cents,
        "gross_profit_30d_cents": gross_profit_30d_cents,
        "sales_timeseries": sales_timeseries,
        "revenue_by_channel_30d_cents": revenue_by_channel_30d_cents,
        "inventory_status_counts": inventory_status_counts,
        "inventory_aging": inventory_aging,
        "sales_orders_draft_count": sales_orders_draft_count,
        "finalized_orders_missing_invoice_pdf_count": finalized_orders_missing_invoice_pdf_count,
        "inventory_draft_count": int(inventory_status_counts.get(InventoryStatus.DRAFT.value, 0)),
        "inventory_reserved_count": int(inventory_status_counts.get(InventoryStatus.RESERVED.value, 0)),
        "inventory_returned_count": int(inventory_status_counts.get(InventoryStatus.RETURNED.value, 0)),
        "negative_profit_orders_30d_count": negative_profit_orders_30d_count,
        "master_products_missing_asin_count": master_products_missing_asin_count,
        "top_products_30d": [_product_row_to_dict(r) for r in top_products_rows],
        "worst_products_30d": [_product_row_to_dict(r) for r in worst_products_rows],
    }


async def monthly_close_zip(
    session: AsyncSession,
    *,
    year: int,
    month: int,
    storage_dir: Path,
) -> tuple[str, bytes]:
    mr = month_range(year=year, month=month)

    buf = io.BytesIO()
    filename = f"month-close-{year:04d}-{month:02d}.zip"

    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        # Journal (ledger)
        journal_rows = (
            await session.execute(
                select(
                    LedgerEntry.entry_date,
                    LedgerEntry.account,
                    LedgerEntry.amount_cents,
                    LedgerEntry.entity_type,
                    LedgerEntry.entity_id,
                    LedgerEntry.memo,
                ).where(and_(LedgerEntry.entry_date >= mr.start, LedgerEntry.entry_date < mr.end))
            )
        ).all()
        journal_csv = io.StringIO()
        writer = csv.writer(journal_csv)
        writer.writerow(["date", "account", "amount_cents", "entity_type", "entity_id", "memo"])
        for r in journal_rows:
            writer.writerow([r.entry_date, r.account.value, r.amount_cents, r.entity_type, r.entity_id, r.memo or ""])
        zf.writestr("csv/journal.csv", journal_csv.getvalue())

        # Mileage
        mileage_rows = (
            await session.execute(
                select(
                    MileageLog.log_date,
                    MileageLog.start_location,
                    MileageLog.destination,
                    MileageLog.purpose,
                    MileageLog.distance_meters,
                    MileageLog.rate_cents_per_km,
                    MileageLog.amount_cents,
                ).where(and_(MileageLog.log_date >= mr.start, MileageLog.log_date < mr.end))
            )
        ).all()
        mileage_csv = io.StringIO()
        mw = csv.writer(mileage_csv)
        mw.writerow(
            [
                "date",
                "start",
                "destination",
                "purpose",
                "distance_meters",
                "rate_cents_per_km",
                "amount_cents",
            ]
        )
        for r in mileage_rows:
            mw.writerow(
                [
                    r.log_date,
                    r.start_location,
                    r.destination,
                    r.purpose.value,
                    r.distance_meters,
                    r.rate_cents_per_km,
                    r.amount_cents,
                ]
            )
        zf.writestr("csv/mileage.csv", mileage_csv.getvalue())

        # VAT summary (best-effort)
        vat = await vat_report(session, year=year, month=month)
        vat_csv = io.StringIO()
        vw = csv.writer(vat_csv)
        vw.writerow(
            [
                "period_start",
                "period_end",
                "output_vat_regular_cents",
                "output_vat_margin_cents",
                "output_vat_adjustments_regular_cents",
                "output_vat_adjustments_margin_cents",
                "input_vat_cents",
                "vat_payable_cents",
            ]
        )
        vw.writerow(
            [
                vat["period_start"],
                vat["period_end"],
                vat["output_vat_regular_cents"],
                vat["output_vat_margin_cents"],
                vat["output_vat_adjustments_regular_cents"],
                vat["output_vat_adjustments_margin_cents"],
                vat["input_vat_cents"],
                vat["vat_payable_cents"],
            ]
        )
        zf.writestr("csv/vat_summary.csv", vat_csv.getvalue())

        # Sales lines (incl. margin fields) - best-effort
        sales_lines_rows = (
            await session.execute(
                select(
                    SalesOrder.order_date,
                    SalesOrder.invoice_number,
                    SalesOrder.channel,
                    SalesOrderLine.inventory_item_id,
                    SalesOrderLine.purchase_type,
                    SalesOrderLine.sale_gross_cents,
                    SalesOrderLine.sale_net_cents,
                    SalesOrderLine.sale_tax_cents,
                    SalesOrderLine.shipping_allocated_cents,
                    SalesOrderLine.cost_basis_cents,
                    SalesOrderLine.margin_gross_cents,
                    SalesOrderLine.margin_net_cents,
                    SalesOrderLine.margin_tax_cents,
                )
                .select_from(SalesOrderLine)
                .join(SalesOrder, SalesOrder.id == SalesOrderLine.order_id)
                .where(
                    and_(
                        SalesOrder.status == OrderStatus.FINALIZED,
                        SalesOrder.order_date >= mr.start,
                        SalesOrder.order_date < mr.end,
                    )
                )
            )
        ).all()
        sl_csv = io.StringIO()
        sw = csv.writer(sl_csv)
        sw.writerow(
            [
                "order_date",
                "invoice_number",
                "channel",
                "inventory_item_id",
                "purchase_type",
                "sale_gross_cents",
                "sale_net_cents",
                "sale_tax_cents",
                "shipping_allocated_cents",
                "cost_basis_cents",
                "margin_gross_cents",
                "margin_net_cents",
                "margin_tax_cents",
            ]
        )
        for r in sales_lines_rows:
            sw.writerow(
                [
                    r.order_date,
                    r.invoice_number or "",
                    r.channel.value,
                    r.inventory_item_id,
                    r.purchase_type.value,
                    r.sale_gross_cents,
                    r.sale_net_cents,
                    r.sale_tax_cents,
                    r.shipping_allocated_cents,
                    r.cost_basis_cents,
                    r.margin_gross_cents,
                    r.margin_net_cents,
                    r.margin_tax_cents,
                ]
            )
        zf.writestr("csv/sales_lines.csv", sl_csv.getvalue())

        # Corrections (PDFs) - best-effort
        corrections = (
            await session.execute(
                select(SalesCorrection).where(
                    and_(SalesCorrection.correction_date >= mr.start, SalesCorrection.correction_date < mr.end)
                )
            )
        ).scalars().all()
        for c in corrections:
            _zip_add_if_exists(zf, storage_dir, c.pdf_path, base_folder="output_corrections")

        # Documents (best-effort)
        purchases = (
            await session.execute(select(Purchase).where(and_(Purchase.purchase_date >= mr.start, Purchase.purchase_date < mr.end)))
        ).scalars().all()
        for p in purchases:
            for path in [p.pdf_path, p.receipt_upload_path]:
                _zip_add_if_exists(zf, storage_dir, path, base_folder="input_docs")

        expenses = (
            await session.execute(
                select(OpexExpense).where(and_(OpexExpense.expense_date >= mr.start, OpexExpense.expense_date < mr.end))
            )
        ).scalars().all()
        for e in expenses:
            _zip_add_if_exists(zf, storage_dir, e.receipt_upload_path, base_folder="input_docs")

        orders = (
            await session.execute(
                select(SalesOrder).where(and_(SalesOrder.order_date >= mr.start, SalesOrder.order_date < mr.end))
            )
        ).scalars().all()
        for o in orders:
            _zip_add_if_exists(zf, storage_dir, o.invoice_pdf_path, base_folder="output_invoices")

    return filename, buf.getvalue()


async def vat_report(session: AsyncSession, *, year: int, month: int) -> dict:
    """
    Lightweight VAT report for Austria-focused reseller flows.

    Notes:
    - Regular sales VAT is taken from SalesOrderLine.sale_tax_cents + SalesOrder.shipping_regular_tax_cents.
    - Margin scheme VAT is taken from SalesOrderLine.margin_tax_cents (computed at finalization).
    - Corrections reduce VAT via SalesCorrectionLine.refund_tax_cents / margin_vat_adjustment_cents and
      SalesCorrection.shipping_refund_regular_tax_cents.
    - Input VAT is from COMMERCIAL_REGULAR purchases + OpEx + Cost Allocations (when deductible).
    """
    settings = get_settings()
    mr = month_range(year=year, month=month)

    if not settings.vat_enabled:
        return {
            "period_start": mr.start.isoformat(),
            "period_end": mr.end.isoformat(),
            "output_vat_regular_cents": 0,
            "output_vat_margin_cents": 0,
            "output_vat_adjustments_regular_cents": 0,
            "output_vat_adjustments_margin_cents": 0,
            "input_vat_cents": 0,
            "vat_payable_cents": 0,
        }

    output_vat_regular_sales_stmt = (
        select(func.coalesce(func.sum(SalesOrderLine.sale_tax_cents), 0))
        .select_from(SalesOrderLine)
        .join(SalesOrder, SalesOrder.id == SalesOrderLine.order_id)
        .where(
            and_(
                SalesOrder.status == OrderStatus.FINALIZED,
                SalesOrder.order_date >= mr.start,
                SalesOrder.order_date < mr.end,
                SalesOrderLine.purchase_type == PurchaseType.REGULAR,
            )
        )
    )
    output_vat_regular_sales_cents = int((await session.execute(output_vat_regular_sales_stmt)).scalar_one())

    output_vat_regular_shipping_stmt = select(func.coalesce(func.sum(SalesOrder.shipping_regular_tax_cents), 0)).where(
        and_(
            SalesOrder.status == OrderStatus.FINALIZED,
            SalesOrder.order_date >= mr.start,
            SalesOrder.order_date < mr.end,
        )
    )
    output_vat_regular_shipping_cents = int((await session.execute(output_vat_regular_shipping_stmt)).scalar_one())

    output_vat_margin_stmt = (
        select(func.coalesce(func.sum(SalesOrderLine.margin_tax_cents), 0))
        .select_from(SalesOrderLine)
        .join(SalesOrder, SalesOrder.id == SalesOrderLine.order_id)
        .where(
            and_(
                SalesOrder.status == OrderStatus.FINALIZED,
                SalesOrder.order_date >= mr.start,
                SalesOrder.order_date < mr.end,
                SalesOrderLine.purchase_type == PurchaseType.DIFF,
            )
        )
    )
    output_vat_margin_cents = int((await session.execute(output_vat_margin_stmt)).scalar_one())

    adj_vat_regular_lines_stmt = (
        select(func.coalesce(func.sum(SalesCorrectionLine.refund_tax_cents), 0))
        .select_from(SalesCorrectionLine)
        .join(SalesCorrection, SalesCorrection.id == SalesCorrectionLine.correction_id)
        .where(
            and_(
                SalesCorrection.correction_date >= mr.start,
                SalesCorrection.correction_date < mr.end,
                SalesCorrectionLine.purchase_type == PurchaseType.REGULAR,
            )
        )
    )
    adj_vat_regular_lines_cents = int((await session.execute(adj_vat_regular_lines_stmt)).scalar_one())

    adj_vat_regular_shipping_stmt = select(
        func.coalesce(func.sum(SalesCorrection.shipping_refund_regular_tax_cents), 0)
    ).where(and_(SalesCorrection.correction_date >= mr.start, SalesCorrection.correction_date < mr.end))
    adj_vat_regular_shipping_cents = int((await session.execute(adj_vat_regular_shipping_stmt)).scalar_one())

    adj_vat_margin_stmt = (
        select(func.coalesce(func.sum(SalesCorrectionLine.margin_vat_adjustment_cents), 0))
        .select_from(SalesCorrectionLine)
        .join(SalesCorrection, SalesCorrection.id == SalesCorrectionLine.correction_id)
        .where(
            and_(
                SalesCorrection.correction_date >= mr.start,
                SalesCorrection.correction_date < mr.end,
                SalesCorrectionLine.purchase_type == PurchaseType.DIFF,
            )
        )
    )
    adj_vat_margin_cents = int((await session.execute(adj_vat_margin_stmt)).scalar_one())

    input_vat_purchases_stmt = select(func.coalesce(func.sum(Purchase.total_tax_cents), 0)).where(
        and_(
            Purchase.kind == PurchaseKind.COMMERCIAL_REGULAR,
            Purchase.purchase_date >= mr.start,
            Purchase.purchase_date < mr.end,
        )
    )
    input_vat_purchases_cents = int((await session.execute(input_vat_purchases_stmt)).scalar_one())

    input_vat_opex_stmt = select(func.coalesce(func.sum(OpexExpense.amount_tax_cents), 0)).where(
        and_(
            OpexExpense.input_tax_deductible.is_(True),
            OpexExpense.expense_date >= mr.start,
            OpexExpense.expense_date < mr.end,
        )
    )
    input_vat_opex_cents = int((await session.execute(input_vat_opex_stmt)).scalar_one())

    input_vat_allocations_stmt = select(func.coalesce(func.sum(CostAllocation.amount_tax_cents), 0)).where(
        and_(
            CostAllocation.input_tax_deductible.is_(True),
            CostAllocation.allocation_date >= mr.start,
            CostAllocation.allocation_date < mr.end,
        )
    )
    input_vat_allocations_cents = int((await session.execute(input_vat_allocations_stmt)).scalar_one())

    output_vat_regular_cents = output_vat_regular_sales_cents + output_vat_regular_shipping_cents
    output_vat_adjustments_regular_cents = adj_vat_regular_lines_cents + adj_vat_regular_shipping_cents
    output_vat_adjustments_margin_cents = adj_vat_margin_cents

    input_vat_cents = input_vat_purchases_cents + input_vat_opex_cents + input_vat_allocations_cents

    vat_payable_cents = (
        (output_vat_regular_cents - output_vat_adjustments_regular_cents)
        + (output_vat_margin_cents - output_vat_adjustments_margin_cents)
        - input_vat_cents
    )

    return {
        "period_start": mr.start.isoformat(),
        "period_end": mr.end.isoformat(),
        "output_vat_regular_cents": output_vat_regular_cents,
        "output_vat_margin_cents": output_vat_margin_cents,
        "output_vat_adjustments_regular_cents": output_vat_adjustments_regular_cents,
        "output_vat_adjustments_margin_cents": output_vat_adjustments_margin_cents,
        "input_vat_cents": input_vat_cents,
        "vat_payable_cents": vat_payable_cents,
    }


def _zip_add_if_exists(zf: zipfile.ZipFile, storage_dir: Path, rel_path: str | None, *, base_folder: str) -> None:
    if not rel_path:
        return
    rel_path = rel_path.lstrip("/")
    abs_path = (storage_dir / rel_path).resolve()
    try:
        abs_path.relative_to(storage_dir.resolve())
    except ValueError:
        return
    if not abs_path.is_file():
        return
    zf.write(abs_path, arcname=f"{base_folder}/{rel_path}")
