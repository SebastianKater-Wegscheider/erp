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
from app.services.vat import allocate_proportional, margin_components


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
    weights: list[int] = []

    for req in data.lines:
        ol = order_line_by_item[req.inventory_item_id]

        refund_gross = req.refund_gross_cents if req.refund_gross_cents is not None else ol.sale_gross_cents
        if refund_gross <= 0:
            raise ValueError("refund_gross_cents must be > 0")

        weights.append(int(ol.shipping_allocated_cents) if ol.shipping_allocated_cents > 0 else int(ol.sale_gross_cents))

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

    shipping_refund_allocs = allocate_proportional(total_cents=data.shipping_refund_gross_cents, weights=weights)
    shipping_refund_margin_gross_cents = 0
    for rl, ship_alloc in zip(refund_lines, shipping_refund_allocs, strict=True):
        rl.shipping_refund_allocated_cents = int(ship_alloc)
        if rl.purchase_type == PurchaseType.DIFF:
            shipping_refund_margin_gross_cents += int(ship_alloc)

    correction = SalesCorrection(
        order_id=order.id,
        correction_date=data.correction_date,
        correction_number=correction_number,
        refund_gross_cents=refund_total_gross,
        shipping_refund_gross_cents=data.shipping_refund_gross_cents,
        shipping_refund_margin_gross_cents=int(shipping_refund_margin_gross_cents),
        payment_source=data.payment_source,
    )
    shipping_refund_regular_gross_cents = int(data.shipping_refund_gross_cents) - int(shipping_refund_margin_gross_cents)
    ship_net, ship_tax = split_gross_to_net_and_tax(
        gross_cents=shipping_refund_regular_gross_cents,
        tax_rate_bp=VAT_RATE_BP_STANDARD if shipping_refund_regular_gross_cents else 0,
    )
    correction.shipping_refund_regular_gross_cents = shipping_refund_regular_gross_cents
    correction.shipping_refund_regular_net_cents = ship_net
    correction.shipping_refund_regular_tax_cents = ship_tax

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

        if rl.purchase_type == PurchaseType.DIFF:
            original_consideration_gross = int(order_line_by_item[rl.inventory_item_id].sale_gross_cents) + int(
                order_line_by_item[rl.inventory_item_id].shipping_allocated_cents
            )
            cost_basis_cents = int(order_line_by_item[rl.inventory_item_id].cost_basis_cents) or (
                int(item.purchase_price_cents) + int(item.allocated_costs_cents)
            )
            orig = margin_components(
                consideration_gross_cents=original_consideration_gross,
                cost_cents=cost_basis_cents,
                tax_rate_bp=VAT_RATE_BP_STANDARD,
            )
            new_consideration = original_consideration_gross - int(rl.refund_gross_cents) - int(
                rl.shipping_refund_allocated_cents
            )
            new = margin_components(
                consideration_gross_cents=new_consideration,
                cost_cents=cost_basis_cents,
                tax_rate_bp=VAT_RATE_BP_STANDARD,
            )
            rl.margin_vat_adjustment_cents = max(0, int(orig.margin_tax_cents) - int(new.margin_tax_cents))

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

    await audit_log(
        session,
        actor=actor,
        entity_type="sales_correction",
        entity_id=correction.id,
        action="create",
        after={"correction_number": correction_number, "refund_gross_cents": correction.refund_gross_cents},
    )

    return correction


async def generate_sales_correction_pdf(
    session: AsyncSession,
    *,
    actor: str,
    correction_id: uuid.UUID,
) -> SalesCorrection:
    """
    Generate the correction/storno PDF for a sales correction.

    Separated from `create_sales_correction()` so the document can be created manually
    once all data is reviewed and complete.
    """
    correction = (
        await session.execute(
            select(SalesCorrection).where(SalesCorrection.id == correction_id).options(selectinload(SalesCorrection.lines))
        )
    ).scalar_one_or_none()
    if correction is None:
        raise ValueError("Sales correction not found")
    if not correction.correction_number:
        raise ValueError("Correction has no correction_number")

    order = await session.get(SalesOrder, correction.order_id)
    if order is None:
        raise ValueError("Sales order not found")
    if not order.invoice_number:
        raise ValueError("Order has no invoice_number")

    mp_rows = (
        await session.execute(
            select(
                SalesCorrectionLine.action,
                SalesCorrectionLine.purchase_type,
                SalesCorrectionLine.refund_gross_cents,
                SalesCorrectionLine.refund_net_cents,
                SalesCorrectionLine.refund_tax_cents,
                MasterProduct.title,
                MasterProduct.platform,
                MasterProduct.region,
                MasterProduct.variant,
            )
            .select_from(SalesCorrectionLine)
            .join(InventoryItem, InventoryItem.id == SalesCorrectionLine.inventory_item_id)
            .join(MasterProduct, MasterProduct.id == InventoryItem.master_product_id)
            .where(SalesCorrectionLine.correction_id == correction.id)
        )
    ).all()

    lines_ctx = []
    has_diff_lines = any(r.purchase_type == PurchaseType.DIFF for r in mp_rows)
    has_regular_lines = any(r.purchase_type == PurchaseType.REGULAR for r in mp_rows)
    for r in mp_rows:
        lines_ctx.append(
            {
                "title": r.title,
                "platform": r.platform,
                "region": r.region,
                "variant": r.variant,
                "purchase_type": r.purchase_type.value,
                "action": r.action.value,
                "gross_eur": format_eur(-r.refund_gross_cents),
                "net_eur": None if r.purchase_type == PurchaseType.DIFF else format_eur(-r.refund_net_cents),
                "tax_eur": None if r.purchase_type == PurchaseType.DIFF else format_eur(-r.refund_tax_cents),
            }
        )

    regular_goods_gross = sum(int(r.refund_gross_cents) for r in mp_rows if r.purchase_type == PurchaseType.REGULAR)
    regular_goods_net = sum(int(r.refund_net_cents) for r in mp_rows if r.purchase_type == PurchaseType.REGULAR)
    regular_goods_tax = sum(int(r.refund_tax_cents) for r in mp_rows if r.purchase_type == PurchaseType.REGULAR)
    margin_goods_gross = sum(int(r.refund_gross_cents) for r in mp_rows if r.purchase_type == PurchaseType.DIFF)

    regular_total_gross_cents = -(regular_goods_gross + int(correction.shipping_refund_regular_gross_cents))
    regular_total_net_cents = -(regular_goods_net + int(correction.shipping_refund_regular_net_cents))
    regular_total_tax_cents = -(regular_goods_tax + int(correction.shipping_refund_regular_tax_cents))
    margin_total_gross_cents = -(margin_goods_gross + int(correction.shipping_refund_margin_gross_cents))
    total_gross_cents = regular_total_gross_cents + margin_total_gross_cents

    settings = get_settings()
    templates_dir = Path(__file__).resolve().parents[1] / "templates"
    rel_path = f"pdfs/corrections/{correction.correction_number}.pdf"
    out_path = settings.app_storage_dir / rel_path

    render_pdf(
        templates_dir=templates_dir,
        template_name="sales_correction.html",
        context={
            "correction_number": correction.correction_number,
            "correction_date": correction.correction_date.strftime("%d.%m.%Y"),
            "invoice_number": order.invoice_number,
            "company_name": settings.company_name,
            "company_address": settings.company_address,
            "company_email": settings.company_email,
            "company_vat_id": settings.company_vat_id,
            "company_small_business_notice": settings.company_small_business_notice,
            "buyer_name": order.buyer_name,
            "buyer_address": order.buyer_address,
            "channel": order.channel.value,
            "lines": lines_ctx,
            "has_diff_lines": has_diff_lines,
            "has_regular_lines": has_regular_lines,
            "shipping_refund_gross_cents": int(correction.shipping_refund_gross_cents),
            "shipping_refund_regular_gross_cents": int(correction.shipping_refund_regular_gross_cents),
            "shipping_refund_regular_gross_eur": format_eur(-int(correction.shipping_refund_regular_gross_cents)),
            "shipping_refund_regular_net_eur": format_eur(-int(correction.shipping_refund_regular_net_cents)),
            "shipping_refund_regular_tax_eur": format_eur(-int(correction.shipping_refund_regular_tax_cents)),
            "shipping_refund_margin_gross_cents": int(correction.shipping_refund_margin_gross_cents),
            "shipping_refund_margin_gross_eur": format_eur(-int(correction.shipping_refund_margin_gross_cents)),
            "regular_total_gross_eur": format_eur(regular_total_gross_cents),
            "regular_total_net_eur": format_eur(regular_total_net_cents),
            "regular_total_tax_eur": format_eur(regular_total_tax_cents),
            "margin_total_gross_eur": format_eur(margin_total_gross_cents),
            "total_gross_eur": format_eur(total_gross_cents),
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
        action="generate_pdf",
        after={"pdf_path": correction.pdf_path},
    )
    return correction
