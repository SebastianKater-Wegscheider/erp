from __future__ import annotations

import csv
import io
import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.enums import MasterProductKind
from app.models.amazon_scrape import AmazonProductMetricsLatest
from app.models.inventory_item import InventoryItem
from app.models.master_product import MasterProduct, master_product_sku_from_id
from app.models.purchase import PurchaseLine
from app.schemas.master_product import (
    MasterProductBulkImportIn,
    MasterProductBulkImportOut,
    MasterProductBulkImportRowError,
    MasterProductCreate,
    MasterProductOut,
    MasterProductOutWithAmazon,
    MasterProductUpdate,
)


router = APIRouter()

_CSV_HEADER_ALIASES: dict[str, str] = {
    "kind": "kind",
    "typ": "kind",
    "type": "kind",
    "kategorie": "kind",
    "art": "kind",
    "title": "title",
    "titel": "title",
    "name": "title",
    "produkt": "title",
    "produktname": "title",
    "platform": "platform",
    "plattform": "platform",
    "system": "platform",
    "region": "region",
    "markt": "region",
    "variant": "variant",
    "variante": "variant",
    "edition": "variant",
    "version": "variant",
    "ean": "ean",
    "gtin": "ean",
    "barcode": "ean",
    "asin": "asin",
    "manufacturer": "manufacturer",
    "hersteller": "manufacturer",
    "brand": "manufacturer",
    "model": "model",
    "modell": "model",
    "genre": "genre",
    "release_year": "release_year",
    "releaseyear": "release_year",
    "release_jahr": "release_year",
    "jahr": "release_year",
    "year": "release_year",
    "reference_image_url": "reference_image_url",
    "image_url": "reference_image_url",
    "bild_url": "reference_image_url",
    "reference_image": "reference_image_url",
    "referenzbild_url": "reference_image_url",
}
_KIND_ALIASES: dict[str, MasterProductKind] = {
    "game": MasterProductKind.GAME,
    "spiel": MasterProductKind.GAME,
    "console": MasterProductKind.CONSOLE,
    "konsole": MasterProductKind.CONSOLE,
    "accessory": MasterProductKind.ACCESSORY,
    "accessories": MasterProductKind.ACCESSORY,
    "zubehoer": MasterProductKind.ACCESSORY,
    "zubehör": MasterProductKind.ACCESSORY,
    "other": MasterProductKind.OTHER,
    "sonstiges": MasterProductKind.OTHER,
}


def _ascii_fold(value: str) -> str:
    return (
        value.replace("Ä", "Ae")
        .replace("Ö", "Oe")
        .replace("Ü", "Ue")
        .replace("ä", "ae")
        .replace("ö", "oe")
        .replace("ü", "ue")
        .replace("ß", "ss")
    )


def _normalize_header(value: str) -> str:
    folded = _ascii_fold(value.strip().lower())
    return re.sub(r"[^a-z0-9]+", "_", folded).strip("_")


def _normalize_kind(value: str) -> MasterProductKind:
    raw = value.strip()
    if not raw:
        return MasterProductKind.GAME
    folded = _ascii_fold(raw.lower())
    if folded in _KIND_ALIASES:
        return _KIND_ALIASES[folded]
    try:
        return MasterProductKind(raw.upper())
    except ValueError:
        raise ValueError(f"Unbekannter Typ: {raw}") from None


def _opt_text(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed if trimmed else None


def _parse_release_year(value: str | None) -> int | None:
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    try:
        return int(trimmed)
    except ValueError:
        raise ValueError("release_year muss eine Ganzzahl sein") from None


def _pick_csv_delimiter(csv_text: str, preferred: str | None) -> str:
    if preferred and len(preferred) == 1:
        return preferred
    first_non_empty = next((line for line in csv_text.splitlines() if line.strip()), "")
    if not first_non_empty:
        return ","
    candidates = [",", ";", "\t", "|"]
    return max(candidates, key=lambda candidate: first_non_empty.count(candidate))


def _validation_error_message(error: ValidationError) -> str:
    first = (error.errors() or [{}])[0]
    loc = ".".join(str(part) for part in first.get("loc", []))
    msg = str(first.get("msg", "Ungültiger Wert"))
    return f"{loc}: {msg}" if loc else msg


@router.post("/bulk-import", response_model=MasterProductBulkImportOut)
async def bulk_import_master_products(
    data: MasterProductBulkImportIn, session: AsyncSession = Depends(get_session)
) -> MasterProductBulkImportOut:
    csv_text = data.csv_text.lstrip("\ufeff")
    delimiter = _pick_csv_delimiter(csv_text, data.delimiter)
    reader = csv.DictReader(io.StringIO(csv_text), delimiter=delimiter)
    fieldnames = reader.fieldnames or []
    if not fieldnames:
        raise HTTPException(status_code=400, detail="CSV Header fehlt")

    mapped_headers: dict[str, str] = {}
    for raw_header in fieldnames:
        normalized = _normalize_header(raw_header)
        canonical = _CSV_HEADER_ALIASES.get(normalized)
        if canonical and canonical not in mapped_headers:
            mapped_headers[canonical] = raw_header

    missing_required = [column for column in ("title", "platform") if column not in mapped_headers]
    if missing_required:
        raise HTTPException(
            status_code=400,
            detail=f"Pflichtspalten fehlen: {', '.join(missing_required)}",
        )

    total_rows = 0
    imported_count = 0
    failed_count = 0
    skipped_count = 0
    errors: list[MasterProductBulkImportRowError] = []

    for row_number, row in enumerate(reader, start=2):
        values: dict[str, str] = {
            canonical: (row.get(source_header) or "").strip()
            for canonical, source_header in mapped_headers.items()
        }
        if not any(values.values()):
            skipped_count += 1
            continue
        total_rows += 1

        title = values.get("title") or None
        try:
            payload = MasterProductCreate.model_validate(
                {
                    "kind": _normalize_kind(values.get("kind", "")),
                    "title": values.get("title", ""),
                    "platform": values.get("platform", ""),
                    "region": values.get("region", "") or "EU",
                    "variant": values.get("variant", ""),
                    "ean": _opt_text(values.get("ean")),
                    "asin": _opt_text(values.get("asin")),
                    "manufacturer": _opt_text(values.get("manufacturer")),
                    "model": _opt_text(values.get("model")),
                    "genre": _opt_text(values.get("genre")),
                    "release_year": _parse_release_year(values.get("release_year")),
                    "reference_image_url": _opt_text(values.get("reference_image_url")),
                }
            )
        except ValidationError as error:
            failed_count += 1
            errors.append(
                MasterProductBulkImportRowError(
                    row_number=row_number,
                    message=_validation_error_message(error),
                    title=title,
                )
            )
            continue
        except ValueError as error:
            failed_count += 1
            errors.append(
                MasterProductBulkImportRowError(
                    row_number=row_number,
                    message=str(error),
                    title=title,
                )
            )
            continue

        mp_id = uuid.uuid4()
        mp = MasterProduct(
            id=mp_id,
            sku=master_product_sku_from_id(mp_id),
            **payload.model_dump(),
        )
        session.add(mp)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            failed_count += 1
            errors.append(
                MasterProductBulkImportRowError(
                    row_number=row_number,
                    message="Produkt existiert bereits (gleiche Identität oder SKU).",
                    title=title,
                )
            )
            continue
        imported_count += 1

    return MasterProductBulkImportOut(
        total_rows=total_rows,
        imported_count=imported_count,
        failed_count=failed_count,
        skipped_count=skipped_count,
        errors=errors,
    )


@router.post("", response_model=MasterProductOut)
async def create_master_product(
    data: MasterProductCreate, session: AsyncSession = Depends(get_session)
) -> MasterProductOut:
    mp_id = uuid.uuid4()
    mp = MasterProduct(
        id=mp_id,
        sku=master_product_sku_from_id(mp_id),
        **data.model_dump(),
    )
    session.add(mp)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(status_code=409, detail="Master product already exists") from e
    await session.refresh(mp)
    return MasterProductOut.model_validate(mp)


@router.get("", response_model=list[MasterProductOutWithAmazon])
async def list_master_products(session: AsyncSession = Depends(get_session)) -> list[MasterProductOutWithAmazon]:
    rows = (
        await session.execute(
            select(MasterProduct, AmazonProductMetricsLatest)
            .outerjoin(AmazonProductMetricsLatest, AmazonProductMetricsLatest.master_product_id == MasterProduct.id)
            .order_by(
                MasterProduct.kind,
                MasterProduct.title,
                MasterProduct.platform,
                MasterProduct.region,
                MasterProduct.variant,
            )
        )
    ).all()

    out: list[MasterProductOutWithAmazon] = []
    for mp, latest in rows:
        base = MasterProductOut.model_validate(mp)
        out.append(
            MasterProductOutWithAmazon(
                **base.model_dump(),
                amazon_last_attempt_at=getattr(latest, "last_attempt_at", None),
                amazon_last_success_at=getattr(latest, "last_success_at", None),
                amazon_last_run_id=getattr(latest, "last_run_id", None),
                amazon_blocked_last=getattr(latest, "blocked_last", None),
                amazon_block_reason_last=getattr(latest, "block_reason_last", None),
                amazon_last_error=getattr(latest, "last_error", None),
                amazon_rank_overall=getattr(latest, "rank_overall", None),
                amazon_rank_overall_category=getattr(latest, "rank_overall_category", None),
                amazon_rank_specific=getattr(latest, "rank_specific", None),
                amazon_rank_specific_category=getattr(latest, "rank_specific_category", None),
                amazon_price_new_cents=getattr(latest, "price_new_cents", None),
                amazon_price_used_like_new_cents=getattr(latest, "price_used_like_new_cents", None),
                amazon_price_used_very_good_cents=getattr(latest, "price_used_very_good_cents", None),
                amazon_price_used_good_cents=getattr(latest, "price_used_good_cents", None),
                amazon_price_used_acceptable_cents=getattr(latest, "price_used_acceptable_cents", None),
                amazon_price_collectible_cents=getattr(latest, "price_collectible_cents", None),
                amazon_buybox_total_cents=getattr(latest, "buybox_total_cents", None),
                amazon_offers_count_total=getattr(latest, "offers_count_total", None),
                amazon_offers_count_priced_total=getattr(latest, "offers_count_priced_total", None),
                amazon_offers_count_used_priced_total=getattr(latest, "offers_count_used_priced_total", None),
                amazon_next_retry_at=getattr(latest, "next_retry_at", None),
                amazon_consecutive_failures=getattr(latest, "consecutive_failures", None),
            )
        )
    return out


@router.get("/{master_product_id}", response_model=MasterProductOutWithAmazon)
async def get_master_product(
    master_product_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> MasterProductOutWithAmazon:
    row = (
        (
            await session.execute(
                select(MasterProduct, AmazonProductMetricsLatest)
                .outerjoin(AmazonProductMetricsLatest, AmazonProductMetricsLatest.master_product_id == MasterProduct.id)
                .where(MasterProduct.id == master_product_id)
            )
        )
        .all()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    mp, latest = row[0]
    base = MasterProductOut.model_validate(mp)
    return MasterProductOutWithAmazon(
        **base.model_dump(),
        amazon_last_attempt_at=getattr(latest, "last_attempt_at", None),
        amazon_last_success_at=getattr(latest, "last_success_at", None),
        amazon_last_run_id=getattr(latest, "last_run_id", None),
        amazon_blocked_last=getattr(latest, "blocked_last", None),
        amazon_block_reason_last=getattr(latest, "block_reason_last", None),
        amazon_last_error=getattr(latest, "last_error", None),
        amazon_rank_overall=getattr(latest, "rank_overall", None),
        amazon_rank_overall_category=getattr(latest, "rank_overall_category", None),
        amazon_rank_specific=getattr(latest, "rank_specific", None),
        amazon_rank_specific_category=getattr(latest, "rank_specific_category", None),
        amazon_price_new_cents=getattr(latest, "price_new_cents", None),
        amazon_price_used_like_new_cents=getattr(latest, "price_used_like_new_cents", None),
        amazon_price_used_very_good_cents=getattr(latest, "price_used_very_good_cents", None),
        amazon_price_used_good_cents=getattr(latest, "price_used_good_cents", None),
        amazon_price_used_acceptable_cents=getattr(latest, "price_used_acceptable_cents", None),
        amazon_price_collectible_cents=getattr(latest, "price_collectible_cents", None),
        amazon_buybox_total_cents=getattr(latest, "buybox_total_cents", None),
        amazon_offers_count_total=getattr(latest, "offers_count_total", None),
        amazon_offers_count_priced_total=getattr(latest, "offers_count_priced_total", None),
        amazon_offers_count_used_priced_total=getattr(latest, "offers_count_used_priced_total", None),
        amazon_next_retry_at=getattr(latest, "next_retry_at", None),
        amazon_consecutive_failures=getattr(latest, "consecutive_failures", None),
    )


@router.patch("/{master_product_id}", response_model=MasterProductOut)
async def update_master_product(
    master_product_id: uuid.UUID,
    data: MasterProductUpdate,
    session: AsyncSession = Depends(get_session),
) -> MasterProductOut:
    mp = await session.get(MasterProduct, master_product_id)
    if mp is None:
        raise HTTPException(status_code=404, detail="Not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(mp, k, v)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(status_code=409, detail="Master product already exists") from e
    await session.refresh(mp)
    return MasterProductOut.model_validate(mp)


@router.delete("/{master_product_id}", status_code=204)
async def delete_master_product(
    master_product_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> Response:
    mp = await session.get(MasterProduct, master_product_id)
    if mp is None:
        raise HTTPException(status_code=404, detail="Not found")

    # Provide a helpful, deterministic 409 instead of a generic FK integrity error.
    inv_count = (
        await session.scalar(
            select(func.count()).select_from(InventoryItem).where(InventoryItem.master_product_id == master_product_id)
        )
    ) or 0
    purchase_line_count = (
        await session.scalar(
            select(func.count()).select_from(PurchaseLine).where(PurchaseLine.master_product_id == master_product_id)
        )
    ) or 0

    if inv_count or purchase_line_count:
        parts: list[str] = []
        if inv_count:
            parts.append(f"{inv_count} inventory items")
        if purchase_line_count:
            parts.append(f"{purchase_line_count} purchase lines")
        raise HTTPException(status_code=409, detail=f"Cannot delete: referenced by {', '.join(parts)}")

    await session.delete(mp)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(status_code=409, detail="Cannot delete: master product is still referenced") from e
    return Response(status_code=204)
