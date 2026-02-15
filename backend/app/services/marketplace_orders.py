from __future__ import annotations

import csv
import io
import re
import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy import delete, exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.core.enums import (
    CashRecognition,
    DocumentType,
    InventoryStatus,
    MarketplaceImportKind,
    MarketplaceMatchStrategy,
    MarketplaceStagedOrderStatus,
    OrderChannel,
    OrderStatus,
    PaymentSource,
    PurchaseType,
)
from app.models.inventory_item import InventoryItem
from app.models.marketplace_import_batch import MarketplaceImportBatch
from app.models.marketplace_staged_order import MarketplaceStagedOrder, MarketplaceStagedOrderLine
from app.models.master_product import MasterProduct
from app.models.sales import SalesOrder, SalesOrderLine
from app.models.sales_correction import SalesCorrectionLine
from app.schemas.marketplace_orders import MarketplaceOrdersImportRowError
from app.services.audit import audit_log
from app.services.documents import next_document_number
from app.services.inventory import transition_status
from app.services.money import parse_eur_to_cents, split_gross_to_net_and_tax
from app.services.sales import VAT_RATE_BP_STANDARD
from app.services.vat import allocate_proportional, margin_components


_RE_ITEM_CODE = re.compile(r"^IT-[A-Z0-9]{12}$")
_RE_MASTER_SKU = re.compile(r"^MP-[A-Z0-9]{12}$")


def _pick_csv_delimiter(csv_text: str, preferred: str | None) -> str:
    if preferred and len(preferred) == 1:
        return preferred
    first_non_empty = next((line for line in csv_text.splitlines() if line.strip()), "")
    if not first_non_empty:
        return ","
    candidates = [",", ";", "\t", "|"]
    return max(candidates, key=lambda candidate: first_non_empty.count(candidate))


@dataclass(frozen=True)
class ImportedStagedOrdersSummary:
    batch_id: uuid.UUID
    total_rows: int
    staged_orders_count: int
    staged_lines_count: int
    ready_orders_count: int
    needs_attention_orders_count: int
    skipped_orders_count: int
    failed_count: int
    errors: list[MarketplaceOrdersImportRowError]


async def import_marketplace_orders_csv(
    session: AsyncSession,
    *,
    actor: str,
    csv_text: str,
    delimiter: str | None,
    source_label: str | None,
) -> ImportedStagedOrdersSummary:
    raw = csv_text.lstrip("\ufeff")
    delim = _pick_csv_delimiter(raw, delimiter)
    reader = csv.DictReader(io.StringIO(raw), delimiter=delim)
    fieldnames = reader.fieldnames or []
    if not fieldnames:
        raise ValueError("CSV Header fehlt")

    required = {"channel", "external_order_id", "order_date", "sku", "sale_gross_eur", "shipping_gross_eur"}
    missing = sorted(required - set(fieldnames))
    if missing:
        raise ValueError(f"Pflichtspalten fehlen: {', '.join(missing)}")

    # Create batch first so staged orders can reference it.
    batch = MarketplaceImportBatch(
        kind=MarketplaceImportKind.ORDERS,
        actor=actor,
        source_label=(source_label or "").strip() or None,
        raw_csv_text=raw,
        total_rows=0,
        imported_count=0,
        skipped_count=0,
        failed_count=0,
        errors=None,
    )
    session.add(batch)
    await session.flush()

    errors: list[MarketplaceOrdersImportRowError] = []

    # Group parsed rows by (channel, external_order_id).
    parsed_by_order: dict[tuple[OrderChannel, str], dict] = {}
    parsed_lines: list[dict] = []

    total_rows = 0
    for row_number, row in enumerate(reader, start=2):
        values = {k: (row.get(k) or "").strip() for k in fieldnames}
        if not any(values.values()):
            continue
        total_rows += 1

        external_order_id = values.get("external_order_id") or None
        sku = values.get("sku") or None
        try:
            channel_raw = (values.get("channel") or "").strip().upper()
            if channel_raw not in ("AMAZON", "EBAY"):
                raise ValueError("channel must be AMAZON or EBAY")
            channel = OrderChannel[channel_raw]
            if not external_order_id:
                raise ValueError("external_order_id is required")
            if not sku:
                raise ValueError("sku is required")

            order_date = date.fromisoformat(values.get("order_date") or "")
            sale_gross_cents = parse_eur_to_cents(values.get("sale_gross_eur") or "")
            if sale_gross_cents <= 0:
                raise ValueError("sale_gross_eur must be > 0")
            shipping_gross_cents = parse_eur_to_cents(values.get("shipping_gross_eur") or "")
            if shipping_gross_cents < 0:
                raise ValueError("shipping_gross_eur must be >= 0")

            quantity_raw = (values.get("quantity") or "").strip()
            quantity = int(quantity_raw) if quantity_raw else 1
            if quantity < 1:
                raise ValueError("quantity must be >= 1")
            if _RE_ITEM_CODE.match(sku) and quantity != 1:
                raise ValueError("quantity must be 1 for IT-... item codes")
        except Exception as e:
            errors.append(
                MarketplaceOrdersImportRowError(
                    row_number=row_number,
                    message=str(e) or "Ungültige Zeile",
                    external_order_id=external_order_id,
                    sku=sku,
                )
            )
            continue

        key = (channel, external_order_id)
        meta = parsed_by_order.get(key)
        if meta is None:
            buyer_name = (values.get("buyer_name") or "").strip() or f"{channel.value} {external_order_id}"
            buyer_address = (values.get("buyer_address") or "").strip() or None
            parsed_by_order[key] = {
                "order_date": order_date,
                "buyer_name": buyer_name,
                "buyer_address": buyer_address,
            }
        else:
            # If conflicting dates appear, keep the first and record an error.
            if meta.get("order_date") != order_date:
                errors.append(
                    MarketplaceOrdersImportRowError(
                        row_number=row_number,
                        message="order_date is inconsistent within the same external_order_id",
                        external_order_id=external_order_id,
                        sku=sku,
                    )
                )

        title = (values.get("title") or "").strip() or None
        for _i in range(quantity):
            parsed_lines.append(
                {
                    "row_number": row_number,
                    "channel": channel,
                    "external_order_id": external_order_id,
                    "order_date": order_date,
                    "buyer_name": parsed_by_order[key]["buyer_name"],
                    "buyer_address": parsed_by_order[key]["buyer_address"],
                    "sku": sku,
                    "title": title,
                    "sale_gross_cents": sale_gross_cents,
                    "shipping_gross_cents": shipping_gross_cents,
                }
            )

    used_inventory_ids: set[uuid.UUID] = set()

    staged_orders_count = 0
    staged_lines_count = 0
    ready_orders_count = 0
    needs_attention_orders_count = 0
    skipped_orders_count = 0

    # Pre-group lines for deterministic processing.
    lines_by_order: dict[tuple[OrderChannel, str], list[dict]] = {}
    for line in parsed_lines:
        lines_by_order.setdefault((line["channel"], line["external_order_id"]), []).append(line)

    for key, meta in sorted(parsed_by_order.items(), key=lambda x: (x[0][0].value, x[0][1])):
        channel, external_order_id = key
        existing = (
            (
                await session.execute(
                    select(MarketplaceStagedOrder)
                    .where(
                        MarketplaceStagedOrder.channel == channel,
                        MarketplaceStagedOrder.external_order_id == external_order_id,
                    )
                    .options(selectinload(MarketplaceStagedOrder.lines))
                )
            )
            .scalars()
            .one_or_none()
        )

        if existing is not None and (existing.status == MarketplaceStagedOrderStatus.APPLIED or existing.sales_order_id is not None):
            skipped_orders_count += 1
            continue

        if existing is None:
            order = MarketplaceStagedOrder(
                batch_id=batch.id,
                channel=channel,
                external_order_id=external_order_id,
                order_date=meta["order_date"],
                buyer_name=meta["buyer_name"],
                buyer_address=meta["buyer_address"],
                shipping_gross_cents=0,
                status=MarketplaceStagedOrderStatus.NEEDS_ATTENTION,
                sales_order_id=None,
            )
            session.add(order)
            await session.flush()
            staged_orders_count += 1
        else:
            order = existing
            order.batch_id = batch.id
            order.order_date = meta["order_date"]
            order.buyer_name = meta["buyer_name"]
            order.buyer_address = meta["buyer_address"]
            order.shipping_gross_cents = 0
            order.status = MarketplaceStagedOrderStatus.NEEDS_ATTENTION
            await session.execute(delete(MarketplaceStagedOrderLine).where(MarketplaceStagedOrderLine.staged_order_id == order.id))
            await session.flush()
            staged_orders_count += 1

        order_lines = lines_by_order.get(key, [])
        line_rows: list[MarketplaceStagedOrderLine] = []
        order_ok = True
        order_shipping_total = 0
        for line in order_lines:
            sku = line["sku"]
            match_inventory_id: uuid.UUID | None = None
            strategy = MarketplaceMatchStrategy.NONE
            match_error: str | None = None

            if _RE_ITEM_CODE.match(sku):
                strategy = MarketplaceMatchStrategy.ITEM_CODE
                inv = (
                    (
                        await session.execute(
                            select(InventoryItem).where(InventoryItem.item_code == sku)
                        )
                    )
                    .scalars()
                    .one_or_none()
                )
                if inv is None:
                    match_error = "Inventory item not found for item_code"
                else:
                    if inv.id in used_inventory_ids:
                        match_error = "Inventory item already matched in this import"
                    elif inv.status not in (InventoryStatus.AVAILABLE, InventoryStatus.FBA_WAREHOUSE):
                        match_error = f"Inventory item not sellable (status={inv.status.value})"
                    else:
                        already_sold = (
                            await session.scalar(
                                select(exists().where(SalesOrderLine.inventory_item_id == inv.id))
                            )
                        ) or False
                        already_corrected = (
                            await session.scalar(
                                select(exists().where(SalesCorrectionLine.inventory_item_id == inv.id))
                            )
                        ) or False
                        if already_sold or already_corrected:
                            match_error = "Inventory item already sold/corrected"
                        else:
                            match_inventory_id = inv.id

            elif _RE_MASTER_SKU.match(sku):
                strategy = MarketplaceMatchStrategy.MASTER_SKU_FIFO
                mp = (
                    (await session.execute(select(MasterProduct).where(MasterProduct.sku == sku))).scalars().one_or_none()
                )
                if mp is None:
                    match_error = "Master product not found for MP-... sku"
                else:
                    effective_date = func.coalesce(InventoryItem.acquired_date, func.date(InventoryItem.created_at))
                    stmt = (
                        select(InventoryItem)
                        .where(
                            InventoryItem.master_product_id == mp.id,
                            InventoryItem.status.in_((InventoryStatus.FBA_WAREHOUSE, InventoryStatus.AVAILABLE)),
                            ~exists().where(SalesOrderLine.inventory_item_id == InventoryItem.id),
                            ~exists().where(SalesCorrectionLine.inventory_item_id == InventoryItem.id),
                        )
                        .order_by(
                            (InventoryItem.status == InventoryStatus.FBA_WAREHOUSE).desc(),
                            effective_date.asc(),
                            InventoryItem.created_at.asc(),
                            InventoryItem.id.asc(),
                        )
                        .limit(20)
                    )
                    if used_inventory_ids:
                        stmt = stmt.where(~InventoryItem.id.in_(sorted(used_inventory_ids)))
                    candidates = (await session.execute(stmt)).scalars().all()
                    inv = candidates[0] if candidates else None
                    if inv is None:
                        match_error = "No sellable inventory available for master sku"
                    else:
                        match_inventory_id = inv.id

            else:
                match_error = "Unsupported sku format (expected IT-... or MP-...)"

            if match_inventory_id is not None:
                used_inventory_ids.add(match_inventory_id)
            else:
                order_ok = False

            order_shipping_total += int(line["shipping_gross_cents"])
            line_rows.append(
                MarketplaceStagedOrderLine(
                    staged_order_id=order.id,
                    sku=sku,
                    title=line.get("title"),
                    sale_gross_cents=int(line["sale_gross_cents"]),
                    shipping_gross_cents=int(line["shipping_gross_cents"]),
                    matched_inventory_item_id=match_inventory_id,
                    match_strategy=strategy,
                    match_error=match_error,
                )
            )
            staged_lines_count += 1

        order.shipping_gross_cents = int(order_shipping_total)
        order.status = MarketplaceStagedOrderStatus.READY if order_ok else MarketplaceStagedOrderStatus.NEEDS_ATTENTION
        if order.status == MarketplaceStagedOrderStatus.READY:
            ready_orders_count += 1
        else:
            needs_attention_orders_count += 1

        session.add_all(line_rows)

    batch.total_rows = int(total_rows)
    batch.imported_count = int(staged_orders_count)
    batch.skipped_count = int(skipped_orders_count)
    batch.failed_count = int(len(errors))
    batch.errors = [e.model_dump() for e in errors] if errors else None

    return ImportedStagedOrdersSummary(
        batch_id=batch.id,
        total_rows=int(total_rows),
        staged_orders_count=int(staged_orders_count),
        staged_lines_count=int(staged_lines_count),
        ready_orders_count=int(ready_orders_count),
        needs_attention_orders_count=int(needs_attention_orders_count),
        skipped_orders_count=int(skipped_orders_count),
        failed_count=int(len(errors)),
        errors=errors,
    )


async def apply_staged_order_to_finalized_sale(
    session: AsyncSession,
    *,
    actor: str,
    staged_order_id: uuid.UUID,
) -> uuid.UUID:
    order = (
        (
            await session.execute(
                select(MarketplaceStagedOrder)
                .where(MarketplaceStagedOrder.id == staged_order_id)
                .options(selectinload(MarketplaceStagedOrder.lines))
            )
        )
        .scalars()
        .one_or_none()
    )
    if order is None:
        raise ValueError("Staged order not found")
    if order.status == MarketplaceStagedOrderStatus.APPLIED or order.sales_order_id is not None:
        raise ValueError("Staged order already applied")
    if order.status != MarketplaceStagedOrderStatus.READY:
        raise ValueError("Only READY staged orders can be applied")
    if not order.lines:
        raise ValueError("Staged order has no lines")

    settings = get_settings()
    regular_vat_rate_bp = VAT_RATE_BP_STANDARD if settings.vat_enabled else 0

    invoice_number = await next_document_number(session, doc_type=DocumentType.SALES_INVOICE, issue_date=order.order_date)

    sale = SalesOrder(
        order_date=order.order_date,
        channel=order.channel,
        status=OrderStatus.FINALIZED,
        cash_recognition=CashRecognition.AT_PAYOUT,
        external_order_id=order.external_order_id,
        buyer_name=order.buyer_name,
        buyer_address=order.buyer_address,
        shipping_gross_cents=order.shipping_gross_cents,
        payment_source=PaymentSource.BANK,
        invoice_number=invoice_number,
        invoice_pdf_path=None,
    )
    session.add(sale)
    await session.flush()

    # Create lines and transition inventory directly to SOLD.
    line_models: list[SalesOrderLine] = []
    inv_rows: list[tuple[SalesOrderLine, InventoryItem]] = []
    for l in order.lines:
        inv_id = l.matched_inventory_item_id
        if inv_id is None:
            raise ValueError("Staged line is missing matched_inventory_item_id")
        item = await session.get(InventoryItem, inv_id)
        if item is None:
            raise ValueError(f"Inventory item not found: {inv_id}")
        if item.status not in (InventoryStatus.AVAILABLE, InventoryStatus.FBA_WAREHOUSE):
            raise ValueError(f"Inventory item not sellable: {item.id} (status={item.status})")
        already_sold = (
            await session.scalar(
                select(exists().where(SalesOrderLine.inventory_item_id == item.id))
            )
        ) or False
        already_corrected = (
            await session.scalar(
                select(exists().where(SalesCorrectionLine.inventory_item_id == item.id))
            )
        ) or False
        if already_sold or already_corrected:
            raise ValueError(f"Inventory item already sold/corrected: {item.id}")

        tax_rate_bp = 0 if item.purchase_type == PurchaseType.DIFF else regular_vat_rate_bp
        net, tax = split_gross_to_net_and_tax(gross_cents=int(l.sale_gross_cents), tax_rate_bp=tax_rate_bp)

        sol = SalesOrderLine(
            order_id=sale.id,
            inventory_item_id=item.id,
            purchase_type=item.purchase_type,
            sale_gross_cents=int(l.sale_gross_cents),
            sale_net_cents=net,
            sale_tax_cents=tax,
            tax_rate_bp=tax_rate_bp,
        )
        session.add(sol)
        line_models.append(sol)
        inv_rows.append((sol, item))

        await transition_status(session, actor=actor, item=item, new_status=InventoryStatus.SOLD)

    await session.flush()

    # Recompute shipping allocation + margin fields (same logic as finalization).
    item_ids_sorted = sorted([sol.inventory_item_id for sol in line_models], key=lambda x: str(x))
    line_by_item = {sol.inventory_item_id: sol for sol in line_models}
    weights = [int(line_by_item[i].sale_gross_cents) for i in item_ids_sorted]
    shipping_allocs = allocate_proportional(total_cents=int(sale.shipping_gross_cents), weights=weights)

    inv_cost_rows = (
        await session.execute(
            select(InventoryItem.id, InventoryItem.purchase_price_cents, InventoryItem.allocated_costs_cents).where(
                InventoryItem.id.in_(item_ids_sorted)
            )
        )
    ).all()
    inv_by_id = {r.id: r for r in inv_cost_rows}

    shipping_margin_gross_cents = 0
    for item_id, ship_alloc in zip(item_ids_sorted, shipping_allocs, strict=True):
        inv = inv_by_id.get(item_id)
        if inv is None:
            raise ValueError(f"Inventory item not found: {item_id}")

        sol = line_by_item[item_id]
        cost_basis_cents = int(inv.purchase_price_cents) + int(inv.allocated_costs_cents)
        sol.shipping_allocated_cents = int(ship_alloc)
        sol.cost_basis_cents = int(cost_basis_cents)

        if sol.purchase_type == PurchaseType.DIFF:
            shipping_margin_gross_cents += int(ship_alloc)
            mc = margin_components(
                consideration_gross_cents=int(sol.sale_gross_cents) + int(ship_alloc),
                cost_cents=cost_basis_cents,
                tax_rate_bp=regular_vat_rate_bp,
            )
            sol.margin_gross_cents = mc.margin_gross_cents
            sol.margin_net_cents = mc.margin_net_cents
            sol.margin_tax_cents = mc.margin_tax_cents
        else:
            sol.margin_gross_cents = 0
            sol.margin_net_cents = 0
            sol.margin_tax_cents = 0

    shipping_regular_gross_cents = int(sale.shipping_gross_cents) - int(shipping_margin_gross_cents)
    shipping_regular_net_cents, shipping_regular_tax_cents = split_gross_to_net_and_tax(
        gross_cents=shipping_regular_gross_cents,
        tax_rate_bp=regular_vat_rate_bp if shipping_regular_gross_cents else 0,
    )
    sale.shipping_regular_gross_cents = shipping_regular_gross_cents
    sale.shipping_regular_net_cents = shipping_regular_net_cents
    sale.shipping_regular_tax_cents = shipping_regular_tax_cents
    sale.shipping_margin_gross_cents = int(shipping_margin_gross_cents)

    await audit_log(
        session,
        actor=actor,
        entity_type="sale",
        entity_id=sale.id,
        action="import_apply",
        after={
            "channel": sale.channel,
            "external_order_id": sale.external_order_id,
            "invoice_number": sale.invoice_number,
            "cash_recognition": sale.cash_recognition,
        },
    )

    order.status = MarketplaceStagedOrderStatus.APPLIED
    order.sales_order_id = sale.id
    return sale.id
