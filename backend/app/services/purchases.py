from __future__ import annotations

import uuid
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.enums import DocumentType, InventoryStatus, PurchaseKind, PurchaseType
from app.core.config import get_settings
from app.models.cost_allocation import CostAllocationLine
from app.models.inventory_item import InventoryItem
from app.models.inventory_item_image import InventoryItemImage
from app.models.ledger_entry import LedgerEntry
from app.models.master_product import MasterProduct
from app.models.purchase import Purchase, PurchaseLine
from app.models.sales import SalesOrderLine
from app.schemas.purchase import PurchaseCreate, PurchaseUpdate
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
        counterparty_birthdate=data.counterparty_birthdate,
        counterparty_id_number=data.counterparty_id_number,
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
        # Ensure PK is assigned before referencing it in audit logs.
        await session.flush()

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

    return purchase


async def update_purchase(
    session: AsyncSession,
    *,
    actor: str,
    purchase_id: uuid.UUID,
    data: PurchaseUpdate,
) -> Purchase:
    result = await session.execute(
        select(Purchase).where(Purchase.id == purchase_id).options(selectinload(Purchase.lines))
    )
    purchase = result.scalar_one_or_none()
    if purchase is None:
        raise ValueError("Purchase not found")
    if purchase.pdf_path:
        raise ValueError("Purchase is locked (PDF already generated)")

    if data.kind != purchase.kind:
        raise ValueError("Changing kind of an existing purchase is not supported")

    if sum(line.purchase_price_cents for line in data.lines) != data.total_amount_cents:
        raise ValueError("Sum(lines.purchase_price_cents) must equal total_amount_cents")

    expected_type = PurchaseType.DIFF if data.kind == PurchaseKind.PRIVATE_DIFF else PurchaseType.REGULAR
    if any(line.purchase_type != expected_type for line in data.lines):
        raise ValueError(f"All lines.purchase_type must be {expected_type} for {data.kind}")

    tax_rate_bp = 0 if data.kind == PurchaseKind.PRIVATE_DIFF else (data.tax_rate_bp or 0)

    before = {
        "purchase_date": purchase.purchase_date,
        "counterparty_name": purchase.counterparty_name,
        "total_amount_cents": purchase.total_amount_cents,
        "tax_rate_bp": purchase.tax_rate_bp,
        "payment_source": purchase.payment_source,
        "lines_count": len(purchase.lines),
    }

    existing_lines_by_id: dict[uuid.UUID, PurchaseLine] = {pl.id: pl for pl in purchase.lines}
    existing_ids = set(existing_lines_by_id.keys())
    payload_ids = {l.id for l in data.lines if l.id is not None}

    unknown_ids = payload_ids - existing_ids
    if unknown_ids:
        raise ValueError("Unknown purchase line id(s)")

    # Inventory items are 1:1 with purchase lines via InventoryItem.purchase_line_id.
    inv_rows = (
        await session.execute(
            select(InventoryItem).where(InventoryItem.purchase_line_id.in_(list(existing_ids)))
        )
    ).scalars().all()
    inv_by_purchase_line_id: dict[uuid.UUID, InventoryItem] = {r.purchase_line_id: r for r in inv_rows if r.purchase_line_id}

    # Deletions: allow removing lines only if the corresponding inventory item is still AVAILABLE
    # and not referenced by other business entities (sales, allocations, images).
    delete_ids = existing_ids - payload_ids
    for pl_id in delete_ids:
        inv = inv_by_purchase_line_id.get(pl_id)
        if inv is None:
            raise ValueError("Inventory item not found for purchase line")
        if inv.status != InventoryStatus.AVAILABLE:
            raise ValueError("Cannot remove a purchase line: inventory item is not AVAILABLE")

        so_count = (
            await session.scalar(
                select(func.count()).select_from(SalesOrderLine).where(SalesOrderLine.inventory_item_id == inv.id)
            )
        ) or 0
        if so_count:
            raise ValueError("Cannot remove a purchase line: inventory item is referenced by sales")

        alloc_count = (
            await session.scalar(
                select(func.count())
                .select_from(CostAllocationLine)
                .where(CostAllocationLine.inventory_item_id == inv.id)
            )
        ) or 0
        if alloc_count:
            raise ValueError("Cannot remove a purchase line: inventory item has allocated costs")

        img_count = (
            await session.scalar(
                select(func.count())
                .select_from(InventoryItemImage)
                .where(InventoryItemImage.inventory_item_id == inv.id)
            )
        ) or 0
        if img_count:
            raise ValueError("Cannot remove a purchase line: inventory item has images")

        await session.delete(inv)
        await audit_log(
            session,
            actor=actor,
            entity_type="inventory_item",
            entity_id=inv.id,
            action="delete",
            before={"status": inv.status, "purchase_line_id": str(inv.purchase_line_id)},
            after=None,
        )
        await session.delete(existing_lines_by_id[pl_id])

    # Recompute tax splits for the *new* payload.
    line_splits: list[tuple[int, int]] = []
    total_net = 0
    total_tax = 0
    for line in data.lines:
        net, tax = split_gross_to_net_and_tax(gross_cents=line.purchase_price_cents, tax_rate_bp=tax_rate_bp)
        line_splits.append((net, tax))
        total_net += net
        total_tax += tax

    purchase.purchase_date = data.purchase_date
    purchase.counterparty_name = data.counterparty_name
    purchase.counterparty_address = data.counterparty_address
    purchase.counterparty_birthdate = data.counterparty_birthdate
    purchase.counterparty_id_number = data.counterparty_id_number
    purchase.total_amount_cents = data.total_amount_cents
    purchase.total_net_cents = total_net
    purchase.total_tax_cents = total_tax
    purchase.tax_rate_bp = tax_rate_bp
    purchase.payment_source = data.payment_source
    purchase.external_invoice_number = data.external_invoice_number
    purchase.receipt_upload_path = data.receipt_upload_path

    # Upserts / inserts
    for line, (line_net, line_tax) in zip(data.lines, line_splits, strict=True):
        if line.id is not None:
            pl = existing_lines_by_id[line.id]
            pl.master_product_id = line.master_product_id
            pl.condition = line.condition
            pl.purchase_type = line.purchase_type
            pl.purchase_price_cents = line.purchase_price_cents
            pl.purchase_price_net_cents = line_net
            pl.purchase_price_tax_cents = line_tax
            pl.tax_rate_bp = tax_rate_bp

            inv = inv_by_purchase_line_id.get(pl.id)
            if inv is not None:
                inv.master_product_id = line.master_product_id
                inv.condition = line.condition
                inv.purchase_type = line.purchase_type
                inv.purchase_price_cents = line_net if line.purchase_type == PurchaseType.REGULAR else line.purchase_price_cents
                inv.acquired_date = data.purchase_date
        else:
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
            await session.flush()

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

    # Update ledger entry (create if missing).
    entry = (
        (await session.execute(
            select(LedgerEntry).where(LedgerEntry.entity_type == "purchase", LedgerEntry.entity_id == purchase.id)
        ))
        .scalars()
        .first()
    )
    if entry is None:
        entry = LedgerEntry(entity_type="purchase", entity_id=purchase.id, memo=None, entry_date=data.purchase_date, account=data.payment_source, amount_cents=0)
        session.add(entry)

    entry.entry_date = data.purchase_date
    entry.account = data.payment_source
    entry.amount_cents = -data.total_amount_cents
    entry.memo = f"{data.kind} {purchase.document_number or ''}".strip()

    await audit_log(
        session,
        actor=actor,
        entity_type="purchase",
        entity_id=purchase.id,
        action="update",
        before=before,
        after={
            "purchase_date": purchase.purchase_date,
            "counterparty_name": purchase.counterparty_name,
            "total_amount_cents": purchase.total_amount_cents,
            "tax_rate_bp": purchase.tax_rate_bp,
            "payment_source": purchase.payment_source,
            "lines_count": len(data.lines),
        },
    )

    return purchase


async def generate_purchase_credit_note_pdf(
    session: AsyncSession,
    *,
    actor: str,
    purchase_id: uuid.UUID,
) -> Purchase:
    """
    Generate the Eigenbeleg (credit note) PDF for a PRIVATE_DIFF purchase.

    This is intentionally separated from `create_purchase()` so purchases can be
    recorded first and the document can be generated manually once all data is ready.
    """
    purchase = await session.get(Purchase, purchase_id)
    if purchase is None:
        raise ValueError("Purchase not found")
    if purchase.kind != PurchaseKind.PRIVATE_DIFF:
        raise ValueError("Only PRIVATE_DIFF purchases have an Eigenbeleg PDF")

    if not purchase.document_number:
        purchase.document_number = await next_document_number(
            session, doc_type=DocumentType.PURCHASE_CREDIT_NOTE, issue_date=purchase.purchase_date
        )

    mp_rows = (
        await session.execute(
            select(
                PurchaseLine.id,
                PurchaseLine.condition,
                PurchaseLine.purchase_price_cents,
                InventoryItem.serial_number,
                MasterProduct.title,
                MasterProduct.platform,
                MasterProduct.region,
                MasterProduct.variant,
            )
            .select_from(PurchaseLine)
            .join(MasterProduct, MasterProduct.id == PurchaseLine.master_product_id)
            .outerjoin(InventoryItem, InventoryItem.purchase_line_id == PurchaseLine.id)
            .where(PurchaseLine.purchase_id == purchase.id)
            .order_by(PurchaseLine.id.asc())
        )
    ).all()

    lines_ctx = []
    for r in mp_rows:
        cond = r.condition.value
        condition_label = {
            "NEW": "Neu",
            "LIKE_NEW": "A-Ware (wie neu)",
            "GOOD": "B-Ware (gut)",
            "ACCEPTABLE": "C-Ware (Gebrauchsspuren)",
            "DEFECT": "Defekt",
        }.get(cond, cond)
        lines_ctx.append(
            {
                "title": r.title,
                "platform": r.platform,
                "region": r.region,
                "variant": r.variant,
                "condition": condition_label,
                "serial_number": r.serial_number,
                "purchase_price_eur": format_eur(r.purchase_price_cents),
            }
        )

    settings = get_settings()
    templates_dir = Path(__file__).resolve().parents[1] / "templates"
    rel_path = f"pdfs/credit-notes/{purchase.document_number}.pdf"
    out_path = settings.app_storage_dir / rel_path

    render_pdf(
        templates_dir=templates_dir,
        template_name="purchase_credit_note.html",
        context={
            "document_number": purchase.document_number,
            "purchase_date": purchase.purchase_date.strftime("%d.%m.%Y"),
            "company_name": settings.company_name,
            "company_address": settings.company_address,
            "company_email": settings.company_email,
            "company_vat_id": settings.company_vat_id,
            "company_logo_path": settings.company_logo_path,
            "company_small_business_notice": settings.company_small_business_notice,
            "counterparty_name": purchase.counterparty_name,
            "counterparty_address": purchase.counterparty_address,
            "counterparty_birthdate": purchase.counterparty_birthdate.strftime("%d.%m.%Y") if purchase.counterparty_birthdate else None,
            "counterparty_id_number": purchase.counterparty_id_number,
            "payment_source": {"CASH": "Bar", "BANK": "Bank"}.get(purchase.payment_source.value, purchase.payment_source.value),
            "lines": lines_ctx,
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
