from __future__ import annotations

import csv
import io

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.enums import OrderChannel, PaymentSource
from app.core.security import require_basic_auth
from app.models.ledger_entry import LedgerEntry
from app.models.marketplace_payout import MarketplacePayout
from app.schemas.marketplace_payout import (
    MarketplacePayoutImportIn,
    MarketplacePayoutImportOut,
    MarketplacePayoutImportRowError,
    MarketplacePayoutOut,
)
from app.services.money import parse_eur_to_cents


router = APIRouter()


def _pick_csv_delimiter(csv_text: str, preferred: str | None) -> str:
    if preferred and len(preferred) == 1:
        return preferred
    first_non_empty = next((line for line in csv_text.splitlines() if line.strip()), "")
    if not first_non_empty:
        return ","
    candidates = [",", ";", "\t", "|"]
    return max(candidates, key=lambda candidate: first_non_empty.count(candidate))


@router.get("/payouts", response_model=list[MarketplacePayoutOut])
async def list_marketplace_payouts(
    channel: OrderChannel | None = None,
    session: AsyncSession = Depends(get_session),
) -> list[MarketplacePayoutOut]:
    stmt = select(MarketplacePayout).order_by(MarketplacePayout.payout_date.desc(), MarketplacePayout.created_at.desc())
    if channel is not None:
        stmt = stmt.where(MarketplacePayout.channel == channel)
    rows = (await session.execute(stmt)).scalars().all()
    return [MarketplacePayoutOut.model_validate(r) for r in rows]


@router.post("/imports/payouts", response_model=MarketplacePayoutImportOut)
async def import_marketplace_payouts(
    data: MarketplacePayoutImportIn,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> MarketplacePayoutImportOut:
    csv_text = data.csv_text.lstrip("\ufeff")
    delimiter = _pick_csv_delimiter(csv_text, data.delimiter)
    reader = csv.DictReader(io.StringIO(csv_text), delimiter=delimiter)
    fieldnames = reader.fieldnames or []
    if not fieldnames:
        raise HTTPException(status_code=400, detail="CSV Header fehlt")

    required = {"channel", "external_payout_id", "payout_date", "net_amount_eur"}
    missing = sorted(required - set(fieldnames))
    if missing:
        raise HTTPException(status_code=400, detail=f"Pflichtspalten fehlen: {', '.join(missing)}")

    total_rows = 0
    imported_count = 0
    skipped_count = 0
    failed_count = 0
    errors: list[MarketplacePayoutImportRowError] = []

    async with session.begin_nested():
        for row_number, row in enumerate(reader, start=2):
            values = {k: (row.get(k) or "").strip() for k in fieldnames}
            if not any(values.values()):
                continue
            total_rows += 1

            external_payout_id = values.get("external_payout_id") or None
            try:
                channel_raw = (values.get("channel") or "").strip().upper()
                if channel_raw not in ("AMAZON", "EBAY"):
                    raise ValueError("channel must be AMAZON or EBAY")
                channel = OrderChannel[channel_raw]
                if not external_payout_id:
                    raise ValueError("external_payout_id is required")

                payout_date = values.get("payout_date") or ""
                # date.fromisoformat is strict enough for YYYY-MM-DD
                from datetime import date as _date

                payout_dt = _date.fromisoformat(payout_date)
                net_amount_cents = parse_eur_to_cents(values.get("net_amount_eur") or "")
            except Exception as e:
                failed_count += 1
                errors.append(
                    MarketplacePayoutImportRowError(
                        row_number=row_number,
                        message=str(e) or "Ungültige Zeile",
                        external_payout_id=external_payout_id,
                    )
                )
                continue

            existing = (
                (
                    await session.execute(
                        select(MarketplacePayout).where(
                            MarketplacePayout.channel == channel,
                            MarketplacePayout.external_payout_id == external_payout_id,
                        )
                    )
                )
                .scalars()
                .one_or_none()
            )
            if existing is not None:
                skipped_count += 1
                continue

            payout = MarketplacePayout(
                channel=channel,
                external_payout_id=external_payout_id,
                payout_date=payout_dt,
                net_amount_cents=net_amount_cents,
            )
            session.add(payout)
            await session.flush()

            entry = LedgerEntry(
                entry_date=payout.payout_date,
                account=PaymentSource.BANK,
                amount_cents=payout.net_amount_cents,
                entity_type="marketplace_payout",
                entity_id=payout.id,
                memo=payout.external_payout_id,
            )
            session.add(entry)
            await session.flush()
            payout.ledger_entry_id = entry.id

            imported_count += 1

    _ = actor  # reserved for future audit/import-batch tracking
    return MarketplacePayoutImportOut(
        total_rows=total_rows,
        imported_count=imported_count,
        skipped_count=skipped_count,
        failed_count=failed_count,
        errors=errors,
    )
