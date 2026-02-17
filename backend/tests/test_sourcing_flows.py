from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlalchemy.orm import selectinload

from app.core.enums import PurchaseKind, SourcingPlatform, SourcingStatus
from app.models.amazon_scrape import AmazonProductMetricsLatest
from app.models.master_product import MasterProduct, master_product_sku_from_id
from app.models.purchase import Purchase
from app.models.sourcing import SourcingItem, SourcingMatch, SourcingRun, SourcingSetting
from app.services.sourcing import (
    _parse_kleinanzeigen_posted_at,
    convert_item_to_purchase,
    execute_sourcing_run,
    load_resolved_settings,
    recalculate_item_from_matches,
    update_settings_values,
)


@pytest.mark.asyncio
async def test_recalculate_item_marks_high_bsr_as_low_value(db_session: AsyncSession) -> None:
    mp_id = uuid.uuid4()
    mp = MasterProduct(
        id=mp_id,
        sku=master_product_sku_from_id(mp_id),
        kind="GAME",
        title="Test Product",
        platform="PS2",
        region="EU",
        variant="",
        asin="B000123456",
    )
    db_session.add(mp)

    item = SourcingItem(
        platform=SourcingPlatform.KLEINANZEIGEN,
        external_id="abc-1",
        url="https://www.kleinanzeigen.de/s-anzeige/abc-1",
        title="Retro Sammlung",
        price_cents=1_000,
        status=SourcingStatus.NEW,
    )
    db_session.add(item)
    await db_session.flush()

    db_session.add(
        SourcingMatch(
            sourcing_item_id=item.id,
            master_product_id=mp.id,
            confidence_score=90,
            match_method="title_fuzzy",
            snapshot_bsr=80_000,
            snapshot_fba_payout_cents=1_500,
        )
    )
    await db_session.flush()

    await recalculate_item_from_matches(session=db_session, item=item, confirmed_only=False)
    await db_session.commit()

    refreshed = await db_session.get(SourcingItem, item.id)
    assert refreshed is not None
    assert refreshed.status == SourcingStatus.LOW_VALUE
    assert refreshed.estimated_profit_cents == 0


@pytest.mark.asyncio
async def test_convert_item_to_purchase_idempotency(db_session: AsyncSession) -> None:
    mp_id = uuid.uuid4()
    mp = MasterProduct(
        id=mp_id,
        sku=master_product_sku_from_id(mp_id),
        kind="GAME",
        title="Mario 64",
        platform="N64",
        region="EU",
        variant="",
        asin="B000FC2BTQ",
    )
    db_session.add(mp)

    item = SourcingItem(
        platform=SourcingPlatform.KLEINANZEIGEN,
        external_id="conv-1",
        url="https://www.kleinanzeigen.de/s-anzeige/conv-1",
        title="N64 Bundle",
        price_cents=8_000,
        status=SourcingStatus.READY,
    )
    db_session.add(item)
    await db_session.flush()

    match = SourcingMatch(
        sourcing_item_id=item.id,
        master_product_id=mp.id,
        confidence_score=92,
        match_method="title_fuzzy",
        snapshot_bsr=4_000,
        snapshot_fba_payout_cents=1_900,
        user_confirmed=True,
    )
    db_session.add(match)
    await db_session.flush()

    cfg = await load_resolved_settings(db_session)
    await db_session.refresh(item)
    item = (
        await db_session.execute(
            select(SourcingItem)
            .where(SourcingItem.id == item.id)
            .options(selectinload(SourcingItem.matches))
        )
    ).scalar_one()

    out = await convert_item_to_purchase(
        session=db_session,
        actor="tester",
        item=item,
        cfg=cfg,
        confirmed_match_ids=[match.id],
    )
    await db_session.commit()

    created_purchase = await db_session.get(Purchase, out.purchase_id)
    assert created_purchase is not None
    assert created_purchase.kind == PurchaseKind.PRIVATE_DIFF

    assert item.status == SourcingStatus.CONVERTED
    assert item.converted_purchase_id == created_purchase.id

    with pytest.raises(ValueError):
        await convert_item_to_purchase(
            session=db_session,
            actor="tester",
            item=item,
            cfg=cfg,
            confirmed_match_ids=[match.id],
        )


@pytest.mark.asyncio
async def test_execute_sourcing_run_skips_when_recent_and_not_forced(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.services.sourcing.SessionLocal", session_factory)

    async with session_factory() as session:
        run = SourcingRun(
            trigger="scheduler",
            platform=SourcingPlatform.KLEINANZEIGEN,
            started_at=datetime.now(UTC),
            finished_at=datetime.now(UTC),
            ok=True,
        )
        session.add(run)
        await session.commit()

    result = await execute_sourcing_run(force=False, search_terms=["nintendo"], trigger="manual")
    assert result.status == "skipped"
    assert result.run_id == run.id


@pytest.mark.asyncio
async def test_update_settings_supports_value_json_and_unique_identity(db_session: AsyncSession) -> None:
    async with db_session.begin():
        await update_settings_values(
            session=db_session,
            values={
                "search_terms": {
                    "value_json": ["videospiele konvolut", "retro spiele sammlung"],
                }
            },
        )

    row = await db_session.get(SourcingSetting, "search_terms")
    assert row is not None
    assert row.value_json == ["videospiele konvolut", "retro spiele sammlung"]

    item1 = SourcingItem(
        platform=SourcingPlatform.KLEINANZEIGEN,
        external_id="uniq-1",
        url="https://www.kleinanzeigen.de/s-anzeige/uniq-1",
        title="Bundle A",
        price_cents=1_000,
    )
    item2 = SourcingItem(
        platform=SourcingPlatform.KLEINANZEIGEN,
        external_id="uniq-1",
        url="https://www.kleinanzeigen.de/s-anzeige/uniq-2",
        title="Bundle B",
        price_cents=2_000,
    )

    db_session.add(item1)
    await db_session.commit()

    db_session.add(item2)
    with pytest.raises(IntegrityError):
        await db_session.commit()


def test_parse_kleinanzeigen_posted_at_relative_and_absolute_formats() -> None:
    now = datetime(2026, 2, 17, 8, 0, tzinfo=UTC)

    today = _parse_kleinanzeigen_posted_at("Heute, 07:53", now=now)
    assert today is not None
    assert today == datetime(2026, 2, 17, 6, 53, tzinfo=UTC)

    yesterday = _parse_kleinanzeigen_posted_at("Gestern, 23:10", now=now)
    assert yesterday is not None
    assert yesterday == datetime(2026, 2, 16, 22, 10, tzinfo=UTC)

    absolute = _parse_kleinanzeigen_posted_at("13.02.2026, 21:30", now=now)
    assert absolute is not None
    assert absolute == datetime(2026, 2, 13, 20, 30, tzinfo=UTC)

    absolute_no_time = _parse_kleinanzeigen_posted_at("13.02.2026", now=now)
    assert absolute_no_time is not None
    assert absolute_no_time == datetime(2026, 2, 12, 23, 0, tzinfo=UTC)


@pytest.mark.asyncio
async def test_execute_sourcing_run_enriches_detail_payload(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with session_factory() as session:
        mp_id = uuid.uuid4()
        session.add(
            MasterProduct(
                id=mp_id,
                sku=master_product_sku_from_id(mp_id),
                kind="GAME",
                title="Nintendo Switch Konsole",
                platform="SWITCH",
                region="EU",
                variant="",
                asin="B08NINTENDO",
            )
        )
        await session.flush()
        session.add(
            AmazonProductMetricsLatest(
                master_product_id=mp_id,
                last_attempt_at=datetime.now(UTC),
                last_success_at=datetime.now(UTC),
                rank_overall=1500,
                price_used_good_cents=10000,
                price_used_acceptable_cents=9800,
            )
        )
        await session.commit()

    async def _fake_scrape_fetch(*, app_settings, search_terms):  # noqa: ARG001
        return {
            "blocked": False,
            "error_type": None,
            "error_message": None,
            "listings": [
                {
                    "external_id": "detail-1",
                    "title": "Nintendo Switch Konsole",
                    "description": "Kurztext",
                    "price_cents": 1000,
                    "url": "https://www.kleinanzeigen.de/s-anzeige/nintendo-switch-konsole/123-279-1",
                    "image_urls": ["https://img.kleinanzeigen.de/a.jpg"],
                    "primary_image_url": "https://img.kleinanzeigen.de/a.jpg",
                    "location_zip": "10115",
                    "location_city": "Berlin",
                    "seller_type": "private",
                    "posted_at_text": "Heute, 07:53",
                }
            ],
        }

    async def _fake_detail_fetch(*, app_settings, url):  # noqa: ARG001
        return {
            "blocked": False,
            "error_type": None,
            "error_message": None,
            "listing": {
                "description_full": "Lange Beschreibung mit Lieferumfang und Zustand.",
                "posted_at_text": "Heute, 07:53",
                "image_urls": [
                    "https://img.kleinanzeigen.de/a.jpg",
                    "https://img.kleinanzeigen.de/b.jpg",
                ],
                "image_count": 2,
                "shipping_possible": True,
                "direct_buy": False,
                "view_count": 321,
                "seller_name": "Max Mustermann",
            },
        }

    monkeypatch.setattr("app.services.sourcing.SessionLocal", session_factory)
    monkeypatch.setattr("app.services.sourcing._scraper_fetch", _fake_scrape_fetch)
    monkeypatch.setattr("app.services.sourcing._scraper_fetch_listing_detail", _fake_detail_fetch)

    result = await execute_sourcing_run(force=True, search_terms=["nintendo"], trigger="test")
    assert result.items_new == 1

    async with session_factory() as session:
        item = (
            await session.execute(
                select(SourcingItem).where(SourcingItem.external_id == "detail-1")
            )
        ).scalar_one()
        assert item.status == SourcingStatus.READY
        assert item.description == "Lange Beschreibung mit Lieferumfang und Zustand."
        assert item.posted_at is not None
        assert item.image_urls is not None and len(item.image_urls) == 2
        assert isinstance(item.raw_data, dict)
        assert item.raw_data.get("view_count") == 321
        assert item.raw_data.get("seller_name") == "Max Mustermann"
