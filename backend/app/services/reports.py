from __future__ import annotations

import csv
import io
import zipfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import InventoryStatus, OrderStatus
from app.models.inventory_item import InventoryItem
from app.models.ledger_entry import LedgerEntry
from app.models.mileage_log import MileageLog
from app.models.opex_expense import OpexExpense
from app.models.purchase import Purchase
from app.models.sales import SalesOrder, SalesOrderLine


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
        InventoryStatus.RESERVED,
        InventoryStatus.RETURNED,
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
