from __future__ import annotations

import uuid
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.enums import DocumentType, InventoryStatus, OrderStatus, PurchaseType
from app.core.config import get_settings
from app.models.inventory_item import InventoryItem
from app.models.ledger_entry import LedgerEntry
from app.models.master_product import MasterProduct
from app.models.sales import SalesOrder, SalesOrderLine
from app.schemas.sales import SalesOrderCreate
from app.services.audit import audit_log
from app.services.documents import next_document_number
from app.services.inventory import transition_status
from app.services.money import format_eur, split_gross_to_net_and_tax
from app.services.pdf import render_pdf


VAT_RATE_BP_STANDARD = 2000


async def create_sales_order(session: AsyncSession, *, actor: str, data: SalesOrderCreate) -> SalesOrder:
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

        if item.purchase_type == PurchaseType.DIFF:
            tax_rate_bp = 0
        else:
            tax_rate_bp = VAT_RATE_BP_STANDARD

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

    invoice_number = await next_document_number(
        session, doc_type=DocumentType.SALES_INVOICE, issue_date=order.order_date
    )
    order.invoice_number = invoice_number
    order.status = OrderStatus.FINALIZED

    settings = get_settings()
    templates_dir = Path(__file__).resolve().parents[1] / "templates"
    rel_path = f"pdfs/invoices/{invoice_number}.pdf"
    out_path = settings.app_storage_dir / rel_path

    mp_rows = (
        await session.execute(
            select(
                SalesOrderLine.inventory_item_id,
                SalesOrderLine.purchase_type,
                SalesOrderLine.sale_gross_cents,
                SalesOrderLine.sale_net_cents,
                SalesOrderLine.sale_tax_cents,
                MasterProduct.title,
                MasterProduct.platform,
                MasterProduct.region,
            )
            .select_from(SalesOrderLine)
            .join(InventoryItem, InventoryItem.id == SalesOrderLine.inventory_item_id)
            .join(MasterProduct, MasterProduct.id == InventoryItem.master_product_id)
            .where(SalesOrderLine.order_id == order.id)
        )
    ).all()

    lines_ctx = []
    has_diff_lines = False
    for r in mp_rows:
        if r.purchase_type == PurchaseType.DIFF:
            has_diff_lines = True
        lines_ctx.append(
            {
                "title": r.title,
                "platform": r.platform,
                "region": r.region,
                "purchase_type": r.purchase_type.value,
                "gross_eur": format_eur(r.sale_gross_cents),
                "net_eur": format_eur(r.sale_net_cents),
                "tax_eur": format_eur(r.sale_tax_cents),
            }
        )

    shipping_net_cents, shipping_tax_cents = split_gross_to_net_and_tax(
        gross_cents=order.shipping_gross_cents, tax_rate_bp=VAT_RATE_BP_STANDARD if order.shipping_gross_cents else 0
    )

    total_gross_cents = sum(r.sale_gross_cents for r in mp_rows) + order.shipping_gross_cents
    total_net_cents = sum(r.sale_net_cents for r in mp_rows) + shipping_net_cents
    total_tax_cents = sum(r.sale_tax_cents for r in mp_rows) + shipping_tax_cents

    render_pdf(
        templates_dir=templates_dir,
        template_name="sales_invoice.html",
        context={
            "invoice_number": invoice_number,
            "order_date": order.order_date.isoformat(),
            "company_name": settings.company_name,
            "company_address": settings.company_address,
            "company_email": settings.company_email,
            "company_vat_id": settings.company_vat_id,
            "buyer_name": order.buyer_name,
            "buyer_address": order.buyer_address,
            "channel": order.channel.value,
            "lines": lines_ctx,
            "has_diff_lines": has_diff_lines,
            "shipping_gross_cents": order.shipping_gross_cents,
            "shipping_gross_eur": format_eur(order.shipping_gross_cents),
            "shipping_net_eur": format_eur(shipping_net_cents),
            "shipping_tax_eur": format_eur(shipping_tax_cents),
            "total_gross_eur": format_eur(total_gross_cents),
            "total_net_eur": format_eur(total_net_cents),
            "total_tax_eur": format_eur(total_tax_cents),
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
        after={"invoice_number": invoice_number, "invoice_pdf_path": order.invoice_pdf_path},
    )

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
