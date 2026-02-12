from __future__ import annotations

import re
import uuid
import unicodedata
from pathlib import Path

from sqlalchemy import delete, func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
# Pillow is optional at runtime; without it we skip cropping/slicing evidence images.

from app.core.enums import DocumentType, InventoryStatus, MileagePurpose, PaymentSource, PurchaseKind, PurchaseType
from app.core.config import get_settings
from app.models.cost_allocation import CostAllocationLine
from app.models.inventory_item import InventoryItem
from app.models.inventory_item_image import InventoryItemImage
from app.models.ledger_entry import LedgerEntry
from app.models.master_product import MasterProduct
from app.models.mileage_log import MileageLog, _mileage_log_purchases
from app.models.purchase import Purchase, PurchaseLine
from app.models.purchase_attachment import PurchaseAttachment
from app.models.sales import SalesOrderLine
from app.schemas.purchase import PurchaseCreate, PurchaseUpdate
from app.schemas.purchase_mileage import PurchaseMileageUpsert
from app.services.audit import audit_log
from app.services.documents import next_document_number
from app.services.money import format_eur, mileage_amount_cents, meters_from_km, split_gross_to_net_and_tax
from app.services.pdf import render_pdf
from app.services.vat import allocate_proportional


def _validate_extra_purchase_costs(
    *,
    kind: PurchaseKind,
    shipping_cost_cents: int,
    buyer_protection_fee_cents: int,
) -> None:
    if shipping_cost_cents < 0:
        raise ValueError("shipping_cost_cents must be >= 0")
    if buyer_protection_fee_cents < 0:
        raise ValueError("buyer_protection_fee_cents must be >= 0")
    if kind in {PurchaseKind.COMMERCIAL_REGULAR, PurchaseKind.PRIVATE_EQUITY} and (
        shipping_cost_cents != 0 or buyer_protection_fee_cents != 0
    ):
        raise ValueError(
            f"shipping_cost_cents and buyer_protection_fee_cents must be 0 for {kind} purchases"
        )


def _total_paid_cents(
    *,
    total_amount_cents: int,
    shipping_cost_cents: int,
    buyer_protection_fee_cents: int,
) -> int:
    return int(total_amount_cents) + int(shipping_cost_cents) + int(buyer_protection_fee_cents)


def _optional_str(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _purchase_line_effective_price_cents(
    *,
    kind: PurchaseKind,
    purchase_price_cents: int | None,
    market_value_cents: int | None,
) -> int:
    if purchase_price_cents is not None:
        return int(purchase_price_cents)
    if kind == PurchaseKind.PRIVATE_EQUITY:
        if market_value_cents is None:
            raise ValueError("market_value_cents is required for PRIVATE_EQUITY purchase lines")
        return int((int(market_value_cents) * 85) // 100)
    raise ValueError("purchase_price_cents is required")


CANONICAL_SOURCE_PLATFORMS = [
    "Kleinanzeigen",
    "eBay",
    "willhaben.at",
    "Laendleanzeiger.at",
]

_SOURCE_PLATFORM_ALIAS_TO_CANONICAL: dict[str, str] = {
    "kleinanzeigen": "Kleinanzeigen",
    "kleinanzeigende": "Kleinanzeigen",
    "ebaykleinanzeigen": "Kleinanzeigen",
    "ebay": "eBay",
    "ebayde": "eBay",
    "willhaben": "willhaben.at",
    "willhabenat": "willhaben.at",
    "laendleanzeiger": "Laendleanzeiger.at",
    "laendleanzeigerat": "Laendleanzeiger.at",
    "landleanzeiger": "Laendleanzeiger.at",
    "landleanzeigerat": "Laendleanzeiger.at",
}


def _source_platform_key(value: str) -> str:
    folded = (
        unicodedata.normalize("NFKD", value)
        .encode("ascii", "ignore")
        .decode("ascii")
        .strip()
        .lower()
    )
    return re.sub(r"[^a-z0-9]+", "", folded)


def normalize_source_platform_label(value: str | None) -> str | None:
    normalized = _optional_str(value)
    if normalized is None:
        return None
    return _SOURCE_PLATFORM_ALIAS_TO_CANONICAL.get(_source_platform_key(normalized), normalized)


def _slice_image_for_pdf(*, src_path: Path, out_dir: Path, stem: str) -> list[Path]:
    """
    Create page-friendly slices for very tall screenshots so they can be rendered
    at full width (readable) without shrinking to fit a single page.
    """
    try:
        from PIL import Image, ImageChops  # type: ignore
    except Exception:
        return [src_path]

    # These are CSS px, aligned with WeasyPrint's 96dpi CSS pixel model.
    target_width_px = 680
    max_scaled_height_px = 900

    orig = Image.open(src_path)
    try:
        orig.load()
        if orig.width <= 0 or orig.height <= 0:
            return [src_path]

        # Flatten transparency to white and auto-crop uniform background (common for long mobile screenshots).
        work = orig
        if work.mode in ("RGBA", "LA") or (work.mode == "P" and "transparency" in work.info):
            bg = Image.new("RGBA", work.size, (255, 255, 255, 255))
            bg.alpha_composite(work.convert("RGBA"))
            work = bg.convert("RGB")
        elif work.mode != "RGB":
            work = work.convert("RGB")

        w, h = work.size
        corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
        corner_colors = [work.getpixel(pt) for pt in corners]
        bg_color = max(set(corner_colors), key=corner_colors.count)
        bg_img = Image.new("RGB", work.size, bg_color)
        diff = ImageChops.difference(work, bg_img).convert("L")
        diff = diff.point(lambda p: 255 if p > 10 else 0)
        bbox = diff.getbbox()
        if bbox:
            # Avoid pathological crops when the whole image differs from the chosen background.
            left, top, right, bottom = bbox
            if (right - left) * (bottom - top) < int(w * h * 0.98):
                pad = 2
                left = max(0, left - pad)
                top = max(0, top - pad)
                right = min(w, right + pad)
                bottom = min(h, bottom + pad)
                work = work.crop((left, top, right, bottom))

        # Always continue with the processed RGB image (cropped and/or flattened),
        # otherwise later sampling may fail on RGBA images.
        img = work

        scaled_height_px = img.height * (target_width_px / img.width)
        if scaled_height_px <= max_scaled_height_px:
            return [src_path]

        slice_height_px = max(1, int(max_scaled_height_px * (img.width / target_width_px)))
        out_dir.mkdir(parents=True, exist_ok=True)

        out_paths: list[Path] = []
        part = 1
        for top in range(0, img.height, slice_height_px):
            bottom = min(img.height, top + slice_height_px)
            crop = img.crop((0, top, img.width, bottom))
            # Skip slices that are almost entirely background (prevents "blank" evidence pages).
            cw, ch = crop.size
            if cw > 0 and ch > 0:
                sample = 24
                tol = 10
                hits = 0
                total = 0
                for sy in range(sample):
                    py = min(ch - 1, int((sy + 0.5) * ch / sample))
                    for sx in range(sample):
                        px = min(cw - 1, int((sx + 0.5) * cw / sample))
                        r, g, b = crop.getpixel((px, py))
                        br, bgc, bb = bg_color
                        if abs(r - br) <= tol and abs(g - bgc) <= tol and abs(b - bb) <= tol:
                            hits += 1
                        total += 1
                if total and (hits / total) >= 0.985:
                    continue
            out_path = out_dir / f"{stem}-part{part:02d}.png"
            crop.save(out_path, format="PNG", optimize=True)
            out_paths.append(out_path)
            part += 1
        return out_paths or [src_path]
    finally:
        try:
            # Close the original ImageFile to release the underlying file handle.
            orig.close()
        except Exception:
            pass


async def create_purchase(session: AsyncSession, *, actor: str, data: PurchaseCreate) -> Purchase:
    settings = get_settings()
    vat_enabled = settings.vat_enabled
    effective_line_prices = [
        _purchase_line_effective_price_cents(
            kind=data.kind,
            purchase_price_cents=line.purchase_price_cents,
            market_value_cents=line.market_value_cents,
        )
        for line in data.lines
    ]

    if sum(effective_line_prices) != data.total_amount_cents:
        raise ValueError("Sum(lines.purchase_price_cents) must equal total_amount_cents")
    _validate_extra_purchase_costs(
        kind=data.kind,
        shipping_cost_cents=data.shipping_cost_cents,
        buyer_protection_fee_cents=data.buyer_protection_fee_cents,
    )

    expected_type = (
        PurchaseType.DIFF if data.kind in {PurchaseKind.PRIVATE_DIFF, PurchaseKind.PRIVATE_EQUITY} else PurchaseType.REGULAR
    )
    if any(line.purchase_type != expected_type for line in data.lines):
        raise ValueError(f"All lines.purchase_type must be {expected_type} for {data.kind}")

    tax_rate_bp = 0 if data.kind in {PurchaseKind.PRIVATE_DIFF, PurchaseKind.PRIVATE_EQUITY} else int(data.tax_rate_bp or 0)
    if not vat_enabled:
        tax_rate_bp = 0
    elif data.kind == PurchaseKind.COMMERCIAL_REGULAR and tax_rate_bp <= 0:
        raise ValueError("tax_rate_bp must be > 0 for COMMERCIAL_REGULAR purchases when VAT is enabled")

    line_splits: list[tuple[int, int]] = []
    total_net = 0
    total_tax = 0
    for line, line_price_cents in zip(data.lines, effective_line_prices, strict=True):
        net, tax = split_gross_to_net_and_tax(gross_cents=line_price_cents, tax_rate_bp=tax_rate_bp)
        line_splits.append((net, tax))
        total_net += net
        total_tax += tax

    document_number: str | None = None
    if data.kind == PurchaseKind.PRIVATE_DIFF:
        document_number = await next_document_number(
            session, doc_type=DocumentType.PURCHASE_CREDIT_NOTE, issue_date=data.purchase_date
        )
    elif data.kind == PurchaseKind.PRIVATE_EQUITY:
        document_number = await next_document_number(
            session, doc_type=DocumentType.PRIVATE_EQUITY_NOTE, issue_date=data.purchase_date
        )

    purchase = Purchase(
        kind=data.kind,
        purchase_date=data.purchase_date,
        counterparty_name=data.counterparty_name,
        counterparty_address=data.counterparty_address,
        counterparty_birthdate=data.counterparty_birthdate,
        counterparty_id_number=data.counterparty_id_number,
        total_amount_cents=data.total_amount_cents,
        shipping_cost_cents=data.shipping_cost_cents,
        buyer_protection_fee_cents=data.buyer_protection_fee_cents,
        total_net_cents=total_net,
        total_tax_cents=total_tax,
        tax_rate_bp=tax_rate_bp,
        payment_source=PaymentSource.PRIVATE_EQUITY if data.kind == PurchaseKind.PRIVATE_EQUITY else data.payment_source,
        source_platform=normalize_source_platform_label(data.source_platform),
        listing_url=_optional_str(data.listing_url),
        notes=_optional_str(data.notes),
        document_number=document_number,
        external_invoice_number=data.external_invoice_number,
        receipt_upload_path=data.receipt_upload_path,
    )
    session.add(purchase)
    await session.flush()

    created_line_items: list[tuple[PurchaseLine, InventoryItem, int]] = []
    for line, line_price_cents, (line_net, line_tax) in zip(data.lines, effective_line_prices, line_splits, strict=True):
        pl = PurchaseLine(
            purchase_id=purchase.id,
            master_product_id=line.master_product_id,
            condition=line.condition,
            purchase_type=line.purchase_type,
            purchase_price_cents=line_price_cents,
            shipping_allocated_cents=0,
            buyer_protection_fee_allocated_cents=0,
            purchase_price_net_cents=line_net,
            purchase_price_tax_cents=line_tax,
            tax_rate_bp=tax_rate_bp,
            market_value_cents=line.market_value_cents,
            held_privately_over_12_months=line.held_privately_over_12_months,
            valuation_reason=_optional_str(line.valuation_reason),
        )
        session.add(pl)
        await session.flush()

        inventory_cost_cents = line_net if line.purchase_type == PurchaseType.REGULAR else line_price_cents
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
        created_line_items.append((pl, item, int(line_price_cents)))

    weights = [weight for _, _, weight in created_line_items]
    shipping_allocations = allocate_proportional(total_cents=data.shipping_cost_cents, weights=weights)
    buyer_protection_fee_allocations = allocate_proportional(
        total_cents=data.buyer_protection_fee_cents,
        weights=weights,
    )
    for (line, item, _), shipping_alloc, buyer_fee_alloc in zip(
        created_line_items,
        shipping_allocations,
        buyer_protection_fee_allocations,
        strict=True,
    ):
        line.shipping_allocated_cents = int(shipping_alloc)
        line.buyer_protection_fee_allocated_cents = int(buyer_fee_alloc)
        allocation_delta = int(shipping_alloc) + int(buyer_fee_alloc)
        if allocation_delta != 0:
            before = {"allocated_costs_cents": item.allocated_costs_cents}
            item.allocated_costs_cents += allocation_delta
            await audit_log(
                session,
                actor=actor,
                entity_type="inventory_item",
                entity_id=item.id,
                action="allocate_purchase_cost",
                before=before,
                after={
                    "allocated_costs_cents": item.allocated_costs_cents,
                    "shipping_allocated_cents": int(shipping_alloc),
                    "buyer_protection_fee_allocated_cents": int(buyer_fee_alloc),
                },
            )

    if data.kind != PurchaseKind.PRIVATE_EQUITY:
        session.add(
            LedgerEntry(
                entry_date=data.purchase_date,
                account=data.payment_source,
                amount_cents=-_total_paid_cents(
                    total_amount_cents=data.total_amount_cents,
                    shipping_cost_cents=data.shipping_cost_cents,
                    buyer_protection_fee_cents=data.buyer_protection_fee_cents,
                ),
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
            "shipping_cost_cents": purchase.shipping_cost_cents,
            "buyer_protection_fee_cents": purchase.buyer_protection_fee_cents,
            "total_net_cents": purchase.total_net_cents,
            "total_tax_cents": purchase.total_tax_cents,
            "tax_rate_bp": purchase.tax_rate_bp,
            "payment_source": purchase.payment_source,
            "source_platform": purchase.source_platform,
            "listing_url": purchase.listing_url,
            "notes": purchase.notes,
            "document_number": purchase.document_number,
            "external_invoice_number": purchase.external_invoice_number,
            "line_valuations": [
                {
                    "purchase_line_id": str(pl.id),
                    "market_value_cents": pl.market_value_cents,
                    "held_privately_over_12_months": pl.held_privately_over_12_months,
                    "valuation_reason": pl.valuation_reason,
                }
                for pl, _item, _weight in created_line_items
            ],
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

    effective_line_prices = [
        _purchase_line_effective_price_cents(
            kind=data.kind,
            purchase_price_cents=line.purchase_price_cents,
            market_value_cents=line.market_value_cents,
        )
        for line in data.lines
    ]

    if sum(effective_line_prices) != data.total_amount_cents:
        raise ValueError("Sum(lines.purchase_price_cents) must equal total_amount_cents")
    _validate_extra_purchase_costs(
        kind=data.kind,
        shipping_cost_cents=data.shipping_cost_cents,
        buyer_protection_fee_cents=data.buyer_protection_fee_cents,
    )

    expected_type = (
        PurchaseType.DIFF if data.kind in {PurchaseKind.PRIVATE_DIFF, PurchaseKind.PRIVATE_EQUITY} else PurchaseType.REGULAR
    )
    if any(line.purchase_type != expected_type for line in data.lines):
        raise ValueError(f"All lines.purchase_type must be {expected_type} for {data.kind}")

    settings = get_settings()
    vat_enabled = settings.vat_enabled
    tax_rate_bp = 0 if data.kind in {PurchaseKind.PRIVATE_DIFF, PurchaseKind.PRIVATE_EQUITY} else int(data.tax_rate_bp or 0)
    if not vat_enabled:
        tax_rate_bp = 0
    elif data.kind == PurchaseKind.COMMERCIAL_REGULAR and tax_rate_bp <= 0:
        raise ValueError("tax_rate_bp must be > 0 for COMMERCIAL_REGULAR purchases when VAT is enabled")

    before = {
        "purchase_date": purchase.purchase_date,
        "counterparty_name": purchase.counterparty_name,
        "total_amount_cents": purchase.total_amount_cents,
        "shipping_cost_cents": purchase.shipping_cost_cents,
        "buyer_protection_fee_cents": purchase.buyer_protection_fee_cents,
        "tax_rate_bp": purchase.tax_rate_bp,
        "payment_source": purchase.payment_source,
        "source_platform": purchase.source_platform,
        "listing_url": purchase.listing_url,
        "notes": purchase.notes,
        "lines_count": len(purchase.lines),
    }

    existing_lines_by_id: dict[uuid.UUID, PurchaseLine] = {pl.id: pl for pl in purchase.lines}
    old_allocated_costs_by_line_id: dict[uuid.UUID, int] = {
        pl.id: int(pl.shipping_allocated_cents) + int(pl.buyer_protection_fee_allocated_cents)
        for pl in purchase.lines
    }
    existing_ids = set(existing_lines_by_id.keys())
    payload_ids = {line.id for line in data.lines if line.id is not None}

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
    for line_price_cents in effective_line_prices:
        net, tax = split_gross_to_net_and_tax(gross_cents=line_price_cents, tax_rate_bp=tax_rate_bp)
        line_splits.append((net, tax))
        total_net += net
        total_tax += tax

    purchase.purchase_date = data.purchase_date
    purchase.counterparty_name = data.counterparty_name
    purchase.counterparty_address = data.counterparty_address
    purchase.counterparty_birthdate = data.counterparty_birthdate
    purchase.counterparty_id_number = data.counterparty_id_number
    purchase.total_amount_cents = data.total_amount_cents
    purchase.shipping_cost_cents = data.shipping_cost_cents
    purchase.buyer_protection_fee_cents = data.buyer_protection_fee_cents
    purchase.total_net_cents = total_net
    purchase.total_tax_cents = total_tax
    purchase.tax_rate_bp = tax_rate_bp
    purchase.payment_source = PaymentSource.PRIVATE_EQUITY if data.kind == PurchaseKind.PRIVATE_EQUITY else data.payment_source
    purchase.source_platform = normalize_source_platform_label(data.source_platform)
    purchase.listing_url = _optional_str(data.listing_url)
    purchase.notes = _optional_str(data.notes)
    purchase.external_invoice_number = data.external_invoice_number
    purchase.receipt_upload_path = data.receipt_upload_path

    # Upserts / inserts
    for line, line_price_cents, (line_net, line_tax) in zip(data.lines, effective_line_prices, line_splits, strict=True):
        if line.id is not None:
            pl = existing_lines_by_id[line.id]
            pl.master_product_id = line.master_product_id
            pl.condition = line.condition
            pl.purchase_type = line.purchase_type
            pl.purchase_price_cents = line_price_cents
            pl.purchase_price_net_cents = line_net
            pl.purchase_price_tax_cents = line_tax
            pl.tax_rate_bp = tax_rate_bp
            pl.market_value_cents = line.market_value_cents
            pl.held_privately_over_12_months = line.held_privately_over_12_months
            pl.valuation_reason = _optional_str(line.valuation_reason)

            inv = inv_by_purchase_line_id.get(pl.id)
            if inv is not None:
                inv.master_product_id = line.master_product_id
                inv.condition = line.condition
                inv.purchase_type = line.purchase_type
                inv.purchase_price_cents = line_net if line.purchase_type == PurchaseType.REGULAR else line_price_cents
                inv.acquired_date = data.purchase_date
        else:
            pl = PurchaseLine(
                purchase_id=purchase.id,
                master_product_id=line.master_product_id,
                condition=line.condition,
                purchase_type=line.purchase_type,
                purchase_price_cents=line_price_cents,
                shipping_allocated_cents=0,
                buyer_protection_fee_allocated_cents=0,
                purchase_price_net_cents=line_net,
                purchase_price_tax_cents=line_tax,
                tax_rate_bp=tax_rate_bp,
                market_value_cents=line.market_value_cents,
                held_privately_over_12_months=line.held_privately_over_12_months,
                valuation_reason=_optional_str(line.valuation_reason),
            )
            session.add(pl)
            await session.flush()

            inventory_cost_cents = line_net if line.purchase_type == PurchaseType.REGULAR else line_price_cents
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
            inv_by_purchase_line_id[pl.id] = item

    current_lines = (
        await session.execute(
            select(PurchaseLine).where(PurchaseLine.purchase_id == purchase.id).order_by(PurchaseLine.id.asc())
        )
    ).scalars().all()
    if not current_lines:
        raise ValueError("Purchase must have at least one line")

    weights = [int(line.purchase_price_cents) for line in current_lines]
    shipping_allocations = allocate_proportional(total_cents=purchase.shipping_cost_cents, weights=weights)
    buyer_protection_fee_allocations = allocate_proportional(
        total_cents=purchase.buyer_protection_fee_cents,
        weights=weights,
    )

    for line, shipping_alloc, buyer_fee_alloc in zip(
        current_lines,
        shipping_allocations,
        buyer_protection_fee_allocations,
        strict=True,
    ):
        line.shipping_allocated_cents = int(shipping_alloc)
        line.buyer_protection_fee_allocated_cents = int(buyer_fee_alloc)
        new_allocated_cost = int(shipping_alloc) + int(buyer_fee_alloc)
        old_allocated_cost = old_allocated_costs_by_line_id.get(line.id, 0)
        allocation_delta = new_allocated_cost - old_allocated_cost
        if allocation_delta == 0:
            continue

        item = inv_by_purchase_line_id.get(line.id)
        if item is None:
            item = (
                await session.execute(
                    select(InventoryItem).where(InventoryItem.purchase_line_id == line.id)
                )
            ).scalar_one_or_none()
            if item is None:
                raise ValueError("Inventory item not found for purchase line")
            inv_by_purchase_line_id[line.id] = item

        before = {"allocated_costs_cents": item.allocated_costs_cents}
        updated_allocated_costs = int(item.allocated_costs_cents) + allocation_delta
        if updated_allocated_costs < 0:
            raise ValueError("Cannot reduce allocated costs below zero for inventory item")
        item.allocated_costs_cents = updated_allocated_costs
        await audit_log(
            session,
            actor=actor,
            entity_type="inventory_item",
            entity_id=item.id,
            action="allocate_purchase_cost",
            before=before,
            after={
                "allocated_costs_cents": item.allocated_costs_cents,
                "shipping_allocated_cents": int(shipping_alloc),
                "buyer_protection_fee_allocated_cents": int(buyer_fee_alloc),
                "allocation_delta_cents": allocation_delta,
            },
        )

    # Update ledger entry (create if missing), except for PRIVATE_EQUITY cash-neutral entries.
    entry = (
        (await session.execute(
            select(LedgerEntry).where(LedgerEntry.entity_type == "purchase", LedgerEntry.entity_id == purchase.id)
        ))
        .scalars()
        .first()
    )
    if data.kind == PurchaseKind.PRIVATE_EQUITY:
        if entry is not None:
            await session.delete(entry)
    else:
        if entry is None:
            entry = LedgerEntry(
                entity_type="purchase",
                entity_id=purchase.id,
                memo=None,
                entry_date=data.purchase_date,
                account=data.payment_source,
                amount_cents=0,
            )
            session.add(entry)

        entry.entry_date = data.purchase_date
        entry.account = data.payment_source
        entry.amount_cents = -_total_paid_cents(
            total_amount_cents=data.total_amount_cents,
            shipping_cost_cents=data.shipping_cost_cents,
            buyer_protection_fee_cents=data.buyer_protection_fee_cents,
        )
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
            "shipping_cost_cents": purchase.shipping_cost_cents,
            "buyer_protection_fee_cents": purchase.buyer_protection_fee_cents,
            "tax_rate_bp": purchase.tax_rate_bp,
            "payment_source": purchase.payment_source,
            "source_platform": purchase.source_platform,
            "listing_url": purchase.listing_url,
            "notes": purchase.notes,
            "lines_count": len(data.lines),
            "line_valuations": [
                {
                    "purchase_line_id": str(pl.id),
                    "market_value_cents": pl.market_value_cents,
                    "held_privately_over_12_months": pl.held_privately_over_12_months,
                    "valuation_reason": pl.valuation_reason,
                }
                for pl in purchase.lines
            ],
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
    Generate the Eigenbeleg PDF for a PRIVATE_DIFF or PRIVATE_EQUITY purchase.

    This is intentionally separated from `create_purchase()` so purchases can be
    recorded first and the document can be generated manually once all data is ready.
    """
    purchase = await session.get(Purchase, purchase_id)
    if purchase is None:
        raise ValueError("Purchase not found")
    if purchase.kind not in {PurchaseKind.PRIVATE_DIFF, PurchaseKind.PRIVATE_EQUITY}:
        raise ValueError("Only PRIVATE_DIFF and PRIVATE_EQUITY purchases have an Eigenbeleg PDF")

    if not purchase.document_number:
        doc_type = (
            DocumentType.PRIVATE_EQUITY_NOTE
            if purchase.kind == PurchaseKind.PRIVATE_EQUITY
            else DocumentType.PURCHASE_CREDIT_NOTE
        )
        purchase.document_number = await next_document_number(
            session, doc_type=doc_type, issue_date=purchase.purchase_date
        )

    mp_rows = (
        await session.execute(
            select(
                PurchaseLine.id,
                PurchaseLine.condition,
                PurchaseLine.purchase_price_cents,
                PurchaseLine.market_value_cents,
                PurchaseLine.held_privately_over_12_months,
                PurchaseLine.valuation_reason,
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
                "market_value_eur": format_eur(r.market_value_cents) if r.market_value_cents is not None else None,
                "held_privately_over_12_months": r.held_privately_over_12_months,
                "valuation_reason": _optional_str(r.valuation_reason),
                "purchase_line_id": str(r.id),
            }
        )

    market_comp_count_by_line_id: dict[str, int] = {}
    attachment_rows = (
        await session.execute(
            select(
                PurchaseAttachment.id,
                PurchaseAttachment.purchase_line_id,
                PurchaseAttachment.kind,
                PurchaseAttachment.original_filename,
                PurchaseAttachment.note,
                PurchaseAttachment.upload_path,
                PurchaseAttachment.created_at,
            )
            .where(PurchaseAttachment.purchase_id == purchase.id)
            .order_by(PurchaseAttachment.created_at.asc())
        )
    ).all()
    attachment_kind_labels = {
        "LISTING": "Anzeige",
        "MARKET_COMP": "Marktvergleich",
        "CHAT": "Konversation",
        "PAYMENT": "Zahlung",
        "DELIVERY": "Versand",
        "OTHER": "Sonstiges",
    }
    settings = get_settings()
    storage_dir = settings.app_storage_dir.resolve()
    image_exts = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    attachments_ctx = []
    attachment_images_ctx = []
    tmp_dir = storage_dir / "tmp" / "pdf-evidence" / str(purchase.id)
    tmp_paths: list[Path] = []
    for r in attachment_rows:
        upload_path = str(r.upload_path or "").strip().lstrip("/")
        abs_path = (storage_dir / upload_path).resolve()
        file_uri = None
        try:
            abs_path.relative_to(storage_dir)
            file_uri = abs_path.as_uri() if upload_path.startswith("uploads/") else None
        except ValueError:
            file_uri = None

        ext = Path(upload_path).suffix.lower()
        is_image = ext in image_exts
        attachments_ctx.append(
            {
                "id": str(r.id),
                "purchase_line_id": str(r.purchase_line_id) if r.purchase_line_id else None,
                "kind": r.kind,
                "kind_label": attachment_kind_labels.get(str(r.kind).upper(), str(r.kind)),
                "original_filename": r.original_filename,
                "note": r.note,
                "upload_path": upload_path,
                "created_at": r.created_at.strftime("%d.%m.%Y %H:%M") if getattr(r, "created_at", None) else None,
                "is_image": is_image,
                "file_uri": file_uri,
            }
        )
        if str(r.kind).upper() == "MARKET_COMP" and r.purchase_line_id is not None:
            key = str(r.purchase_line_id)
            market_comp_count_by_line_id[key] = market_comp_count_by_line_id.get(key, 0) + 1
        if is_image and file_uri and abs_path.exists():
            stem = f"{r.id}"
            slice_paths = _slice_image_for_pdf(src_path=abs_path, out_dir=tmp_dir, stem=stem)
            for idx, p in enumerate(slice_paths, start=1):
                if p != abs_path:
                    tmp_paths.append(p)
                attachment_images_ctx.append(
                    {
                        "kind_label": attachment_kind_labels.get(str(r.kind).upper(), str(r.kind)),
                        "original_filename": r.original_filename,
                        "note": r.note,
                        "part_label": f"Teil {idx}/{len(slice_paths)}" if len(slice_paths) > 1 else None,
                        "file_uri": p.as_uri(),
                    }
                )

    compliance_warnings: list[str] = []
    if purchase.kind == PurchaseKind.PRIVATE_EQUITY:
        for line in lines_ctx:
            line_id = str(line["purchase_line_id"])
            comp_count = market_comp_count_by_line_id.get(line_id, 0)
            if comp_count < 3:
                compliance_warnings.append(
                    f"Position '{line['title']}': nur {comp_count} Marktvergleich(e) (empfohlen: mindestens 3)."
                )
            if line.get("held_privately_over_12_months") is not True:
                compliance_warnings.append(
                    f"Position '{line['title']}': 12-Monats-Privatbesitz ist nicht bestaetigt."
                )

    templates_dir = Path(__file__).resolve().parents[1] / "templates"
    rel_path = f"pdfs/credit-notes/{purchase.document_number}.pdf"
    out_path = settings.app_storage_dir / rel_path

    try:
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
                "source_platform": purchase.source_platform,
                "listing_url": purchase.listing_url,
                "purchase_notes": purchase.notes,
                "purchase_attachments": attachments_ctx,
                "purchase_attachment_images": attachment_images_ctx,
                "lines": lines_ctx,
                "total_amount_eur": format_eur(purchase.total_amount_cents),
                "is_private_equity": purchase.kind == PurchaseKind.PRIVATE_EQUITY,
                "compliance_warnings": compliance_warnings,
            },
            output_path=out_path,
            css_paths=[templates_dir / "base.css"],
        )
    finally:
        for p in tmp_paths:
            try:
                if p.exists():
                    p.unlink()
            except Exception:
                pass

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


async def reopen_purchase_for_edit(
    session: AsyncSession,
    *,
    actor: str,
    purchase_id: uuid.UUID,
) -> Purchase:
    purchase = await session.get(Purchase, purchase_id)
    if purchase is None:
        raise ValueError("Purchase not found")
    if not purchase.pdf_path:
        raise ValueError("Purchase is already editable")

    old_pdf_path = str(purchase.pdf_path)
    settings = get_settings()
    abs_pdf_path = settings.app_storage_dir / old_pdf_path
    if abs_pdf_path.exists():
        abs_pdf_path.unlink()

    purchase.pdf_path = None

    await audit_log(
        session,
        actor=actor,
        entity_type="purchase",
        entity_id=purchase.id,
        action="reopen_for_edit",
        before={"pdf_path": old_pdf_path, "document_number": purchase.document_number},
        after={"pdf_path": purchase.pdf_path, "document_number": purchase.document_number},
    )
    return purchase


async def get_purchase_primary_mileage(
    session: AsyncSession,
    *,
    purchase_id: uuid.UUID,
) -> MileageLog | None:
    purchase = await session.get(Purchase, purchase_id)
    if purchase is None:
        raise ValueError("Purchase not found")
    if purchase.primary_mileage_log_id is None:
        return None
    return (
        await session.execute(
            select(MileageLog)
            .where(MileageLog.id == purchase.primary_mileage_log_id)
            .options(selectinload(MileageLog.purchases))
        )
    ).scalar_one_or_none()


async def upsert_purchase_primary_mileage(
    session: AsyncSession,
    *,
    actor: str,
    purchase_id: uuid.UUID,
    data: PurchaseMileageUpsert,
    rate_cents_per_km: int,
) -> MileageLog:
    purchase = await session.get(Purchase, purchase_id)
    if purchase is None:
        raise ValueError("Purchase not found")

    distance_meters = meters_from_km(data.km)
    amount_cents = mileage_amount_cents(distance_meters=distance_meters, rate_cents_per_km=rate_cents_per_km)

    mileage_log: MileageLog | None = None
    action = "create"
    if purchase.primary_mileage_log_id is not None:
        mileage_log = (
            await session.execute(
                select(MileageLog)
                .where(MileageLog.id == purchase.primary_mileage_log_id)
                .options(selectinload(MileageLog.purchases))
            )
        ).scalar_one_or_none()
        action = "update"

    if mileage_log is None:
        mileage_log = MileageLog(
            log_date=data.log_date,
            start_location=data.start_location,
            destination=data.destination,
            purpose=MileagePurpose.BUYING,
            purpose_text=_optional_str(data.purpose_text),
            distance_meters=distance_meters,
            rate_cents_per_km=rate_cents_per_km,
            amount_cents=amount_cents,
            purchase_id=purchase.id,
        )
        session.add(mileage_log)
        await session.flush()
    else:
        mileage_log.log_date = data.log_date
        mileage_log.start_location = data.start_location
        mileage_log.destination = data.destination
        mileage_log.purpose = MileagePurpose.BUYING
        mileage_log.purpose_text = _optional_str(data.purpose_text)
        mileage_log.distance_meters = distance_meters
        mileage_log.rate_cents_per_km = rate_cents_per_km
        mileage_log.amount_cents = amount_cents
        mileage_log.purchase_id = purchase.id

    await session.execute(
        delete(_mileage_log_purchases).where(_mileage_log_purchases.c.mileage_log_id == mileage_log.id)
    )
    await session.execute(
        insert(_mileage_log_purchases),
        [{"mileage_log_id": mileage_log.id, "purchase_id": purchase.id}],
    )

    purchase.primary_mileage_log_id = mileage_log.id
    await session.flush()

    await audit_log(
        session,
        actor=actor,
        entity_type="purchase",
        entity_id=purchase.id,
        action="upsert_primary_mileage",
        after={
            "primary_mileage_log_id": str(mileage_log.id),
            "mileage_action": action,
            "distance_meters": mileage_log.distance_meters,
            "amount_cents": mileage_log.amount_cents,
        },
    )
    await audit_log(
        session,
        actor=actor,
        entity_type="mileage",
        entity_id=mileage_log.id,
        action=action,
        after={
            "purchase_id": str(purchase.id),
            "distance_meters": mileage_log.distance_meters,
            "amount_cents": mileage_log.amount_cents,
            "purpose": mileage_log.purpose,
            "purpose_text": mileage_log.purpose_text,
        },
    )

    return (
        await session.execute(
            select(MileageLog).where(MileageLog.id == mileage_log.id).options(selectinload(MileageLog.purchases))
        )
    ).scalar_one()


async def delete_purchase_primary_mileage(
    session: AsyncSession,
    *,
    actor: str,
    purchase_id: uuid.UUID,
) -> None:
    purchase = await session.get(Purchase, purchase_id)
    if purchase is None:
        raise ValueError("Purchase not found")

    mileage_log_id = purchase.primary_mileage_log_id
    purchase.primary_mileage_log_id = None
    if mileage_log_id is None:
        return

    mileage_log = await session.get(MileageLog, mileage_log_id)
    if mileage_log is not None:
        await session.delete(mileage_log)

    await audit_log(
        session,
        actor=actor,
        entity_type="purchase",
        entity_id=purchase.id,
        action="delete_primary_mileage",
        before={"primary_mileage_log_id": str(mileage_log_id)},
        after={"primary_mileage_log_id": None},
    )
