from __future__ import annotations

import csv
import io
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.enums import MarketplaceStagedOrderStatus, OrderChannel, PaymentSource
from app.core.security import require_basic_auth
from app.models.ledger_entry import LedgerEntry
from app.models.marketplace_staged_order import MarketplaceStagedOrder
from app.models.marketplace_payout import MarketplacePayout
from app.schemas.marketplace_orders import (
    MarketplaceOrdersImportIn,
    MarketplaceOrdersImportOut,
    MarketplaceStagedOrderApplyIn,
    MarketplaceStagedOrderApplyOut,
    MarketplaceStagedOrderApplyResultOut,
    MarketplaceStagedOrderOut,
)
from app.schemas.marketplace_payout import (
    MarketplacePayoutImportIn,
    MarketplacePayoutImportOut,
    MarketplacePayoutImportRowError,
    MarketplacePayoutOut,
)
from app.services.marketplace_orders import apply_staged_order_to_finalized_sale, import_marketplace_orders_csv
from app.services.money import parse_eur_to_cents


router = APIRouter()


@asynccontextmanager
async def _begin_tx(session: AsyncSession):
    # Endpoint handlers are sometimes called directly in tests using a shared session.
    # That session may already have an autobegun transaction (even after a SELECT),
    # so we fall back to SAVEPOINT semantics in that case.
    if session.in_transaction():
        async with session.begin_nested():
            yield
    else:
        async with session.begin():
            yield


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

    async with _begin_tx(session):
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


@router.post("/imports/orders", response_model=MarketplaceOrdersImportOut)
async def import_marketplace_orders(
    data: MarketplaceOrdersImportIn,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> MarketplaceOrdersImportOut:
    try:
        async with _begin_tx(session):
            summary = await import_marketplace_orders_csv(
                session,
                actor=actor,
                csv_text=data.csv_text,
                delimiter=data.delimiter,
                source_label=data.source_label,
            )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e) or "Invalid CSV") from e

    return MarketplaceOrdersImportOut(
        batch_id=summary.batch_id,
        total_rows=summary.total_rows,
        staged_orders_count=summary.staged_orders_count,
        staged_lines_count=summary.staged_lines_count,
        ready_orders_count=summary.ready_orders_count,
        needs_attention_orders_count=summary.needs_attention_orders_count,
        skipped_orders_count=summary.skipped_orders_count,
        failed_count=summary.failed_count,
        errors=summary.errors,
    )


@router.get("/staged-orders", response_model=list[MarketplaceStagedOrderOut])
async def list_staged_orders(
    status: MarketplaceStagedOrderStatus | None = None,
    batch_id: UUID | None = None,
    q: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> list[MarketplaceStagedOrderOut]:
    stmt = (
        select(MarketplaceStagedOrder)
        .options(selectinload(MarketplaceStagedOrder.lines))
        .order_by(MarketplaceStagedOrder.order_date.desc(), MarketplaceStagedOrder.created_at.desc())
    )
    if status is not None:
        stmt = stmt.where(MarketplaceStagedOrder.status == status)
    if batch_id is not None:
        stmt = stmt.where(MarketplaceStagedOrder.batch_id == batch_id)
    if q:
        stmt = stmt.where(MarketplaceStagedOrder.external_order_id.ilike(f"%{q.strip()}%"))
    rows = (await session.execute(stmt)).scalars().all()
    return [MarketplaceStagedOrderOut.model_validate(r) for r in rows]


@router.get("/staged-orders/{staged_order_id}", response_model=MarketplaceStagedOrderOut)
async def get_staged_order(
    staged_order_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> MarketplaceStagedOrderOut:
    row = (
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
    if row is None:
        raise HTTPException(status_code=404, detail="Not found")
    return MarketplaceStagedOrderOut.model_validate(row)


@router.post("/staged-orders/apply", response_model=MarketplaceStagedOrderApplyOut)
async def apply_staged_orders(
    data: MarketplaceStagedOrderApplyIn,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> MarketplaceStagedOrderApplyOut:
    if not data.staged_order_ids and not data.batch_id:
        raise HTTPException(status_code=400, detail="Provide staged_order_ids or batch_id")

    if data.batch_id:
        ids = (
            (
                await session.execute(
                    select(MarketplaceStagedOrder.id).where(
                        MarketplaceStagedOrder.batch_id == data.batch_id,
                        MarketplaceStagedOrder.status == MarketplaceStagedOrderStatus.READY,
                    )
                )
            )
            .scalars()
            .all()
        )
        staged_order_ids = [i for i in ids]
    else:
        staged_order_ids = list(data.staged_order_ids or [])

    results: list[MarketplaceStagedOrderApplyResultOut] = []
    async with _begin_tx(session):
        for staged_order_id in staged_order_ids:
            try:
                async with session.begin_nested():
                    sale_id = await apply_staged_order_to_finalized_sale(
                        session,
                        actor=actor,
                        staged_order_id=staged_order_id,
                    )
                results.append(
                    MarketplaceStagedOrderApplyResultOut(
                        staged_order_id=staged_order_id,
                        sales_order_id=sale_id,
                        ok=True,
                        error=None,
                    )
                )
            except Exception as e:
                results.append(
                    MarketplaceStagedOrderApplyResultOut(
                        staged_order_id=staged_order_id,
                        sales_order_id=None,
                        ok=False,
                        error=str(e) or "Failed",
                    )
                )

    return MarketplaceStagedOrderApplyOut(results=results)
