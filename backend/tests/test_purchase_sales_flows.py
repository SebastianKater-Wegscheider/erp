from __future__ import annotations

import uuid
from datetime import date
from pathlib import Path

import pytest
from PIL import Image
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.core.enums import (
    FBACostDistributionMethod,
    InventoryCondition,
    InventoryStatus,
    OrderChannel,
    OrderStatus,
    PaymentSource,
    PurchaseKind,
    PurchaseType,
    ReturnAction,
)
from app.models.inventory_item import InventoryItem
from app.models.ledger_entry import LedgerEntry
from app.models.master_product import MasterProduct
from app.models.mileage_log import MileageLog, _mileage_log_purchases
from app.models.purchase import Purchase, PurchaseLine
from app.models.purchase_attachment import PurchaseAttachment
from app.models.sales import SalesOrder
from app.models.sales_correction import SalesCorrection
from app.schemas.fba_shipment import FBAShipmentCreate, FBAShipmentReceive, FBAShipmentReceiveDiscrepancy
from app.schemas.purchase_mileage import PurchaseMileageUpsert
from app.schemas.purchase import PurchaseCreate, PurchaseLineCreate, PurchaseLineUpsert, PurchaseUpdate
from app.schemas.sales import SalesOrderCreate, SalesOrderLineCreate, SalesOrderUpdate
from app.schemas.sales_correction import SalesCorrectionCreate, SalesCorrectionLineCreate
from app.services.fba_shipments import create_fba_shipment, mark_fba_shipment_received, mark_fba_shipment_shipped
from app.services.purchases import (
    create_purchase,
    delete_purchase,
    generate_purchase_credit_note_pdf,
    reopen_purchase_for_edit,
    upsert_purchase_primary_mileage,
    update_purchase,
)
from app.services.sales import (
    cancel_sales_order,
    create_sales_order,
    finalize_sales_order,
    generate_sales_invoice_pdf,
    reopen_sales_order_for_edit,
    update_sales_order,
)
from app.services.sales_corrections import create_sales_correction, generate_sales_correction_pdf


ACTOR = "tester"


async def _create_master_product(session: AsyncSession, *, suffix: str) -> MasterProduct:
    mp = MasterProduct(
        kind="GAME",
        title=f"Product {suffix}",
        platform="PS5",
        region="EU",
        variant=suffix,
    )
    session.add(mp)
    await session.flush()
    return mp


async def _create_private_purchase(
    session: AsyncSession,
    *,
    purchase_date: date,
    lines: list[tuple[uuid.UUID, int]],
) -> Purchase:
    payload = PurchaseCreate(
        kind=PurchaseKind.PRIVATE_DIFF,
        purchase_date=purchase_date,
        counterparty_name="Privat",
        counterparty_address="Adresse 1",
        total_amount_cents=sum(amount for _, amount in lines),
        payment_source=PaymentSource.BANK,
        lines=[
            PurchaseLineCreate(
                master_product_id=mp_id,
                condition=InventoryCondition.GOOD,
                purchase_type=PurchaseType.DIFF,
                purchase_price_cents=amount,
            )
            for mp_id, amount in lines
        ],
    )
    return await create_purchase(session, actor=ACTOR, data=payload)


async def _create_private_equity_purchase(
    session: AsyncSession,
    *,
    purchase_date: date,
    lines: list[tuple[uuid.UUID, int, int | None]],
) -> Purchase:
    payload = PurchaseCreate(
        kind=PurchaseKind.PRIVATE_EQUITY,
        purchase_date=purchase_date,
        counterparty_name="Inhaber",
        total_amount_cents=sum(value if value is not None else int((market * 85) // 100) for _, market, value in lines),
        payment_source=PaymentSource.CASH,
        lines=[
            PurchaseLineCreate(
                master_product_id=mp_id,
                condition=InventoryCondition.GOOD,
                purchase_type=PurchaseType.DIFF,
                market_value_cents=market,
                purchase_price_cents=value,
                held_privately_over_12_months=False,
            )
            for mp_id, market, value in lines
        ],
    )
    return await create_purchase(session, actor=ACTOR, data=payload)


@pytest.mark.asyncio
async def test_create_purchase_private_diff_creates_inventory_and_ledger(db_session: AsyncSession) -> None:
    purchase_date = date(2026, 2, 8)

    async with db_session.begin():
        mp = await _create_master_product(db_session, suffix="A")
        purchase = await _create_private_purchase(
            db_session,
            purchase_date=purchase_date,
            lines=[(mp.id, 1_500)],
        )

    row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    assert row.document_number is not None
    assert row.document_number.startswith("CRN-2026-")
    assert row.total_net_cents == 1_500
    assert row.total_tax_cents == 0

    inv = (
        await db_session.execute(select(InventoryItem).where(InventoryItem.purchase_line_id == row.lines[0].id))
    ).scalar_one()
    assert inv.status == InventoryStatus.AVAILABLE
    assert inv.purchase_type == PurchaseType.DIFF
    assert inv.purchase_price_cents == 1_500

    ledger = (
        await db_session.execute(
            select(LedgerEntry).where(LedgerEntry.entity_type == "purchase", LedgerEntry.entity_id == row.id)
        )
    ).scalar_one()
    assert ledger.amount_cents == -1_500
    assert ledger.entry_date == purchase_date


@pytest.mark.asyncio
async def test_create_purchase_private_equity_auto_valuation_and_no_ledger(db_session: AsyncSession) -> None:
    purchase_date = date(2026, 2, 10)
    async with db_session.begin():
        mp = await _create_master_product(db_session, suffix="PE1")
        purchase = await _create_private_equity_purchase(
            db_session,
            purchase_date=purchase_date,
            lines=[(mp.id, 2_000, None)],
        )

    row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    assert row.kind == PurchaseKind.PRIVATE_EQUITY
    assert row.payment_source == PaymentSource.PRIVATE_EQUITY
    assert row.document_number is not None and row.document_number.startswith("PAIV-2026-")
    assert row.lines[0].purchase_price_cents == 1_700
    assert row.lines[0].market_value_cents == 2_000

    inv = (
        await db_session.execute(select(InventoryItem).where(InventoryItem.purchase_line_id == row.lines[0].id))
    ).scalar_one()
    assert inv.purchase_type == PurchaseType.DIFF
    assert inv.purchase_price_cents == 1_700

    ledger_rows = (
        await db_session.execute(
            select(LedgerEntry).where(LedgerEntry.entity_type == "purchase", LedgerEntry.entity_id == row.id)
        )
    ).scalars().all()
    assert ledger_rows == []


@pytest.mark.asyncio
async def test_update_private_equity_valuation_fields(db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, suffix="PE2")
        purchase = await _create_private_equity_purchase(
            db_session,
            purchase_date=date(2026, 2, 10),
            lines=[(mp.id, 2_000, None)],
        )
    purchase_id = purchase.id

    row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase_id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    line = row.lines[0]
    await db_session.rollback()

    async with db_session.begin():
        updated = await update_purchase(
            db_session,
            actor=ACTOR,
            purchase_id=purchase_id,
            data=PurchaseUpdate(
                kind=PurchaseKind.PRIVATE_EQUITY,
                purchase_date=date(2026, 2, 11),
                counterparty_name="Inhaber",
                total_amount_cents=1_600,
                payment_source=PaymentSource.BANK,
                lines=[
                    PurchaseLineUpsert(
                        id=line.id,
                        master_product_id=line.master_product_id,
                        condition=line.condition,
                        purchase_type=line.purchase_type,
                        purchase_price_cents=1_600,
                        market_value_cents=1_900,
                        held_privately_over_12_months=True,
                        valuation_reason="Konservativer Abschlag",
                    )
                ],
            ),
        )

    assert updated.payment_source == PaymentSource.PRIVATE_EQUITY
    updated_row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase_id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    assert updated_row.lines[0].market_value_cents == 1_900
    assert updated_row.lines[0].held_privately_over_12_months is True
    assert updated_row.lines[0].valuation_reason == "Konservativer Abschlag"


@pytest.mark.asyncio
async def test_create_and_update_private_purchase_source_metadata(db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, suffix="META")
        purchase = await create_purchase(
            db_session,
            actor=ACTOR,
            data=PurchaseCreate(
                kind=PurchaseKind.PRIVATE_DIFF,
                purchase_date=date(2026, 2, 8),
                counterparty_name="Privat",
                source_platform="  kleinanzeigen ",
                listing_url=" https://www.kleinanzeigen.de/s-anzeige/123 ",
                notes="  Mit Controller und Spiel  ",
                total_amount_cents=1_500,
                payment_source=PaymentSource.BANK,
                lines=[
                    PurchaseLineCreate(
                        master_product_id=mp.id,
                        condition=InventoryCondition.GOOD,
                        purchase_type=PurchaseType.DIFF,
                        purchase_price_cents=1_500,
                    )
                ],
            ),
        )
    purchase_id = purchase.id

    row = await db_session.get(Purchase, purchase_id)
    assert row is not None
    assert row.source_platform == "Kleinanzeigen"
    assert row.listing_url == "https://www.kleinanzeigen.de/s-anzeige/123"
    assert row.notes == "Mit Controller und Spiel"
    await db_session.rollback()

    line = (await db_session.execute(select(PurchaseLine).where(PurchaseLine.purchase_id == purchase_id))).scalar_one()
    # Rollback expires ORM instances; store fields we need before the next transaction.
    line_id = line.id
    line_master_product_id = line.master_product_id
    line_condition = line.condition
    line_purchase_type = line.purchase_type
    await db_session.rollback()
    async with db_session.begin():
        await update_purchase(
            db_session,
            actor=ACTOR,
            purchase_id=purchase_id,
            data=PurchaseUpdate(
                kind=PurchaseKind.PRIVATE_DIFF,
                purchase_date=date(2026, 2, 9),
                counterparty_name="Privat",
                source_platform="  Flohmarkt Dornbirn  ",
                listing_url="  ",
                notes="  ",
                total_amount_cents=1_500,
                payment_source=PaymentSource.BANK,
                lines=[
                    PurchaseLineUpsert(
                        id=line_id,
                        master_product_id=line_master_product_id,
                        condition=line_condition,
                        purchase_type=line_purchase_type,
                        purchase_price_cents=1_500,
                    )
                ],
            ),
        )

    updated = await db_session.get(Purchase, purchase_id)
    assert updated is not None
    assert updated.source_platform == "Flohmarkt Dornbirn"
    assert updated.listing_url is None
    assert updated.notes is None


@pytest.mark.asyncio
async def test_create_purchase_regular_splits_vat_and_uses_net_inventory_cost(db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, suffix="B")
        purchase = await create_purchase(
            db_session,
            actor=ACTOR,
            data=PurchaseCreate(
                kind=PurchaseKind.COMMERCIAL_REGULAR,
                purchase_date=date(2026, 2, 8),
                counterparty_name="Supplier GmbH",
                total_amount_cents=1_200,
                tax_rate_bp=2_000,
                payment_source=PaymentSource.BANK,
                external_invoice_number="INV-100",
                receipt_upload_path="uploads/inv-100.pdf",
                lines=[
                    PurchaseLineCreate(
                        master_product_id=mp.id,
                        condition=InventoryCondition.LIKE_NEW,
                        purchase_type=PurchaseType.REGULAR,
                        purchase_price_cents=1_200,
                    )
                ],
            ),
        )

    row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    assert row.total_net_cents == 1_000
    assert row.total_tax_cents == 200

    inv = (
        await db_session.execute(select(InventoryItem).where(InventoryItem.purchase_line_id == row.lines[0].id))
    ).scalar_one()
    assert inv.purchase_price_cents == 1_000
    assert inv.purchase_type == PurchaseType.REGULAR


@pytest.mark.asyncio
async def test_create_private_purchase_with_shipping_and_buyer_fee_allocates_and_updates_ledger(
    db_session: AsyncSession,
) -> None:
    purchase_date = date(2026, 2, 8)

    async with db_session.begin():
        mp_a = await _create_master_product(db_session, suffix="B1")
        mp_b = await _create_master_product(db_session, suffix="B2")
        purchase = await create_purchase(
            db_session,
            actor=ACTOR,
            data=PurchaseCreate(
                kind=PurchaseKind.PRIVATE_DIFF,
                purchase_date=purchase_date,
                counterparty_name="Privat",
                total_amount_cents=4_000,
                shipping_cost_cents=40,
                buyer_protection_fee_cents=20,
                payment_source=PaymentSource.BANK,
                lines=[
                    PurchaseLineCreate(
                        master_product_id=mp_a.id,
                        condition=InventoryCondition.GOOD,
                        purchase_type=PurchaseType.DIFF,
                        purchase_price_cents=1_000,
                    ),
                    PurchaseLineCreate(
                        master_product_id=mp_b.id,
                        condition=InventoryCondition.GOOD,
                        purchase_type=PurchaseType.DIFF,
                        purchase_price_cents=3_000,
                    ),
                ],
            ),
        )

    row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    assert row.shipping_cost_cents == 40
    assert row.buyer_protection_fee_cents == 20
    assert sum(line.shipping_allocated_cents for line in row.lines) == 40
    assert sum(line.buyer_protection_fee_allocated_cents for line in row.lines) == 20

    line_by_price = {line.purchase_price_cents: line for line in row.lines}
    low = line_by_price[1_000]
    high = line_by_price[3_000]
    assert low.shipping_allocated_cents == 10
    assert low.buyer_protection_fee_allocated_cents == 5
    assert high.shipping_allocated_cents == 30
    assert high.buyer_protection_fee_allocated_cents == 15

    inventory_rows = (
        await db_session.execute(
            select(InventoryItem).where(InventoryItem.purchase_line_id.in_([line.id for line in row.lines]))
        )
    ).scalars().all()
    inventory_by_line_id = {item.purchase_line_id: item for item in inventory_rows}
    assert inventory_by_line_id[low.id].allocated_costs_cents == 15
    assert inventory_by_line_id[high.id].allocated_costs_cents == 45

    ledger = (
        await db_session.execute(
            select(LedgerEntry).where(LedgerEntry.entity_type == "purchase", LedgerEntry.entity_id == row.id)
        )
    ).scalar_one()
    assert ledger.amount_cents == -4_060


@pytest.mark.asyncio
async def test_update_private_purchase_reallocates_shipping_and_buyer_fee_with_delta(
    db_session: AsyncSession,
) -> None:
    async with db_session.begin():
        mp_a = await _create_master_product(db_session, suffix="B3")
        mp_b = await _create_master_product(db_session, suffix="B4")
        purchase = await create_purchase(
            db_session,
            actor=ACTOR,
            data=PurchaseCreate(
                kind=PurchaseKind.PRIVATE_DIFF,
                purchase_date=date(2026, 2, 8),
                counterparty_name="Privat",
                total_amount_cents=4_000,
                shipping_cost_cents=40,
                buyer_protection_fee_cents=20,
                payment_source=PaymentSource.BANK,
                lines=[
                    PurchaseLineCreate(
                        master_product_id=mp_a.id,
                        condition=InventoryCondition.GOOD,
                        purchase_type=PurchaseType.DIFF,
                        purchase_price_cents=1_000,
                    ),
                    PurchaseLineCreate(
                        master_product_id=mp_b.id,
                        condition=InventoryCondition.GOOD,
                        purchase_type=PurchaseType.DIFF,
                        purchase_price_cents=3_000,
                    ),
                ],
            ),
        )
    purchase_id = purchase.id

    before = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase_id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    line_a = min(before.lines, key=lambda line: line.purchase_price_cents)
    line_b = max(before.lines, key=lambda line: line.purchase_price_cents)
    line_a_id = line_a.id
    line_a_master_product_id = line_a.master_product_id
    line_a_condition = line_a.condition
    line_a_purchase_type = line_a.purchase_type
    line_b_id = line_b.id
    line_b_master_product_id = line_b.master_product_id
    line_b_condition = line_b.condition
    line_b_purchase_type = line_b.purchase_type
    inv_a_before = (
        await db_session.execute(select(InventoryItem).where(InventoryItem.purchase_line_id == line_a_id))
    ).scalar_one()
    inv_b_before = (
        await db_session.execute(select(InventoryItem).where(InventoryItem.purchase_line_id == line_b_id))
    ).scalar_one()
    assert inv_a_before.allocated_costs_cents == 15
    assert inv_b_before.allocated_costs_cents == 45
    await db_session.rollback()

    async with db_session.begin():
        await update_purchase(
            db_session,
            actor=ACTOR,
            purchase_id=purchase_id,
            data=PurchaseUpdate(
                kind=PurchaseKind.PRIVATE_DIFF,
                purchase_date=date(2026, 2, 9),
                counterparty_name="Privat",
                total_amount_cents=4_000,
                shipping_cost_cents=30,
                buyer_protection_fee_cents=10,
                    payment_source=PaymentSource.BANK,
                    lines=[
                        PurchaseLineUpsert(
                            id=line_a_id,
                            master_product_id=line_a_master_product_id,
                            condition=line_a_condition,
                            purchase_type=line_a_purchase_type,
                            purchase_price_cents=2_000,
                        ),
                        PurchaseLineUpsert(
                            id=line_b_id,
                            master_product_id=line_b_master_product_id,
                            condition=line_b_condition,
                            purchase_type=line_b_purchase_type,
                            purchase_price_cents=2_000,
                        ),
                    ],
            ),
        )

    updated = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase_id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    assert updated.shipping_cost_cents == 30
    assert updated.buyer_protection_fee_cents == 10
    assert sum(line.shipping_allocated_cents for line in updated.lines) == 30
    assert sum(line.buyer_protection_fee_allocated_cents for line in updated.lines) == 10
    assert {line.shipping_allocated_cents for line in updated.lines} == {15}
    assert {line.buyer_protection_fee_allocated_cents for line in updated.lines} == {5}

    inv_rows_after = (
        await db_session.execute(
            select(InventoryItem).where(InventoryItem.purchase_line_id.in_([line.id for line in updated.lines]))
        )
    ).scalars().all()
    for inv in inv_rows_after:
        assert inv.allocated_costs_cents == 20

    ledger = (
        await db_session.execute(
            select(LedgerEntry).where(LedgerEntry.entity_type == "purchase", LedgerEntry.entity_id == purchase_id)
        )
    ).scalar_one()
    assert ledger.amount_cents == -4_040


@pytest.mark.asyncio
async def test_update_purchase_can_remove_line_with_available_inventory(db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp_a = await _create_master_product(db_session, suffix="C")
        mp_b = await _create_master_product(db_session, suffix="D")
        purchase = await _create_private_purchase(
            db_session,
            purchase_date=date(2026, 2, 8),
            lines=[(mp_a.id, 1_000), (mp_b.id, 2_000)],
        )
    purchase_id = purchase.id

    before = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    keep_line = before.lines[0]
    keep_line_id = keep_line.id
    keep_line_mp_id = keep_line.master_product_id
    keep_line_condition = keep_line.condition
    keep_line_type = keep_line.purchase_type
    await db_session.rollback()

    async with db_session.begin():
        updated = await update_purchase(
            db_session,
            actor=ACTOR,
            purchase_id=purchase_id,
            data=PurchaseUpdate(
                kind=PurchaseKind.PRIVATE_DIFF,
                purchase_date=date(2026, 2, 10),
                counterparty_name="Privat",
                total_amount_cents=1_000,
                payment_source=PaymentSource.CASH,
                lines=[
                    PurchaseLineUpsert(
                        id=keep_line_id,
                        master_product_id=keep_line_mp_id,
                        condition=keep_line_condition,
                        purchase_type=keep_line_type,
                        purchase_price_cents=1_000,
                    )
                ],
            ),
        )

    row = await db_session.get(Purchase, updated.id)
    assert row is not None
    assert row.total_amount_cents == 1_000

    purchase_lines = (
        await db_session.execute(select(PurchaseLine).where(PurchaseLine.purchase_id == updated.id))
    ).scalars().all()
    assert len(purchase_lines) == 1

    inv_rows = (await db_session.execute(select(InventoryItem).where(InventoryItem.master_product_id == keep_line_mp_id))).scalars().all()
    assert len(inv_rows) == 1


@pytest.mark.asyncio
async def test_update_purchase_rejects_removal_when_item_not_available(db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp_a = await _create_master_product(db_session, suffix="E")
        mp_b = await _create_master_product(db_session, suffix="F")
        purchase = await _create_private_purchase(
            db_session,
            purchase_date=date(2026, 2, 8),
            lines=[(mp_a.id, 1_000), (mp_b.id, 2_000)],
        )

    before = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    keep_line = before.lines[0]
    remove_line = before.lines[1]

    sold_item = (
        await db_session.execute(select(InventoryItem).where(InventoryItem.purchase_line_id == remove_line.id))
    ).scalar_one()
    sold_item.status = InventoryStatus.SOLD
    await db_session.commit()

    with pytest.raises(ValueError, match="not AVAILABLE"):
        async with db_session.begin():
            await update_purchase(
                db_session,
                actor=ACTOR,
                purchase_id=purchase.id,
                data=PurchaseUpdate(
                    kind=PurchaseKind.PRIVATE_DIFF,
                    purchase_date=date(2026, 2, 8),
                    counterparty_name="Privat",
                    total_amount_cents=1_000,
                    payment_source=PaymentSource.BANK,
                    lines=[
                        PurchaseLineUpsert(
                            id=keep_line.id,
                            master_product_id=keep_line.master_product_id,
                            condition=keep_line.condition,
                            purchase_type=keep_line.purchase_type,
                            purchase_price_cents=1_000,
                        )
                    ],
                ),
            )


@pytest.mark.asyncio
async def test_delete_purchase_removes_inventory_ledger_and_primary_mileage(db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, suffix="DEL-A")
        purchase = await _create_private_purchase(
            db_session,
            purchase_date=date(2026, 2, 12),
            lines=[(mp.id, 1_200)],
        )
        purchase_id = purchase.id
        mileage = await upsert_purchase_primary_mileage(
            db_session,
            actor=ACTOR,
            purchase_id=purchase_id,
            data=PurchaseMileageUpsert(
                log_date=date(2026, 2, 12),
                start_location="Lager",
                destination="Verkaeufer",
                km="9.4",
                purpose_text="Abholung Testkauf",
            ),
            rate_cents_per_km=30,
        )

    purchase_row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase_id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    line_ids = [line.id for line in purchase_row.lines]
    mileage_id = mileage.id
    await db_session.rollback()

    async with db_session.begin():
        await delete_purchase(db_session, actor=ACTOR, purchase_id=purchase_id)

    assert await db_session.get(Purchase, purchase_id) is None
    assert await db_session.get(MileageLog, mileage_id) is None

    line_count = (
        await db_session.scalar(select(func.count()).select_from(PurchaseLine).where(PurchaseLine.purchase_id == purchase_id))
    ) or 0
    assert line_count == 0

    inventory_count = (
        await db_session.scalar(
            select(func.count()).select_from(InventoryItem).where(InventoryItem.purchase_line_id.in_(line_ids))
        )
    ) or 0
    assert inventory_count == 0

    ledger_count = (
        await db_session.scalar(
            select(func.count()).select_from(LedgerEntry).where(
                LedgerEntry.entity_type == "purchase",
                LedgerEntry.entity_id == purchase_id,
            )
        )
    ) or 0
    assert ledger_count == 0

    mileage_link_count = (
        await db_session.scalar(
            select(func.count())
            .select_from(_mileage_log_purchases)
            .where(_mileage_log_purchases.c.purchase_id == purchase_id)
        )
    ) or 0
    assert mileage_link_count == 0


@pytest.mark.asyncio
async def test_delete_purchase_rejects_when_inventory_not_available(db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, suffix="DEL-B")
        purchase = await _create_private_purchase(
            db_session,
            purchase_date=date(2026, 2, 12),
            lines=[(mp.id, 1_350)],
        )
        purchase_id = purchase.id

    purchase_row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase_id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    line_id = purchase_row.lines[0].id
    item = (await db_session.execute(select(InventoryItem).where(InventoryItem.purchase_line_id == line_id))).scalar_one()
    item.status = InventoryStatus.SOLD
    await db_session.commit()

    with pytest.raises(ValueError, match="not AVAILABLE"):
        async with db_session.begin():
            await delete_purchase(db_session, actor=ACTOR, purchase_id=purchase_id)

    assert await db_session.get(Purchase, purchase_id) is not None


@pytest.mark.asyncio
async def test_sales_finalize_flow_sets_statuses_and_ledger(db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, suffix="G")
        purchase = await _create_private_purchase(
            db_session,
            purchase_date=date(2026, 2, 8),
            lines=[(mp.id, 1_000)],
        )

    purchase_row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    item_id = (
        await db_session.execute(select(InventoryItem.id).where(InventoryItem.purchase_line_id == purchase_row.lines[0].id))
    ).scalar_one()
    await db_session.rollback()

    async with db_session.begin():
        order = await create_sales_order(
            db_session,
            actor=ACTOR,
            data=SalesOrderCreate(
                order_date=date(2026, 2, 9),
                channel=OrderChannel.EBAY,
                buyer_name="Max Mustermann",
                buyer_address="Testweg 1",
                shipping_gross_cents=200,
                payment_source=PaymentSource.BANK,
                lines=[SalesOrderLineCreate(inventory_item_id=item_id, sale_gross_cents=2_000)],
            ),
        )
    order_id = order.id

    reserved_item = await db_session.get(InventoryItem, item_id)
    assert reserved_item is not None
    assert reserved_item.status == InventoryStatus.RESERVED
    await db_session.rollback()

    async with db_session.begin():
        finalized = await finalize_sales_order(db_session, actor=ACTOR, order_id=order_id)

    assert finalized.status == OrderStatus.FINALIZED
    assert finalized.invoice_number is not None
    assert finalized.invoice_number.startswith("INV-2026-")

    sold_item = await db_session.get(InventoryItem, item_id)
    assert sold_item is not None
    assert sold_item.status == InventoryStatus.SOLD

    ledger = (
        await db_session.execute(
            select(LedgerEntry).where(LedgerEntry.entity_type == "sale", LedgerEntry.entity_id == finalized.id)
        )
    ).scalar_one()
    assert ledger.amount_cents == 2_200


@pytest.mark.asyncio
async def test_cancel_sales_order_releases_reserved_inventory(db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, suffix="H")
        purchase = await _create_private_purchase(
            db_session,
            purchase_date=date(2026, 2, 8),
            lines=[(mp.id, 1_000)],
        )

    purchase_row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    item_id = (
        await db_session.execute(select(InventoryItem.id).where(InventoryItem.purchase_line_id == purchase_row.lines[0].id))
    ).scalar_one()
    await db_session.rollback()

    async with db_session.begin():
        order = await create_sales_order(
            db_session,
            actor=ACTOR,
            data=SalesOrderCreate(
                order_date=date(2026, 2, 9),
                channel=OrderChannel.OTHER,
                buyer_name="Kunde",
                shipping_gross_cents=0,
                payment_source=PaymentSource.CASH,
                lines=[SalesOrderLineCreate(inventory_item_id=item_id, sale_gross_cents=1_500)],
            ),
        )

    async with db_session.begin():
        cancelled = await cancel_sales_order(db_session, actor=ACTOR, order_id=order.id)

    assert cancelled.status == OrderStatus.CANCELLED
    item = await db_session.get(InventoryItem, item_id)
    assert item is not None
    assert item.status == InventoryStatus.AVAILABLE


@pytest.mark.asyncio
async def test_sales_correction_restocks_or_writes_off_items(db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp_a = await _create_master_product(db_session, suffix="I")
        mp_b = await _create_master_product(db_session, suffix="J")
        purchase = await _create_private_purchase(
            db_session,
            purchase_date=date(2026, 2, 8),
            lines=[(mp_a.id, 1_000), (mp_b.id, 900)],
        )

    purchase_row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    item_ids = [
        (
            await db_session.execute(select(InventoryItem.id).where(InventoryItem.purchase_line_id == line.id))
        ).scalar_one()
        for line in purchase_row.lines
    ]
    await db_session.rollback()

    async with db_session.begin():
        order = await create_sales_order(
            db_session,
            actor=ACTOR,
            data=SalesOrderCreate(
                order_date=date(2026, 2, 10),
                channel=OrderChannel.AMAZON,
                buyer_name="Buyer",
                shipping_gross_cents=100,
                payment_source=PaymentSource.BANK,
                lines=[
                    SalesOrderLineCreate(inventory_item_id=item_ids[0], sale_gross_cents=2_000),
                    SalesOrderLineCreate(inventory_item_id=item_ids[1], sale_gross_cents=1_800),
                ],
            ),
        )
    async with db_session.begin():
        await finalize_sales_order(db_session, actor=ACTOR, order_id=order.id)

    async with db_session.begin():
        correction = await create_sales_correction(
            db_session,
            actor=ACTOR,
            order_id=order.id,
            data=SalesCorrectionCreate(
                correction_date=date(2026, 2, 11),
                payment_source=PaymentSource.BANK,
                shipping_refund_gross_cents=40,
                lines=[
                    SalesCorrectionLineCreate(
                        inventory_item_id=item_ids[0],
                        action=ReturnAction.RESTOCK,
                        refund_gross_cents=2_000,
                    ),
                    SalesCorrectionLineCreate(
                        inventory_item_id=item_ids[1],
                        action=ReturnAction.WRITE_OFF,
                        refund_gross_cents=1_800,
                    ),
                ],
            ),
        )

    assert correction.refund_gross_cents == 3_800

    restocked = await db_session.get(InventoryItem, item_ids[0])
    written_off = await db_session.get(InventoryItem, item_ids[1])
    assert restocked is not None and restocked.status == InventoryStatus.AVAILABLE
    assert written_off is not None and written_off.status == InventoryStatus.LOST
    assert written_off.condition == InventoryCondition.DEFECT

    ledger = (
        await db_session.execute(
            select(LedgerEntry).where(LedgerEntry.entity_type == "sales_correction", LedgerEntry.entity_id == correction.id)
        )
    ).scalar_one()
    assert ledger.amount_cents == -(3_800 + 40)


@pytest.mark.asyncio
async def test_fba_shipment_flow_allocates_costs_and_receives_with_discrepancy(db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp_a = await _create_master_product(db_session, suffix="K")
        mp_b = await _create_master_product(db_session, suffix="L")
        purchase = await _create_private_purchase(
            db_session,
            purchase_date=date(2026, 2, 8),
            lines=[(mp_a.id, 1_000), (mp_b.id, 3_000)],
        )

    purchase_row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    item_ids = [
        (
            await db_session.execute(select(InventoryItem.id).where(InventoryItem.purchase_line_id == line.id))
        ).scalar_one()
        for line in purchase_row.lines
    ]
    await db_session.rollback()

    async with db_session.begin():
        shipment = await create_fba_shipment(
            db_session,
            actor=ACTOR,
            data=FBAShipmentCreate(
                name="Inbound Februar",
                item_ids=item_ids,
                shipping_cost_cents=40,
                cost_distribution_method=FBACostDistributionMethod.PURCHASE_PRICE_WEIGHTED,
            ),
        )
    shipment_id = shipment.id

    async with db_session.begin():
        shipped = await mark_fba_shipment_shipped(db_session, actor=ACTOR, shipment_id=shipment_id)

    assert shipped.status.value == "SHIPPED"

    items_after_ship = (await db_session.execute(select(InventoryItem).where(InventoryItem.id.in_(item_ids)))).scalars().all()
    costs = {item.id: item.allocated_costs_cents for item in items_after_ship}
    assert costs[item_ids[0]] == 10
    assert costs[item_ids[1]] == 30
    assert all(item.status == InventoryStatus.FBA_INBOUND for item in items_after_ship)
    await db_session.rollback()

    async with db_session.begin():
        received = await mark_fba_shipment_received(
            db_session,
            actor=ACTOR,
            shipment_id=shipment_id,
            data=FBAShipmentReceive(
                discrepancies=[
                    FBAShipmentReceiveDiscrepancy(
                        inventory_item_id=item_ids[1],
                        status=InventoryStatus.DISCREPANCY,
                        note="Missing at FC",
                    )
                ]
            ),
        )

    assert received.status.value == "RECEIVED"

    item_ok = await db_session.get(InventoryItem, item_ids[0])
    item_missing = await db_session.get(InventoryItem, item_ids[1])
    assert item_ok is not None and item_ok.status == InventoryStatus.FBA_WAREHOUSE
    assert item_missing is not None and item_missing.status == InventoryStatus.DISCREPANCY


@pytest.mark.asyncio
async def test_generate_purchase_credit_note_pdf_sets_pdf_path(monkeypatch, db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, suffix="M")
        purchase = await _create_private_purchase(
            db_session,
            purchase_date=date(2026, 2, 8),
            lines=[(mp.id, 1_200)],
        )

    def fake_render_pdf(*, output_path: Path, **_kwargs) -> None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"pdf")

    monkeypatch.setattr("app.services.purchases.render_pdf", fake_render_pdf)

    async with db_session.begin():
        updated = await generate_purchase_credit_note_pdf(db_session, actor=ACTOR, purchase_id=purchase.id)

    assert updated.pdf_path is not None
    settings = get_settings()
    out_path = settings.app_storage_dir / updated.pdf_path
    assert out_path.exists()


@pytest.mark.asyncio
async def test_purchase_credit_note_pdf_includes_image_attachments_in_context(monkeypatch, db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, suffix="EVI")
        purchase = await _create_private_purchase(
            db_session,
            purchase_date=date(2026, 2, 8),
            lines=[(mp.id, 1_200)],
        )

        settings = get_settings()
        img_rel = "uploads/evidence-test.png"
        (settings.app_storage_dir / "uploads").mkdir(parents=True, exist_ok=True)
        Image.new("RGBA", (1, 1), (255, 0, 0, 255)).save(settings.app_storage_dir / img_rel, format="PNG")

        db_session.add(
            PurchaseAttachment(
                purchase_id=purchase.id,
                upload_path=img_rel,
                original_filename="evidence.png",
                kind="CHAT",
                note="Screenshot",
            )
        )

    captured: dict[str, object] = {}

    def fake_render_pdf(*, context: dict, **_kwargs) -> None:
        captured.update(context)

    monkeypatch.setattr("app.services.purchases.render_pdf", fake_render_pdf)

    async with db_session.begin():
        await generate_purchase_credit_note_pdf(db_session, actor=ACTOR, purchase_id=purchase.id)

    attachments = captured.get("purchase_attachments")
    assert isinstance(attachments, list)
    assert len(attachments) == 1
    a = attachments[0]
    assert a["original_filename"] == "evidence.png"
    assert a["is_image"] is True
    assert str(a["file_uri"]).startswith("file:")


@pytest.mark.asyncio
async def test_private_equity_pdf_includes_compliance_warnings(monkeypatch, db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, suffix="PE-PDF")
        purchase = await _create_private_equity_purchase(
            db_session,
            purchase_date=date(2026, 2, 12),
            lines=[(mp.id, 2_000, 1_700)],
        )

    captured: dict[str, object] = {}

    def fake_render_pdf(*, context: dict, **_kwargs) -> None:
        captured.update(context)

    monkeypatch.setattr("app.services.purchases.render_pdf", fake_render_pdf)

    async with db_session.begin():
        await generate_purchase_credit_note_pdf(db_session, actor=ACTOR, purchase_id=purchase.id)

    assert captured.get("is_private_equity") is True
    warnings = captured.get("compliance_warnings")
    assert isinstance(warnings, list)
    assert len(warnings) >= 2


@pytest.mark.asyncio
async def test_reopen_private_purchase_unlocks_for_edit(monkeypatch, db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, suffix="REOPEN-P")
        purchase = await _create_private_purchase(
            db_session,
            purchase_date=date(2026, 2, 8),
            lines=[(mp.id, 1_200)],
        )
    purchase_id = purchase.id

    def fake_render_pdf(*, output_path: Path, **_kwargs) -> None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"pdf")

    monkeypatch.setattr("app.services.purchases.render_pdf", fake_render_pdf)

    async with db_session.begin():
        generated = await generate_purchase_credit_note_pdf(db_session, actor=ACTOR, purchase_id=purchase_id)
    assert generated.pdf_path is not None

    settings = get_settings()
    old_pdf_path = settings.app_storage_dir / generated.pdf_path
    assert old_pdf_path.exists()

    async with db_session.begin():
        reopened = await reopen_purchase_for_edit(db_session, actor=ACTOR, purchase_id=purchase_id)
    assert reopened.pdf_path is None
    assert not old_pdf_path.exists()

    purchase_row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase_id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    line = purchase_row.lines[0]
    line_id = line.id
    line_master_product_id = line.master_product_id
    line_condition = line.condition
    line_purchase_type = line.purchase_type
    await db_session.rollback()

    async with db_session.begin():
        updated = await update_purchase(
            db_session,
            actor=ACTOR,
            purchase_id=purchase_id,
            data=PurchaseUpdate(
                kind=PurchaseKind.PRIVATE_DIFF,
                purchase_date=date(2026, 2, 9),
                counterparty_name="Privat",
                counterparty_address="Adresse 2",
                total_amount_cents=1_300,
                payment_source=PaymentSource.BANK,
                lines=[
                    PurchaseLineUpsert(
                        id=line_id,
                        master_product_id=line_master_product_id,
                        condition=line_condition,
                        purchase_type=line_purchase_type,
                        purchase_price_cents=1_300,
                    )
                ],
            ),
        )
    assert updated.total_amount_cents == 1_300
    assert updated.pdf_path is None

    ledger = (
        await db_session.execute(
            select(LedgerEntry).where(LedgerEntry.entity_type == "purchase", LedgerEntry.entity_id == purchase.id)
        )
    ).scalar_one()
    assert ledger.amount_cents == -1_300


@pytest.mark.asyncio
async def test_generate_sales_invoice_and_correction_pdf_paths(monkeypatch, db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, suffix="N")
        purchase = await _create_private_purchase(
            db_session,
            purchase_date=date(2026, 2, 8),
            lines=[(mp.id, 1_000)],
        )

    purchase_row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    item_id = (
        await db_session.execute(select(InventoryItem.id).where(InventoryItem.purchase_line_id == purchase_row.lines[0].id))
    ).scalar_one()
    await db_session.rollback()

    async with db_session.begin():
        order = await create_sales_order(
            db_session,
            actor=ACTOR,
            data=SalesOrderCreate(
                order_date=date(2026, 2, 10),
                channel=OrderChannel.EBAY,
                buyer_name="Buyer",
                shipping_gross_cents=0,
                payment_source=PaymentSource.BANK,
                lines=[SalesOrderLineCreate(inventory_item_id=item_id, sale_gross_cents=1_900)],
            ),
        )
    async with db_session.begin():
        await finalize_sales_order(db_session, actor=ACTOR, order_id=order.id)

    async with db_session.begin():
        correction = await create_sales_correction(
            db_session,
            actor=ACTOR,
            order_id=order.id,
            data=SalesCorrectionCreate(
                correction_date=date(2026, 2, 11),
                payment_source=PaymentSource.BANK,
                lines=[
                    SalesCorrectionLineCreate(
                        inventory_item_id=item_id,
                        action=ReturnAction.RESTOCK,
                        refund_gross_cents=1_900,
                    )
                ],
            ),
        )

    def fake_render_pdf(*, output_path: Path, **_kwargs) -> None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"pdf")

    monkeypatch.setattr("app.services.sales.render_pdf", fake_render_pdf)
    monkeypatch.setattr("app.services.sales_corrections.render_pdf", fake_render_pdf)

    async with db_session.begin():
        sales_row = await generate_sales_invoice_pdf(db_session, actor=ACTOR, order_id=order.id)
        corr_row = await generate_sales_correction_pdf(db_session, actor=ACTOR, correction_id=correction.id)

    assert sales_row.invoice_pdf_path is not None
    assert corr_row.pdf_path is not None

    settings = get_settings()
    assert (settings.app_storage_dir / sales_row.invoice_pdf_path).exists()
    assert (settings.app_storage_dir / corr_row.pdf_path).exists()

    order_db = await db_session.get(SalesOrder, order.id)
    correction_db = await db_session.get(SalesCorrection, correction.id)
    assert order_db is not None and order_db.invoice_pdf_path == sales_row.invoice_pdf_path
    assert correction_db is not None and correction_db.pdf_path == corr_row.pdf_path


@pytest.mark.asyncio
async def test_reopen_finalized_sales_order_restores_draft_and_allows_refinalize(
    monkeypatch,
    db_session: AsyncSession,
) -> None:
    async with db_session.begin():
        mp = await _create_master_product(db_session, suffix="REOPEN-S")
        purchase = await _create_private_purchase(
            db_session,
            purchase_date=date(2026, 2, 8),
            lines=[(mp.id, 1_000)],
        )

    purchase_row = (
        await db_session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    item_id = (
        await db_session.execute(select(InventoryItem.id).where(InventoryItem.purchase_line_id == purchase_row.lines[0].id))
    ).scalar_one()
    await db_session.rollback()

    async with db_session.begin():
        order = await create_sales_order(
            db_session,
            actor=ACTOR,
            data=SalesOrderCreate(
                order_date=date(2026, 2, 10),
                channel=OrderChannel.EBAY,
                buyer_name="Buyer",
                shipping_gross_cents=0,
                payment_source=PaymentSource.BANK,
                lines=[SalesOrderLineCreate(inventory_item_id=item_id, sale_gross_cents=1_900)],
            ),
        )
    order_id = order.id
    async with db_session.begin():
        finalized = await finalize_sales_order(db_session, actor=ACTOR, order_id=order_id)
    original_invoice_number = finalized.invoice_number
    assert original_invoice_number is not None

    def fake_render_pdf(*, output_path: Path, **_kwargs) -> None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"pdf")

    monkeypatch.setattr("app.services.sales.render_pdf", fake_render_pdf)
    async with db_session.begin():
        with_pdf = await generate_sales_invoice_pdf(db_session, actor=ACTOR, order_id=order_id)
    assert with_pdf.invoice_pdf_path is not None
    settings = get_settings()
    old_pdf_path = settings.app_storage_dir / with_pdf.invoice_pdf_path
    assert old_pdf_path.exists()

    async with db_session.begin():
        reopened = await reopen_sales_order_for_edit(db_session, actor=ACTOR, order_id=order_id)
    assert reopened.status == OrderStatus.DRAFT
    assert reopened.invoice_pdf_path is None
    assert reopened.invoice_number == original_invoice_number
    assert not old_pdf_path.exists()

    item = await db_session.get(InventoryItem, item_id)
    assert item is not None and item.status == InventoryStatus.RESERVED
    await db_session.rollback()

    sale_ledger_rows = (
        await db_session.execute(select(LedgerEntry).where(LedgerEntry.entity_type == "sale", LedgerEntry.entity_id == order_id))
    ).scalars().all()
    assert sale_ledger_rows == []
    await db_session.rollback()

    async with db_session.begin():
        updated = await update_sales_order(
            db_session,
            actor=ACTOR,
            order_id=order_id,
            data=SalesOrderUpdate(
                order_date=date(2026, 2, 11),
                channel=OrderChannel.EBAY,
                buyer_name="Buyer Updated",
                buyer_address="New Address",
                shipping_gross_cents=0,
                payment_source=PaymentSource.BANK,
                lines=[SalesOrderLineCreate(inventory_item_id=item_id, sale_gross_cents=2_000)],
            ),
        )
    assert updated.status == OrderStatus.DRAFT
    assert updated.buyer_name == "Buyer Updated"

    async with db_session.begin():
        finalized_again = await finalize_sales_order(db_session, actor=ACTOR, order_id=order_id)
    assert finalized_again.status == OrderStatus.FINALIZED
    assert finalized_again.invoice_number == original_invoice_number

    sale_ledger = (
        await db_session.execute(select(LedgerEntry).where(LedgerEntry.entity_type == "sale", LedgerEntry.entity_id == order_id))
    ).scalar_one()
    assert sale_ledger.amount_cents == 2_000
