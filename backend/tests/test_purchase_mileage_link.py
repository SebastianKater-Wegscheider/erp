from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.endpoints.mileage import create_mileage_endpoint, update_mileage_endpoint
from app.api.v1.endpoints.purchases import delete_purchase_mileage, get_purchase_mileage, upsert_purchase_mileage
from app.api.v1.router import api_router
from app.core.enums import PaymentSource, PurchaseKind
from app.models.mileage_log import MileageLog
from app.models.purchase import Purchase
from app.schemas.mileage import MileageCreate
from app.schemas.purchase_mileage import PurchaseMileageUpsert


async def _create_purchase(session: AsyncSession) -> Purchase:
    purchase = Purchase(
        kind=PurchaseKind.PRIVATE_DIFF,
        purchase_date=date(2026, 2, 11),
        counterparty_name="Seller",
        counterparty_address=None,
        counterparty_birthdate=None,
        counterparty_id_number=None,
        total_amount_cents=10_000,
        shipping_cost_cents=0,
        buyer_protection_fee_cents=0,
        total_net_cents=10_000,
        total_tax_cents=0,
        tax_rate_bp=0,
        payment_source=PaymentSource.BANK,
        source_platform=None,
        listing_url=None,
        notes=None,
        document_number=None,
        pdf_path=None,
        external_invoice_number=None,
        receipt_upload_path=None,
    )
    session.add(purchase)
    await session.commit()
    return purchase


@pytest.mark.asyncio
async def test_purchase_mileage_upsert_creates_primary_mileage_log(db_session: AsyncSession) -> None:
    purchase = await _create_purchase(db_session)

    out = await upsert_purchase_mileage(
        purchase.id,
        PurchaseMileageUpsert(
            log_date=date(2026, 2, 11),
            start_location="Warehouse",
            destination="Seller",
            km=Decimal("12.4"),
            purpose_text="Mario lot pickup",
        ),
        session=db_session,
        actor="test-user",
    )

    assert out.purpose.value == "BUYING"
    assert out.purchase_ids == [purchase.id]
    assert out.distance_meters == 12_400
    assert out.amount_cents > 0

    refreshed = await db_session.get(Purchase, purchase.id)
    assert refreshed is not None
    assert refreshed.primary_mileage_log_id == out.id

    fetched = await get_purchase_mileage(purchase.id, session=db_session)
    assert fetched is not None
    assert fetched.id == out.id


@pytest.mark.asyncio
async def test_purchase_mileage_upsert_is_idempotent_and_updates_existing_row(db_session: AsyncSession) -> None:
    purchase = await _create_purchase(db_session)

    first = await upsert_purchase_mileage(
        purchase.id,
        PurchaseMileageUpsert(
            log_date=date(2026, 2, 10),
            start_location="A",
            destination="B",
            km=Decimal("5"),
            purpose_text=None,
        ),
        session=db_session,
        actor="test-user",
    )

    second = await upsert_purchase_mileage(
        purchase.id,
        PurchaseMileageUpsert(
            log_date=date(2026, 2, 12),
            start_location="A2",
            destination="B2",
            km=Decimal("8.25"),
            purpose_text="Updated run",
        ),
        session=db_session,
        actor="test-user",
    )

    assert second.id == first.id
    assert second.distance_meters == 8_250
    assert second.start_location == "A2"
    assert second.destination == "B2"

    mileage_count = await db_session.scalar(select(func.count()).select_from(MileageLog))
    assert mileage_count == 1


@pytest.mark.asyncio
async def test_purchase_mileage_delete_removes_primary_log(db_session: AsyncSession) -> None:
    purchase = await _create_purchase(db_session)
    created = await upsert_purchase_mileage(
        purchase.id,
        PurchaseMileageUpsert(
            log_date=date(2026, 2, 11),
            start_location="A",
            destination="B",
            km=Decimal("3.5"),
            purpose_text=None,
        ),
        session=db_session,
        actor="test-user",
    )

    await delete_purchase_mileage(purchase.id, session=db_session, actor="test-user")

    refreshed = await db_session.get(Purchase, purchase.id)
    assert refreshed is not None
    assert refreshed.primary_mileage_log_id is None
    assert await db_session.get(MileageLog, created.id) is None
    assert await get_purchase_mileage(purchase.id, session=db_session) is None


@pytest.mark.asyncio
async def test_mileage_update_endpoint_updates_route_and_purchase_links(db_session: AsyncSession) -> None:
    purchase_a = await _create_purchase(db_session)
    purchase_b = await _create_purchase(db_session)
    purchase_a_id = purchase_a.id
    purchase_b_id = purchase_b.id

    created = await create_mileage_endpoint(
        MileageCreate(
            log_date=date(2026, 2, 11),
            start_location="Lager",
            destination="Post",
            purpose="BUYING",
            km=Decimal("6.5"),
            purchase_ids=[purchase_a_id],
        ),
        session=db_session,
        actor="test-user",
    )
    await db_session.rollback()

    updated = await update_mileage_endpoint(
        created.id,
        MileageCreate(
            log_date=date(2026, 2, 12),
            start_location="Lager",
            destination="Verkaeufer",
            purpose="BUYING",
            km=Decimal("14.2"),
            purchase_ids=[purchase_a_id, purchase_b_id],
            purpose_text="Tour mit Rueckfahrt",
        ),
        session=db_session,
        actor="test-user",
    )

    assert updated.id == created.id
    assert updated.log_date == date(2026, 2, 12)
    assert updated.distance_meters == 14_200
    assert set(updated.purchase_ids) == {purchase_a_id, purchase_b_id}
    assert updated.purpose_text == "Tour mit Rueckfahrt"


@pytest.mark.asyncio
async def test_mileage_update_endpoint_returns_404_for_unknown_log(db_session: AsyncSession) -> None:
    with pytest.raises(HTTPException) as exc:
        await update_mileage_endpoint(
            uuid4(),
            MileageCreate(
                log_date=date(2026, 2, 12),
                start_location="A",
                destination="B",
                purpose="OTHER",
                km=Decimal("1.0"),
            ),
            session=db_session,
            actor="test-user",
        )

    assert exc.value.status_code == 404


def test_bank_router_removed_from_api() -> None:
    paths = {route.path for route in api_router.routes}
    assert "/bank/sync" not in paths
    assert not any(path.startswith("/bank") for path in paths)
