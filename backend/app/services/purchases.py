from __future__ import annotations

from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import DocumentType, InventoryStatus, PurchaseKind, PurchaseType
from app.core.config import get_settings
from app.models.inventory_item import InventoryItem
from app.models.ledger_entry import LedgerEntry
from app.models.master_product import MasterProduct
from app.models.purchase import Purchase, PurchaseLine
from app.schemas.purchase import PurchaseCreate
from app.services.audit import audit_log
from app.services.documents import next_document_number
from app.services.money import format_eur, split_gross_to_net_and_tax
from app.services.pdf import render_pdf


async def create_purchase(session: AsyncSession, *, actor: str, data: PurchaseCreate) -> Purchase:
    if sum(line.purchase_price_cents for line in data.lines) != data.total_amount_cents:
        raise ValueError("Sum(lines.purchase_price_cents) must equal total_amount_cents")

    expected_type = PurchaseType.DIFF if data.kind == PurchaseKind.PRIVATE_DIFF else PurchaseType.REGULAR
    if any(line.purchase_type != expected_type for line in data.lines):
        raise ValueError(f"All lines.purchase_type must be {expected_type} for {data.kind}")

    tax_rate_bp = 0 if data.kind == PurchaseKind.PRIVATE_DIFF else (data.tax_rate_bp or 0)

    line_splits: list[tuple[int, int]] = []
    total_net = 0
    total_tax = 0
    for line in data.lines:
        net, tax = split_gross_to_net_and_tax(gross_cents=line.purchase_price_cents, tax_rate_bp=tax_rate_bp)
        line_splits.append((net, tax))
        total_net += net
        total_tax += tax

    document_number: str | None = None
    if data.kind == PurchaseKind.PRIVATE_DIFF:
        document_number = await next_document_number(
            session, doc_type=DocumentType.PURCHASE_CREDIT_NOTE, issue_date=data.purchase_date
        )

    purchase = Purchase(
        kind=data.kind,
        purchase_date=data.purchase_date,
        counterparty_name=data.counterparty_name,
        counterparty_address=data.counterparty_address,
        total_amount_cents=data.total_amount_cents,
        total_net_cents=total_net,
        total_tax_cents=total_tax,
        tax_rate_bp=tax_rate_bp,
        payment_source=data.payment_source,
        document_number=document_number,
        external_invoice_number=data.external_invoice_number,
        receipt_upload_path=data.receipt_upload_path,
    )
    session.add(purchase)
    await session.flush()

    for line, (line_net, line_tax) in zip(data.lines, line_splits, strict=True):
        pl = PurchaseLine(
            purchase_id=purchase.id,
            master_product_id=line.master_product_id,
            condition=line.condition,
            purchase_type=line.purchase_type,
            purchase_price_cents=line.purchase_price_cents,
            purchase_price_net_cents=line_net,
            purchase_price_tax_cents=line_tax,
            tax_rate_bp=tax_rate_bp,
        )
        session.add(pl)
        await session.flush()

        inventory_cost_cents = line_net if line.purchase_type == PurchaseType.REGULAR else line.purchase_price_cents
        item = InventoryItem(
            master_product_id=line.master_product_id,
            purchase_line_id=pl.id,
            condition=line.condition,
            purchase_type=line.purchase_type,
            purchase_price_cents=inventory_cost_cents,
            allocated_costs_cents=0,
            storage_location=None,
            status=InventoryStatus.AVAILABLE,
            acquired_date=data.purchase_date,
        )
        session.add(item)

        await audit_log(
            session,
            actor=actor,
            entity_type="inventory_item",
            entity_id=item.id,
            action="create",
            before=None,
            after={
                "master_product_id": str(item.master_product_id),
                "purchase_type": item.purchase_type,
                "purchase_price_cents": item.purchase_price_cents,
                "status": item.status,
            },
        )

    session.add(
        LedgerEntry(
            entry_date=data.purchase_date,
            account=data.payment_source,
            amount_cents=-data.total_amount_cents,
            entity_type="purchase",
            entity_id=purchase.id,
            memo=f"{data.kind} {purchase.document_number or ''}".strip(),
        )
    )

    await audit_log(
        session,
        actor=actor,
        entity_type="purchase",
        entity_id=purchase.id,
        action="create",
        after={
            "kind": purchase.kind,
            "total_amount_cents": purchase.total_amount_cents,
            "total_net_cents": purchase.total_net_cents,
            "total_tax_cents": purchase.total_tax_cents,
            "tax_rate_bp": purchase.tax_rate_bp,
            "payment_source": purchase.payment_source,
            "document_number": purchase.document_number,
            "external_invoice_number": purchase.external_invoice_number,
        },
    )

    if data.kind == PurchaseKind.PRIVATE_DIFF and purchase.document_number:
        settings = get_settings()
        templates_dir = Path(__file__).resolve().parents[1] / "templates"
        rel_path = f"pdfs/credit-notes/{purchase.document_number}.pdf"
        out_path = settings.app_storage_dir / rel_path

        mp_rows = (
            await session.execute(
                select(MasterProduct.id, MasterProduct.title, MasterProduct.platform, MasterProduct.region).where(
                    MasterProduct.id.in_([line.master_product_id for line in data.lines])
                )
            )
        ).all()
        mp_map = {r.id: r for r in mp_rows}

        lines = []
        for line in data.lines:
            mp = mp_map.get(line.master_product_id)
            lines.append(
                {
                    "title": mp.title if mp else str(line.master_product_id),
                    "platform": mp.platform if mp else "",
                    "region": mp.region if mp else "",
                    "condition": line.condition.value,
                    "purchase_price_eur": format_eur(line.purchase_price_cents),
                }
            )

        render_pdf(
            templates_dir=templates_dir,
            template_name="purchase_credit_note.html",
            context={
                "document_number": purchase.document_number,
                "purchase_date": purchase.purchase_date.isoformat(),
                "company_name": settings.company_name,
                "company_address": settings.company_address,
                "company_email": settings.company_email,
                "company_vat_id": settings.company_vat_id,
                "counterparty_name": purchase.counterparty_name,
                "counterparty_address": purchase.counterparty_address,
                "payment_source": purchase.payment_source.value,
                "lines": lines,
                "total_amount_eur": format_eur(purchase.total_amount_cents),
            },
            output_path=out_path,
            css_paths=[templates_dir / "base.css"],
        )
        purchase.pdf_path = rel_path

        await audit_log(
            session,
            actor=actor,
            entity_type="purchase",
            entity_id=purchase.id,
            action="generate_pdf",
            after={"pdf_path": purchase.pdf_path, "document_number": purchase.document_number},
        )

    return purchase
