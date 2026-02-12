from __future__ import annotations

import uuid
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.enums import DocumentType, InventoryStatus, OrderStatus, PurchaseType
from app.core.config import get_settings
from app.models.inventory_item import InventoryItem
from app.models.ledger_entry import LedgerEntry
from app.models.master_product import MasterProduct
from app.models.sales import SalesOrder, SalesOrderLine
from app.models.sales_correction import SalesCorrection
from app.schemas.sales import SalesOrderCreate, SalesOrderUpdate
from app.services.audit import audit_log
from app.services.documents import next_document_number
from app.services.inventory import transition_status
from app.services.money import format_eur, split_gross_to_net_and_tax
from app.services.pdf import render_pdf
from app.services.vat import allocate_proportional, margin_components


VAT_RATE_BP_STANDARD = 2000


async def create_sales_order(session: AsyncSession, *, actor: str, data: SalesOrderCreate) -> SalesOrder:
    settings = get_settings()
    regular_vat_rate_bp = VAT_RATE_BP_STANDARD if settings.vat_enabled else 0

    order = SalesOrder(
        order_date=data.order_date,
        channel=data.channel,
        status=OrderStatus.DRAFT,
        buyer_name=data.buyer_name,
        buyer_address=data.buyer_address,
        shipping_gross_cents=data.shipping_gross_cents,
        payment_source=data.payment_source,
    )
    session.add(order)
    await session.flush()

    for line in data.lines:
        item = await session.get(InventoryItem, line.inventory_item_id)
        if item is None:
            raise ValueError(f"Inventory item not found: {line.inventory_item_id}")
        if item.status != InventoryStatus.AVAILABLE:
            raise ValueError(f"Inventory item not AVAILABLE: {item.id} (status={item.status})")

        await transition_status(session, actor=actor, item=item, new_status=InventoryStatus.RESERVED)

        tax_rate_bp = 0 if item.purchase_type == PurchaseType.DIFF else regular_vat_rate_bp

        net, tax = split_gross_to_net_and_tax(gross_cents=line.sale_gross_cents, tax_rate_bp=tax_rate_bp)

        session.add(
            SalesOrderLine(
                order_id=order.id,
                inventory_item_id=item.id,
                purchase_type=item.purchase_type,
                sale_gross_cents=line.sale_gross_cents,
                sale_net_cents=net,
                sale_tax_cents=tax,
                tax_rate_bp=tax_rate_bp,
            )
        )

    await audit_log(
        session,
        actor=actor,
        entity_type="sale",
        entity_id=order.id,
        action="create",
        after={"channel": order.channel, "shipping_gross_cents": order.shipping_gross_cents, "status": order.status},
    )

    return order


async def finalize_sales_order(session: AsyncSession, *, actor: str, order_id: uuid.UUID) -> SalesOrder:
    result = await session.execute(
        select(SalesOrder).where(SalesOrder.id == order_id).options(selectinload(SalesOrder.lines))
    )
    order = result.scalar_one_or_none()
    if order is None:
        raise ValueError("Sales order not found")
    if order.status != OrderStatus.DRAFT:
        raise ValueError("Only DRAFT orders can be finalized")
    if not order.lines:
        raise ValueError("Cannot finalize an order without lines")

    line_by_id: dict[uuid.UUID, SalesOrderLine] = {line.id: line for line in order.lines}

    invoice_number = order.invoice_number
    if not invoice_number:
        invoice_number = await next_document_number(
            session, doc_type=DocumentType.SALES_INVOICE, issue_date=order.order_date
        )
    order.invoice_number = invoice_number
    order.status = OrderStatus.FINALIZED

    settings = get_settings()
    regular_vat_rate_bp = VAT_RATE_BP_STANDARD if settings.vat_enabled else 0

    mp_rows = (
        await session.execute(
            select(
                SalesOrderLine.id,
                SalesOrderLine.inventory_item_id,
                SalesOrderLine.purchase_type,
                SalesOrderLine.sale_gross_cents,
                SalesOrderLine.sale_net_cents,
                SalesOrderLine.sale_tax_cents,
                InventoryItem.purchase_price_cents,
                InventoryItem.allocated_costs_cents,
            )
            .select_from(SalesOrderLine)
            .join(InventoryItem, InventoryItem.id == SalesOrderLine.inventory_item_id)
            .where(SalesOrderLine.order_id == order.id)
        )
    ).all()

    rows_sorted = sorted(mp_rows, key=lambda r: str(r.inventory_item_id))
    shipping_allocs = allocate_proportional(
        total_cents=order.shipping_gross_cents, weights=[int(r.sale_gross_cents) for r in rows_sorted]
    )

    shipping_margin_gross_cents = 0
    for r, ship_alloc in zip(rows_sorted, shipping_allocs, strict=True):
        cost_basis_cents = int(r.purchase_price_cents) + int(r.allocated_costs_cents)

        sol = line_by_id.get(r.id)
        if sol is None:
            raise ValueError(f"Sales order line not found: {r.id}")
        sol.shipping_allocated_cents = int(ship_alloc)
        sol.cost_basis_cents = int(cost_basis_cents)

        if r.purchase_type == PurchaseType.DIFF:
            shipping_margin_gross_cents += int(ship_alloc)
            mc = margin_components(
                consideration_gross_cents=int(r.sale_gross_cents) + int(ship_alloc),
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

    shipping_regular_gross_cents = int(order.shipping_gross_cents) - int(shipping_margin_gross_cents)
    shipping_regular_net_cents, shipping_regular_tax_cents = split_gross_to_net_and_tax(
        gross_cents=shipping_regular_gross_cents,
        tax_rate_bp=regular_vat_rate_bp if shipping_regular_gross_cents else 0,
    )
    order.shipping_regular_gross_cents = shipping_regular_gross_cents
    order.shipping_regular_net_cents = shipping_regular_net_cents
    order.shipping_regular_tax_cents = shipping_regular_tax_cents
    order.shipping_margin_gross_cents = int(shipping_margin_gross_cents)

    for line in order.lines:
        item = await session.get(InventoryItem, line.inventory_item_id)
        if item is None:
            raise ValueError(f"Inventory item not found: {line.inventory_item_id}")
        if item.status != InventoryStatus.RESERVED:
            raise ValueError(f"Inventory item not RESERVED: {item.id} (status={item.status})")
        await transition_status(session, actor=actor, item=item, new_status=InventoryStatus.SOLD)

    total_gross_cents = sum(line.sale_gross_cents for line in order.lines) + order.shipping_gross_cents
    session.add(
        LedgerEntry(
            entry_date=order.order_date,
            account=order.payment_source,
            amount_cents=total_gross_cents,
            entity_type="sale",
            entity_id=order.id,
            memo=invoice_number,
        )
    )

    await audit_log(
        session,
        actor=actor,
        entity_type="sale",
        entity_id=order.id,
        action="finalize",
        before={"status": OrderStatus.DRAFT},
        after={"status": order.status, "invoice_number": invoice_number},
    )

    return order


async def generate_sales_invoice_pdf(
    session: AsyncSession,
    *,
    actor: str,
    order_id: uuid.UUID,
) -> SalesOrder:
    """
    Generate the invoice PDF for a FINALIZED sales order.

    This is separated from finalization so the invoice can be created manually
    once all data is reviewed and complete.
    """
    result = await session.execute(
        select(SalesOrder).where(SalesOrder.id == order_id).options(selectinload(SalesOrder.lines))
    )
    order = result.scalar_one_or_none()
    if order is None:
        raise ValueError("Sales order not found")
    if order.status != OrderStatus.FINALIZED:
        raise ValueError("Only FINALIZED orders can generate an invoice PDF")
    if not order.invoice_number:
        raise ValueError("Order has no invoice_number")

    mp_rows = (
        await session.execute(
            select(
                SalesOrderLine.purchase_type,
                SalesOrderLine.sale_gross_cents,
                SalesOrderLine.sale_net_cents,
                SalesOrderLine.sale_tax_cents,
                MasterProduct.title,
                MasterProduct.platform,
                MasterProduct.region,
                MasterProduct.variant,
            )
            .select_from(SalesOrderLine)
            .join(InventoryItem, InventoryItem.id == SalesOrderLine.inventory_item_id)
            .join(MasterProduct, MasterProduct.id == InventoryItem.master_product_id)
            .where(SalesOrderLine.order_id == order.id)
        )
    ).all()

    has_diff_lines = any(r.purchase_type == PurchaseType.DIFF for r in mp_rows)
    has_regular_lines = any(r.purchase_type == PurchaseType.REGULAR for r in mp_rows)

    regular_goods_net_cents = sum(int(r.sale_net_cents) for r in mp_rows if r.purchase_type == PurchaseType.REGULAR)
    regular_goods_tax_cents = sum(int(r.sale_tax_cents) for r in mp_rows if r.purchase_type == PurchaseType.REGULAR)
    regular_goods_gross_cents = sum(int(r.sale_gross_cents) for r in mp_rows if r.purchase_type == PurchaseType.REGULAR)
    margin_goods_gross_cents = sum(int(r.sale_gross_cents) for r in mp_rows if r.purchase_type == PurchaseType.DIFF)

    shipping_regular_gross_cents = int(order.shipping_regular_gross_cents)
    shipping_regular_net_cents = int(order.shipping_regular_net_cents)
    shipping_regular_tax_cents = int(order.shipping_regular_tax_cents)
    shipping_margin_gross_cents = int(order.shipping_margin_gross_cents)

    regular_total_gross_cents = regular_goods_gross_cents + shipping_regular_gross_cents
    regular_total_net_cents = regular_goods_net_cents + shipping_regular_net_cents
    regular_total_tax_cents = regular_goods_tax_cents + shipping_regular_tax_cents

    margin_total_gross_cents = margin_goods_gross_cents + shipping_margin_gross_cents
    total_gross_cents = regular_total_gross_cents + margin_total_gross_cents

    lines_ctx = []
    for r in mp_rows:
        if r.purchase_type == PurchaseType.DIFF:
            lines_ctx.append(
                {
                    "title": r.title,
                    "platform": r.platform,
                    "region": r.region,
                    "variant": r.variant,
                    "purchase_type": r.purchase_type.value,
                    "gross_eur": format_eur(r.sale_gross_cents),
                    "net_eur": None,
                    "tax_eur": None,
                }
            )
        else:
            lines_ctx.append(
                {
                    "title": r.title,
                    "platform": r.platform,
                    "region": r.region,
                    "variant": r.variant,
                    "purchase_type": r.purchase_type.value,
                    "gross_eur": format_eur(r.sale_gross_cents),
                    "net_eur": format_eur(r.sale_net_cents),
                    "tax_eur": format_eur(r.sale_tax_cents),
                }
            )

    settings = get_settings()
    templates_dir = Path(__file__).resolve().parents[1] / "templates"
    rel_path = f"pdfs/invoices/{order.invoice_number}.pdf"
    out_path = settings.app_storage_dir / rel_path
    payment_source_label = {"CASH": "Bar", "BANK": "Bank"}.get(order.payment_source.value, order.payment_source.value)

    render_pdf(
        templates_dir=templates_dir,
        template_name="sales_invoice.html",
        context={
            "invoice_number": order.invoice_number,
            "order_date": order.order_date.strftime("%d.%m.%Y"),
            "company_name": settings.company_name,
            "company_address": settings.company_address,
            "company_email": settings.company_email,
            "company_vat_id": settings.company_vat_id,
            "company_logo_path": settings.company_logo_path,
            "company_small_business_notice": settings.company_small_business_notice,
            "buyer_name": order.buyer_name,
            "buyer_address": order.buyer_address,
            "channel": order.channel.value,
            "payment_source": payment_source_label,
            "lines": lines_ctx,
            "has_diff_lines": has_diff_lines,
            "has_regular_lines": has_regular_lines,
            "shipping_gross_cents": int(order.shipping_gross_cents),
            "shipping_gross_eur": format_eur(int(order.shipping_gross_cents)),
            "shipping_regular_gross_cents": shipping_regular_gross_cents,
            "shipping_regular_gross_eur": format_eur(shipping_regular_gross_cents),
            "shipping_regular_net_eur": format_eur(shipping_regular_net_cents),
            "shipping_regular_tax_eur": format_eur(shipping_regular_tax_cents),
            "shipping_margin_gross_cents": shipping_margin_gross_cents,
            "shipping_margin_gross_eur": format_eur(shipping_margin_gross_cents),
            "regular_total_gross_eur": format_eur(regular_total_gross_cents),
            "regular_total_net_eur": format_eur(regular_total_net_cents),
            "regular_total_tax_eur": format_eur(regular_total_tax_cents),
            "margin_total_gross_eur": format_eur(margin_total_gross_cents),
            "total_gross_eur": format_eur(total_gross_cents),
        },
        output_path=out_path,
        css_paths=[templates_dir / "base.css"],
    )
    order.invoice_pdf_path = rel_path

    await audit_log(
        session,
        actor=actor,
        entity_type="sale",
        entity_id=order.id,
        action="generate_invoice_pdf",
        after={"invoice_number": order.invoice_number, "invoice_pdf_path": order.invoice_pdf_path},
    )

    return order


async def update_sales_order(session: AsyncSession, *, actor: str, order_id: uuid.UUID, data: SalesOrderUpdate) -> SalesOrder:
    result = await session.execute(
        select(SalesOrder).where(SalesOrder.id == order_id).options(selectinload(SalesOrder.lines))
    )
    order = result.scalar_one_or_none()
    if order is None:
        raise ValueError("Sales order not found")
    if order.invoice_pdf_path:
        raise ValueError("Sales order is locked (invoice PDF already generated)")
    if order.status == OrderStatus.CANCELLED:
        raise ValueError("Cancelled orders cannot be edited")

    inv_ids = [line.inventory_item_id for line in data.lines]
    if len(set(inv_ids)) != len(inv_ids):
        raise ValueError("Duplicate inventory_item_id in lines")

    settings = get_settings()
    regular_vat_rate_bp = VAT_RATE_BP_STANDARD if settings.vat_enabled else 0

    before = {
        "order_date": order.order_date,
        "channel": order.channel,
        "buyer_name": order.buyer_name,
        "shipping_gross_cents": order.shipping_gross_cents,
        "payment_source": order.payment_source,
        "status": order.status,
        "lines_count": len(order.lines),
    }

    line_by_item: dict[uuid.UUID, SalesOrderLine] = {line.inventory_item_id: line for line in order.lines}
    existing_item_ids = set(line_by_item.keys())
    new_item_ids = set(inv_ids)

    order.order_date = data.order_date
    order.channel = data.channel
    order.buyer_name = data.buyer_name
    order.buyer_address = data.buyer_address
    order.shipping_gross_cents = data.shipping_gross_cents
    order.payment_source = data.payment_source

    if order.status == OrderStatus.DRAFT:
        # Remove lines/items that are no longer present.
        for item_id in sorted(existing_item_ids - new_item_ids, key=lambda x: str(x)):
            sol = line_by_item.get(item_id)
            if sol is not None:
                await session.delete(sol)
            item = await session.get(InventoryItem, item_id)
            if item is None:
                continue
            if item.status != InventoryStatus.RESERVED:
                raise ValueError(f"Inventory item not RESERVED: {item.id} (status={item.status})")
            await transition_status(session, actor=actor, item=item, new_status=InventoryStatus.AVAILABLE)

        # Upsert requested lines.
        for req in data.lines:
            item = await session.get(InventoryItem, req.inventory_item_id)
            if item is None:
                raise ValueError(f"Inventory item not found: {req.inventory_item_id}")

            if req.inventory_item_id in line_by_item:
                if item.status != InventoryStatus.RESERVED:
                    raise ValueError(f"Inventory item not RESERVED: {item.id} (status={item.status})")
                sol = line_by_item[req.inventory_item_id]
            else:
                if item.status != InventoryStatus.AVAILABLE:
                    raise ValueError(f"Inventory item not AVAILABLE: {item.id} (status={item.status})")
                await transition_status(session, actor=actor, item=item, new_status=InventoryStatus.RESERVED)
                sol = SalesOrderLine(order_id=order.id, inventory_item_id=item.id, purchase_type=item.purchase_type)
                session.add(sol)
                line_by_item[item.id] = sol

            sol.purchase_type = item.purchase_type
            tax_rate_bp = 0 if item.purchase_type == PurchaseType.DIFF else regular_vat_rate_bp
            net, tax = split_gross_to_net_and_tax(gross_cents=req.sale_gross_cents, tax_rate_bp=tax_rate_bp)
            sol.sale_gross_cents = req.sale_gross_cents
            sol.sale_net_cents = net
            sol.sale_tax_cents = tax
            sol.tax_rate_bp = tax_rate_bp

        # DRAFT orders have no internal split fields yet.
        order.shipping_regular_gross_cents = 0
        order.shipping_regular_net_cents = 0
        order.shipping_regular_tax_cents = 0
        order.shipping_margin_gross_cents = 0

    elif order.status == OrderStatus.FINALIZED:
        if new_item_ids != existing_item_ids:
            raise ValueError("FINALIZED orders cannot change their items (only amounts/metadata)")

        # Update amounts on existing lines.
        for req in data.lines:
            sol = line_by_item.get(req.inventory_item_id)
            if sol is None:
                raise ValueError("Sales order line not found")

            tax_rate_bp = 0 if sol.purchase_type == PurchaseType.DIFF else regular_vat_rate_bp
            net, tax = split_gross_to_net_and_tax(gross_cents=req.sale_gross_cents, tax_rate_bp=tax_rate_bp)
            sol.sale_gross_cents = req.sale_gross_cents
            sol.sale_net_cents = net
            sol.sale_tax_cents = tax
            sol.tax_rate_bp = tax_rate_bp

        # Recompute shipping allocation + margin fields (same logic as finalization).
        item_ids_sorted = sorted(existing_item_ids, key=lambda x: str(x))
        weights = [int(line_by_item[i].sale_gross_cents) for i in item_ids_sorted]
        shipping_allocs = allocate_proportional(total_cents=order.shipping_gross_cents, weights=weights)

        inv_rows = (
            await session.execute(
                select(InventoryItem.id, InventoryItem.purchase_price_cents, InventoryItem.allocated_costs_cents).where(
                    InventoryItem.id.in_(item_ids_sorted)
                )
            )
        ).all()
        inv_by_id = {r.id: r for r in inv_rows}

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

        shipping_regular_gross_cents = int(order.shipping_gross_cents) - int(shipping_margin_gross_cents)
        shipping_regular_net_cents, shipping_regular_tax_cents = split_gross_to_net_and_tax(
            gross_cents=shipping_regular_gross_cents,
            tax_rate_bp=regular_vat_rate_bp if shipping_regular_gross_cents else 0,
        )
        order.shipping_regular_gross_cents = shipping_regular_gross_cents
        order.shipping_regular_net_cents = shipping_regular_net_cents
        order.shipping_regular_tax_cents = shipping_regular_tax_cents
        order.shipping_margin_gross_cents = int(shipping_margin_gross_cents)

        # Update the ledger entry (create if missing).
        total_gross_cents = sum(int(line_by_item[i].sale_gross_cents) for i in item_ids_sorted) + int(order.shipping_gross_cents)
        entry = (
            (await session.execute(
                select(LedgerEntry).where(LedgerEntry.entity_type == "sale", LedgerEntry.entity_id == order.id)
            ))
            .scalars()
            .first()
        )
        if entry is None:
            entry = LedgerEntry(entity_type="sale", entity_id=order.id, memo=order.invoice_number)
            session.add(entry)
        entry.entry_date = order.order_date
        entry.account = order.payment_source
        entry.amount_cents = total_gross_cents
        entry.memo = order.invoice_number

    else:
        raise ValueError("Unsupported order status")

    await audit_log(
        session,
        actor=actor,
        entity_type="sale",
        entity_id=order.id,
        action="update",
        before=before,
        after={
            "order_date": order.order_date,
            "channel": order.channel,
            "buyer_name": order.buyer_name,
            "shipping_gross_cents": order.shipping_gross_cents,
            "payment_source": order.payment_source,
            "status": order.status,
            "lines_count": len(data.lines),
        },
    )

    return order


async def reopen_sales_order_for_edit(
    session: AsyncSession,
    *,
    actor: str,
    order_id: uuid.UUID,
) -> SalesOrder:
    result = await session.execute(
        select(SalesOrder).where(SalesOrder.id == order_id).options(selectinload(SalesOrder.lines))
    )
    order = result.scalar_one_or_none()
    if order is None:
        raise ValueError("Sales order not found")
    if order.status != OrderStatus.FINALIZED:
        raise ValueError("Only FINALIZED orders can be reopened")

    corrections_count = (
        await session.scalar(
            select(func.count()).select_from(SalesCorrection).where(SalesCorrection.order_id == order.id)
        )
    ) or 0
    if corrections_count:
        raise ValueError("Order cannot be reopened: returns/corrections already exist")

    old_invoice_pdf_path = order.invoice_pdf_path
    if old_invoice_pdf_path:
        settings = get_settings()
        abs_pdf_path = settings.app_storage_dir / old_invoice_pdf_path
        if abs_pdf_path.exists():
            abs_pdf_path.unlink()

    for line in sorted(order.lines, key=lambda row: str(row.inventory_item_id)):
        item = await session.get(InventoryItem, line.inventory_item_id)
        if item is None:
            raise ValueError(f"Inventory item not found: {line.inventory_item_id}")
        if item.status != InventoryStatus.SOLD:
            raise ValueError(f"Cannot reopen order: inventory item not SOLD ({item.id}, status={item.status})")

        before_status = item.status
        item.status = InventoryStatus.RESERVED
        await audit_log(
            session,
            actor=actor,
            entity_type="inventory_item",
            entity_id=item.id,
            action="reopen_sales_order",
            before={"status": before_status},
            after={"status": item.status},
        )

    ledger_entries = (
        await session.execute(select(LedgerEntry).where(LedgerEntry.entity_type == "sale", LedgerEntry.entity_id == order.id))
    ).scalars().all()
    for entry in ledger_entries:
        await session.delete(entry)

    before = {
        "status": order.status,
        "invoice_number": order.invoice_number,
        "invoice_pdf_path": old_invoice_pdf_path,
    }

    order.status = OrderStatus.DRAFT
    order.invoice_pdf_path = None
    order.shipping_regular_gross_cents = 0
    order.shipping_regular_net_cents = 0
    order.shipping_regular_tax_cents = 0
    order.shipping_margin_gross_cents = 0
    for line in order.lines:
        line.shipping_allocated_cents = 0
        line.cost_basis_cents = 0
        line.margin_gross_cents = 0
        line.margin_net_cents = 0
        line.margin_tax_cents = 0

    await audit_log(
        session,
        actor=actor,
        entity_type="sale",
        entity_id=order.id,
        action="reopen_for_edit",
        before=before,
        after={
            "status": order.status,
            "invoice_number": order.invoice_number,
            "invoice_pdf_path": order.invoice_pdf_path,
        },
    )

    return order


async def cancel_sales_order(session: AsyncSession, *, actor: str, order_id: uuid.UUID) -> SalesOrder:
    result = await session.execute(
        select(SalesOrder).where(SalesOrder.id == order_id).options(selectinload(SalesOrder.lines))
    )
    order = result.scalar_one_or_none()
    if order is None:
        raise ValueError("Sales order not found")
    if order.status != OrderStatus.DRAFT:
        raise ValueError("Only DRAFT orders can be cancelled")

    for line in order.lines:
        item = await session.get(InventoryItem, line.inventory_item_id)
        if item is None:
            continue
        if item.status == InventoryStatus.RESERVED:
            await transition_status(session, actor=actor, item=item, new_status=InventoryStatus.AVAILABLE)

    order.status = OrderStatus.CANCELLED
    await audit_log(
        session,
        actor=actor,
        entity_type="sale",
        entity_id=order.id,
        action="cancel",
        before={"status": OrderStatus.DRAFT},
        after={"status": OrderStatus.CANCELLED},
    )
    return order
