from __future__ import annotations

import uuid
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.core.enums import DocumentType, InventoryCondition, InventoryStatus, OrderStatus, PurchaseType, ReturnAction
from app.models.inventory_item import InventoryItem
from app.models.ledger_entry import LedgerEntry
from app.models.master_product import MasterProduct
from app.models.sales import SalesOrder
from app.models.sales_correction import SalesCorrection, SalesCorrectionLine
from app.schemas.sales_correction import SalesCorrectionCreate
from app.services.audit import audit_log
from app.services.documents import next_document_number
from app.services.inventory import transition_status
from app.services.money import format_eur, split_gross_to_net_and_tax
from app.services.pdf import render_pdf
from app.services.sales import VAT_RATE_BP_STANDARD


async def create_sales_correction(
    session: AsyncSession,
    *,
    actor: str,
    order_id: uuid.UUID,
    data: SalesCorrectionCreate,
) -> SalesCorrection:
    result = await session.execute(
        select(SalesOrder).where(SalesOrder.id == order_id).options(selectinload(SalesOrder.lines))
    )
    order = result.scalar_one_or_none()
    if order is None:
        raise ValueError("Sales order not found")
    if order.status != OrderStatus.FINALIZED:
        raise ValueError("Only FINALIZED orders can be corrected")
    if not order.invoice_number:
        raise ValueError("Order has no invoice_number")

    requested_ids = [line.inventory_item_id for line in data.lines]
    existing = (
        await session.execute(
            select(SalesCorrectionLine.inventory_item_id).where(SalesCorrectionLine.inventory_item_id.in_(requested_ids))
        )
    ).scalars().all()
    if existing:
        raise ValueError(f"Some items already have a correction: {', '.join(str(x) for x in existing)}")

    order_line_by_item = {line.inventory_item_id: line for line in order.lines}
    for req in data.lines:
        if req.inventory_item_id not in order_line_by_item:
            raise ValueError(f"Item not part of order: {req.inventory_item_id}")

    correction_number = await next_document_number(
        session, doc_type=DocumentType.SALES_CORRECTION, issue_date=data.correction_date
    )

    refund_lines: list[SalesCorrectionLine] = []
    refund_total_gross = 0

    for req in data.lines:
        ol = order_line_by_item[req.inventory_item_id]

        refund_gross = req.refund_gross_cents if req.refund_gross_cents is not None else ol.sale_gross_cents
        if refund_gross <= 0:
            raise ValueError("refund_gross_cents must be > 0")

        if ol.purchase_type == PurchaseType.DIFF:
            tax_rate_bp = 0
            refund_net, refund_tax = refund_gross, 0
        else:
            tax_rate_bp = VAT_RATE_BP_STANDARD
            refund_net, refund_tax = split_gross_to_net_and_tax(gross_cents=refund_gross, tax_rate_bp=tax_rate_bp)

        refund_total_gross += refund_gross
        refund_lines.append(
            SalesCorrectionLine(
                inventory_item_id=ol.inventory_item_id,
                action=req.action,
                purchase_type=ol.purchase_type,
                refund_gross_cents=refund_gross,
                refund_net_cents=refund_net,
                refund_tax_cents=refund_tax,
                tax_rate_bp=tax_rate_bp,
            )
        )

    correction = SalesCorrection(
        order_id=order.id,
        correction_date=data.correction_date,
        correction_number=correction_number,
        refund_gross_cents=refund_total_gross,
        shipping_refund_gross_cents=data.shipping_refund_gross_cents,
        payment_source=data.payment_source,
    )
    session.add(correction)
    await session.flush()

    for rl in refund_lines:
        rl.correction_id = correction.id
        session.add(rl)

        item = await session.get(InventoryItem, rl.inventory_item_id)
        if item is None:
            raise ValueError(f"Inventory item not found: {rl.inventory_item_id}")
        if item.status != InventoryStatus.SOLD:
            raise ValueError(f"Inventory item not SOLD: {item.id} (status={item.status})")

        await transition_status(session, actor=actor, item=item, new_status=InventoryStatus.RETURNED)
        if rl.action == ReturnAction.RESTOCK:
            await transition_status(session, actor=actor, item=item, new_status=InventoryStatus.AVAILABLE)
        else:
            before = {"condition": item.condition.value}
            item.condition = InventoryCondition.DEFECT
            await audit_log(
                session,
                actor=actor,
                entity_type="inventory_item",
                entity_id=item.id,
                action="set_condition",
                before=before,
                after={"condition": item.condition.value},
            )
            await transition_status(session, actor=actor, item=item, new_status=InventoryStatus.LOST)

    refund_total_with_shipping = refund_total_gross + data.shipping_refund_gross_cents
    session.add(
        LedgerEntry(
            entry_date=data.correction_date,
            account=data.payment_source,
            amount_cents=-refund_total_with_shipping,
            entity_type="sales_correction",
            entity_id=correction.id,
            memo=correction_number,
        )
    )

    # PDF
    settings = get_settings()
    templates_dir = Path(__file__).resolve().parents[1] / "templates"
    rel_path = f"pdfs/corrections/{correction_number}.pdf"
    out_path = settings.app_storage_dir / rel_path

    mp_rows = (
        await session.execute(
            select(
                SalesCorrectionLine.inventory_item_id,
                SalesCorrectionLine.action,
                SalesCorrectionLine.purchase_type,
                SalesCorrectionLine.refund_gross_cents,
                SalesCorrectionLine.refund_net_cents,
                SalesCorrectionLine.refund_tax_cents,
                MasterProduct.title,
                MasterProduct.platform,
                MasterProduct.region,
            )
            .select_from(SalesCorrectionLine)
            .join(InventoryItem, InventoryItem.id == SalesCorrectionLine.inventory_item_id)
            .join(MasterProduct, MasterProduct.id == InventoryItem.master_product_id)
            .where(SalesCorrectionLine.correction_id == correction.id)
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
                "action": r.action.value,
                "gross_eur": format_eur(-r.refund_gross_cents),
                "net_eur": format_eur(-r.refund_net_cents),
                "tax_eur": format_eur(-r.refund_tax_cents),
            }
        )

    ship_net, ship_tax = split_gross_to_net_and_tax(
        gross_cents=data.shipping_refund_gross_cents,
        tax_rate_bp=VAT_RATE_BP_STANDARD if data.shipping_refund_gross_cents else 0,
    )

    total_gross_cents = -(refund_total_gross + data.shipping_refund_gross_cents)
    total_net_cents = -(sum(r.refund_net_cents for r in mp_rows) + ship_net)
    total_tax_cents = -(sum(r.refund_tax_cents for r in mp_rows) + ship_tax)

    render_pdf(
        templates_dir=templates_dir,
        template_name="sales_correction.html",
        context={
            "correction_number": correction_number,
            "correction_date": data.correction_date.isoformat(),
            "invoice_number": order.invoice_number,
            "company_name": settings.company_name,
            "company_address": settings.company_address,
            "company_email": settings.company_email,
            "company_vat_id": settings.company_vat_id,
            "buyer_name": order.buyer_name,
            "buyer_address": order.buyer_address,
            "channel": order.channel.value,
            "lines": lines_ctx,
            "has_diff_lines": has_diff_lines,
            "shipping_refund_gross_cents": data.shipping_refund_gross_cents,
            "shipping_gross_eur": format_eur(-data.shipping_refund_gross_cents),
            "shipping_net_eur": format_eur(-ship_net),
            "shipping_tax_eur": format_eur(-ship_tax),
            "total_gross_eur": format_eur(total_gross_cents),
            "total_net_eur": format_eur(total_net_cents),
            "total_tax_eur": format_eur(total_tax_cents),
        },
        output_path=out_path,
        css_paths=[templates_dir / "base.css"],
    )
    correction.pdf_path = rel_path

    await audit_log(
        session,
        actor=actor,
        entity_type="sales_correction",
        entity_id=correction.id,
        action="create",
        after={"correction_number": correction_number, "refund_gross_cents": correction.refund_gross_cents},
    )

    await audit_log(
        session,
        actor=actor,
        entity_type="sales_correction",
        entity_id=correction.id,
        action="generate_pdf",
        after={"pdf_path": correction.pdf_path},
    )

    return correction
