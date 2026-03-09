from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.config import get_settings
from app.core.enums import InventoryCondition, InventoryStatus, PurchaseType, SourcingEvaluationStatus, SourcingPlatform, SourcingStatus
from app.models.amazon_scrape import AmazonProductMetricsLatest
from app.models.inventory_item import InventoryItem
from app.models.master_product import MasterProduct
from app.models.sourcing import SourcingItem, SourcingRun
from app.services.sourcing import _parse_kleinanzeigen_posted_at, execute_sourcing_run
from app.services.sourcing_codex import (
    PROMPT_VERSION,
    _build_codex_command,
    _workspace_for_item,
    claim_next_pending_item,
    evaluate_item_by_id,
    stage_workspace,
)


def _write_stub_codex(path: Path, payload: str) -> None:
    path.write_text(
        "\n".join(
            [
                "#!/usr/bin/env python3",
                "import sys",
                "from pathlib import Path",
                "",
                "args = sys.argv[1:]",
                "out = None",
                "for idx, value in enumerate(args):",
                "    if value == '--output-last-message':",
                "        out = Path(args[idx + 1])",
                "        break",
                "if out is None:",
                "    raise SystemExit('missing --output-last-message')",
                f"out.write_text({payload!r}, encoding='utf-8')",
                "sys.exit(0)",
            ]
        ),
        encoding="utf-8",
    )
    path.chmod(0o755)


def _write_fake_codex_auth(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "auth.json").write_text('{"provider":"chatgpt"}', encoding="utf-8")


def _write_fake_codex_config(path: Path, *, model: str = "gpt-5.4", reasoning_effort: str = "low") -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "config.toml").write_text(
        "\n".join(
            [
                f'model = "{model}"',
                f'model_reasoning_effort = "{reasoning_effort}"',
            ]
        )
        + "\n",
        encoding="utf-8",
    )


@pytest.mark.asyncio
async def test_execute_sourcing_run_enqueues_new_items_after_detail_enrichment(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.services.sourcing.SessionLocal", session_factory)

    async def _fake_scrape_fetch(*, app_settings, platform, search_terms, options=None, max_pages=None):  # noqa: ARG001
        return {
            "blocked": False,
            "error_type": None,
            "error_message": None,
            "listings": [
                {
                    "external_id": "listing-1",
                    "title": "Gamecube Konvolut",
                    "description": "Kurzbeschreibung",
                    "price_cents": 9500,
                    "url": "https://www.kleinanzeigen.de/s-anzeige/listing-1",
                    "location_city": "Wien",
                    "seller_type": "private",
                    "posted_at_text": "Heute, 07:53",
                }
            ],
        }

    async def _fake_listing_detail(*, app_settings, platform, url):  # noqa: ARG001
        return {
            "blocked": False,
            "listing": {
                "description_full": "Ausführliche Beschreibung mit allen relevanten Details",
                "image_urls": ["https://img.example/1.jpg"],
                "seller_type": "private",
                "price_cents": 9300,
            },
        }

    monkeypatch.setattr("app.services.sourcing._scraper_fetch", _fake_scrape_fetch)
    monkeypatch.setattr("app.services.sourcing._scraper_fetch_listing_detail", _fake_listing_detail)

    result = await execute_sourcing_run(
        force=True,
        search_terms=["gamecube"],
        trigger="test",
        platform=SourcingPlatform.KLEINANZEIGEN,
    )

    assert result.status == "completed"
    assert result.items_new == 1
    assert result.items_queued == 1

    async with session_factory() as session:
        item = (await session.execute(select(SourcingItem))).scalar_one()
        assert item.description == "Ausführliche Beschreibung mit allen relevanten Details"
        assert item.price_cents == 9300
        assert item.evaluation_status == SourcingEvaluationStatus.PENDING
        assert item.evaluation_queued_at is not None
        assert item.evaluation_prompt_version == PROMPT_VERSION
        assert item.status == SourcingStatus.NEW


@pytest.mark.asyncio
async def test_stage_workspace_writes_summary_and_full_payloads(
    db_session: AsyncSession,
) -> None:
    product = MasterProduct(
        title="Super Mario Sunshine",
        platform="Nintendo GameCube",
        region="PAL",
        variant="Player's Choice",
        asin="B000123456",
        ean="0045496961025",
    )
    db_session.add(product)
    await db_session.flush()
    db_session.add(
        AmazonProductMetricsLatest(
            master_product_id=product.id,
            last_attempt_at=datetime.now(UTC),
            last_success_at=datetime.now(UTC),
            rank_overall=1234,
            price_new_cents=4999,
            price_used_good_cents=3299,
            buybox_total_cents=4599,
            offers_count_total=7,
            offers_count_used_priced_total=4,
        )
    )
    item = SourcingItem(
        platform=SourcingPlatform.KLEINANZEIGEN,
        external_id="workspace-1",
        url="https://www.kleinanzeigen.de/s-anzeige/workspace-1",
        title="Nintendo Gamecube Paket",
        description="Kurztext",
        price_cents=12000,
        raw_data={"shipping_possible": True, "direct_buy": False},
    )
    db_session.add(item)
    await db_session.commit()

    workspace = await stage_workspace(session=db_session, item=item, settings=get_settings())

    summary = json.loads(workspace.summary_path.read_text(encoding="utf-8"))
    full = json.loads(workspace.full_path.read_text(encoding="utf-8"))

    assert summary["listing"]["title"] == "Nintendo Gamecube Paket"
    assert "Do not fetch the marketplace listing URL." in summary["task"]["rules"]
    assert summary["erp_context"]["catalog_total_products"] == 1
    assert "candidate_products" not in summary["erp_context"]
    assert summary["erp_context"]["known_product_catalog"][0]["title"] == "Super Mario Sunshine"
    assert summary["erp_context"]["known_product_catalog"][0]["amazon_cached"]["best_used_price_cents"] == 3299
    assert full["listing"]["raw_data"]["shipping_possible"] is True
    prompt = workspace.prompt_path.read_text(encoding="utf-8")
    assert "summary.json:" in prompt
    assert "full.json:" in prompt
    assert "Do not use live web search in this first pass." in prompt
    assert "Do not assume the ERP catalog has already been filtered down to likely matches." in prompt


@pytest.mark.asyncio
async def test_evaluate_item_by_id_persists_structured_codex_result(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    stub = tmp_path / "codex-success"
    auth_dir = tmp_path / "codex-auth"
    _write_stub_codex(
        stub,
        json.dumps(
            {
                "recommendation": "BUY",
                "summary": "Strong margin after cached Amazon comparison.",
                "expected_profit_cents": 4200,
                "expected_roi_bp": 3800,
                "max_buy_price_cents": 10800,
                "confidence": 84,
                "amazon_source_used": "erp_context.known_product_catalog[].amazon_cached",
                "matched_products": [
                    {
                        "master_product_id": None,
                        "sku": "MP-TEST",
                        "title": "Gamecube Bundle",
                        "asin": "B000123456",
                        "confidence": 82,
                        "basis": "title + cached amazon data",
                    }
                ],
                "risks": ["Condition may vary"],
                "reasoning_notes": ["Cached Amazon metrics were fresh enough."],
            }
        ),
    )
    _write_fake_codex_auth(auth_dir)

    monkeypatch.setenv("CODEX_ENABLED", "true")
    monkeypatch.setenv("CODEX_BINARY_PATH", str(stub))
    monkeypatch.setenv("CODEX_AUTH_SOURCE_DIR", str(auth_dir))
    get_settings.cache_clear()

    item = SourcingItem(
        platform=SourcingPlatform.KLEINANZEIGEN,
        external_id="eval-1",
        url="https://www.kleinanzeigen.de/s-anzeige/eval-1",
        title="Gamecube Bundle",
        description="Bundle",
        price_cents=6500,
        raw_data={"shipping_possible": True},
        evaluation_status=SourcingEvaluationStatus.PENDING,
    )
    db_session.add(item)
    await db_session.commit()

    await evaluate_item_by_id(session=db_session, item_id=item.id, settings=get_settings())
    await db_session.commit()

    refreshed = await db_session.get(SourcingItem, item.id)
    assert refreshed is not None
    assert refreshed.evaluation_status == SourcingEvaluationStatus.COMPLETED
    assert refreshed.recommendation == "BUY"
    assert refreshed.expected_profit_cents == 4200
    assert refreshed.max_buy_price_cents == 10800
    assert refreshed.evaluation_summary == "Strong margin after cached Amazon comparison."
    assert refreshed.amazon_source_used == "cached"
    assert refreshed.evaluation_result_json is not None
    assert (
        get_settings().app_storage_dir
        / "sourcing-evals"
        / str(item.id)
        / ".codex-home"
        / ".codex"
        / "auth.json"
    ).exists()
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_evaluate_item_by_id_marks_failed_on_invalid_codex_json(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    stub = tmp_path / "codex-invalid"
    auth_dir = tmp_path / "codex-auth"
    _write_stub_codex(stub, "{not valid json")
    _write_fake_codex_auth(auth_dir)

    monkeypatch.setenv("CODEX_ENABLED", "true")
    monkeypatch.setenv("CODEX_BINARY_PATH", str(stub))
    monkeypatch.setenv("CODEX_AUTH_SOURCE_DIR", str(auth_dir))
    get_settings.cache_clear()

    item = SourcingItem(
        platform=SourcingPlatform.EBAY_DE,
        external_id="eval-fail-1",
        url="https://www.ebay.de/itm/1234567890",
        title="Nintendo Konsole",
        price_cents=10000,
        evaluation_status=SourcingEvaluationStatus.PENDING,
    )
    db_session.add(item)
    await db_session.commit()

    with pytest.raises(RuntimeError, match="Invalid Codex response"):
        await evaluate_item_by_id(session=db_session, item_id=item.id, settings=get_settings())
    await db_session.commit()

    refreshed = await db_session.get(SourcingItem, item.id)
    assert refreshed is not None
    assert refreshed.evaluation_status == SourcingEvaluationStatus.FAILED
    assert refreshed.status == SourcingStatus.ERROR
    assert refreshed.evaluation_last_error is not None
    get_settings.cache_clear()


def test_build_codex_command_uses_feature_override_instead_of_search_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CODEX_SEARCH_ENABLED", "true")
    get_settings.cache_clear()

    command = _build_codex_command(
        get_settings(),
        _workspace_for_item(get_settings(), "command-test"),
    )

    assert "--search" not in command
    assert "features.search_tool=true" in command
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_evaluate_item_stages_minimal_runtime_config_from_source_codex_config(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    stub = tmp_path / "codex-success"
    auth_dir = tmp_path / "codex-auth"
    _write_stub_codex(
        stub,
        json.dumps(
            {
                "recommendation": "WATCH",
                "summary": "Config smoke test.",
                "expected_profit_cents": None,
                "expected_roi_bp": None,
                "max_buy_price_cents": None,
                "confidence": 50,
                "amazon_source_used": "cached",
                "matched_products": [],
                "risks": [],
                "reasoning_notes": [],
            }
        ),
    )
    _write_fake_codex_auth(auth_dir)
    _write_fake_codex_config(auth_dir, model="gpt-5.4", reasoning_effort="low")

    monkeypatch.setenv("CODEX_ENABLED", "true")
    monkeypatch.setenv("CODEX_BINARY_PATH", str(stub))
    monkeypatch.setenv("CODEX_AUTH_SOURCE_DIR", str(auth_dir))
    monkeypatch.delenv("CODEX_MODEL", raising=False)
    monkeypatch.delenv("CODEX_REASONING_EFFORT", raising=False)
    monkeypatch.setenv("CODEX_SEARCH_ENABLED", "false")
    get_settings.cache_clear()

    item = SourcingItem(
        platform=SourcingPlatform.KLEINANZEIGEN,
        external_id="eval-config-1",
        url="https://www.kleinanzeigen.de/s-anzeige/eval-config-1",
        title="Nintendo Bundle",
        price_cents=7500,
        evaluation_status=SourcingEvaluationStatus.PENDING,
    )
    db_session.add(item)
    await db_session.commit()

    await evaluate_item_by_id(session=db_session, item_id=item.id, settings=get_settings())
    await db_session.commit()

    runtime_config = (
        get_settings().app_storage_dir
        / "sourcing-evals"
        / str(item.id)
        / ".codex-home"
        / ".codex"
        / "config.toml"
    ).read_text(encoding="utf-8")
    assert 'model = "gpt-5.4"' in runtime_config
    assert 'model_reasoning_effort = "low"' in runtime_config
    assert "search_tool = false" in runtime_config
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_claim_next_pending_item_requeues_stale_running_rows(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CODEX_TIMEOUT_SECONDS", "60")
    get_settings.cache_clear()

    stale_item = SourcingItem(
        platform=SourcingPlatform.KLEINANZEIGEN,
        external_id="stale-run-1",
        url="https://www.kleinanzeigen.de/s-anzeige/stale-run-1",
        title="Stale Run",
        price_cents=1000,
        evaluation_status=SourcingEvaluationStatus.RUNNING,
        evaluation_started_at=datetime.now(UTC) - timedelta(seconds=120),
        evaluation_attempt_count=0,
        status=SourcingStatus.NEW,
    )
    fresh_item = SourcingItem(
        platform=SourcingPlatform.KLEINANZEIGEN,
        external_id="pending-run-1",
        url="https://www.kleinanzeigen.de/s-anzeige/pending-run-1",
        title="Pending Run",
        price_cents=1200,
        evaluation_status=SourcingEvaluationStatus.PENDING,
        evaluation_attempt_count=0,
        status=SourcingStatus.NEW,
    )
    db_session.add_all([stale_item, fresh_item])
    await db_session.commit()

    claimed_id = await claim_next_pending_item(db_session, settings=get_settings())
    await db_session.commit()

    refreshed_stale = await db_session.get(SourcingItem, stale_item.id)
    refreshed_fresh = await db_session.get(SourcingItem, fresh_item.id)
    assert refreshed_stale is not None
    assert refreshed_fresh is not None
    assert claimed_id == stale_item.id
    assert refreshed_stale.evaluation_status == SourcingEvaluationStatus.RUNNING
    assert refreshed_stale.evaluation_attempt_count == 1
    assert refreshed_stale.evaluation_last_error is None
    assert refreshed_fresh.evaluation_status == SourcingEvaluationStatus.PENDING
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_requeue_endpoint_marks_item_pending_again(db_session: AsyncSession) -> None:
    from app.api.v1.endpoints.sourcing import requeue_sourcing_evaluation

    item = SourcingItem(
        platform=SourcingPlatform.KLEINANZEIGEN,
        external_id="requeue-1",
        url="https://www.kleinanzeigen.de/s-anzeige/requeue-1",
        title="Bundle",
        price_cents=5000,
        evaluation_status=SourcingEvaluationStatus.FAILED,
        evaluation_last_error="old error",
        status=SourcingStatus.ERROR,
    )
    db_session.add(item)
    await db_session.commit()

    out = await requeue_sourcing_evaluation(item.id, session=db_session, _actor="tester")

    assert out.item_id == item.id
    refreshed = await db_session.get(SourcingItem, item.id)
    assert refreshed is not None
    assert refreshed.evaluation_status == SourcingEvaluationStatus.PENDING
    assert refreshed.evaluation_last_error is None
    assert refreshed.status == SourcingStatus.NEW


@pytest.mark.asyncio
async def test_sourcing_health_and_stats_use_evaluation_counts(db_session: AsyncSession) -> None:
    from app.api.v1.endpoints.sourcing import sourcing_health, sourcing_stats

    db_session.add(
        SourcingRun(
            trigger="scheduler",
            platform=SourcingPlatform.KLEINANZEIGEN,
            started_at=datetime.now(UTC),
            finished_at=datetime.now(UTC),
            ok=True,
        )
    )
    db_session.add_all(
        [
            SourcingItem(
                platform=SourcingPlatform.KLEINANZEIGEN,
                external_id="stats-1",
                url="https://www.kleinanzeigen.de/s-anzeige/stats-1",
                title="Bundle 1",
                price_cents=1000,
                evaluation_status=SourcingEvaluationStatus.PENDING,
            ),
            SourcingItem(
                platform=SourcingPlatform.KLEINANZEIGEN,
                external_id="stats-2",
                url="https://www.kleinanzeigen.de/s-anzeige/stats-2",
                title="Bundle 2",
                price_cents=2000,
                evaluation_status=SourcingEvaluationStatus.COMPLETED,
                recommendation="BUY",
            ),
            SourcingItem(
                platform=SourcingPlatform.EBAY_DE,
                external_id="stats-3",
                url="https://www.ebay.de/itm/stats-3",
                title="Bundle 3",
                price_cents=3000,
                evaluation_status=SourcingEvaluationStatus.FAILED,
                status=SourcingStatus.ERROR,
            ),
        ]
    )
    await db_session.commit()

    health = await sourcing_health(session=db_session)
    stats = await sourcing_stats(session=db_session)

    assert health.items_pending_evaluation == 1
    assert health.items_failed_evaluation == 1
    assert stats.items_by_evaluation_status["PENDING"] == 1
    assert stats.items_by_evaluation_status["FAILED"] == 1
    assert stats.items_by_recommendation["BUY"] == 1


@pytest.mark.asyncio
async def test_sourcing_review_latest_packet_returns_items_and_catalog(db_session: AsyncSession) -> None:
    from app.api.v1.endpoints.sourcing import sourcing_review_latest_packet

    run = SourcingRun(
        trigger="manual",
        platform=SourcingPlatform.KLEINANZEIGEN,
        started_at=datetime.now(UTC),
        finished_at=datetime.now(UTC),
        ok=True,
        items_scraped=12,
        items_new=8,
    )
    db_session.add(run)
    await db_session.flush()

    product = MasterProduct(
        title="Super Mario Sunshine",
        platform="Nintendo GameCube",
        region="PAL",
        variant="",
        asin="B000123456",
    )
    db_session.add(product)
    await db_session.flush()
    db_session.add(
        AmazonProductMetricsLatest(
            master_product_id=product.id,
            last_attempt_at=datetime.now(UTC),
            last_success_at=datetime.now(UTC),
            rank_overall=4321,
            price_used_good_cents=3399,
            buybox_total_cents=4599,
            offers_count_total=6,
            offers_count_used_priced_total=4,
        )
    )
    db_session.add(
        InventoryItem(
            master_product_id=product.id,
            condition=InventoryCondition.GOOD,
            purchase_type=PurchaseType.DIFF,
            purchase_price_cents=1500,
            allocated_costs_cents=0,
            status=InventoryStatus.AVAILABLE,
        )
    )
    db_session.add(
        SourcingItem(
            platform=SourcingPlatform.KLEINANZEIGEN,
            external_id="review-item-1",
            url="https://www.kleinanzeigen.de/s-anzeige/review-item-1",
            title="Mario Sunshine Bundle",
            description="Beschreibung",
            price_cents=2500,
            raw_data={"shipping_possible": True},
            last_run_id=run.id,
            evaluation_status=SourcingEvaluationStatus.COMPLETED,
            recommendation="WATCH",
            evaluation_result_json={
                "recommendation": "WATCH",
                "summary": "Interesting but needs manual check.",
                "expected_profit_cents": 1200,
                "expected_roi_bp": 4000,
                "max_buy_price_cents": 3100,
                "confidence": 70,
                "amazon_source_used": "cached",
                "matched_products": [],
                "risks": [],
                "reasoning_notes": [],
            },
            evaluation_summary="Interesting but needs manual check.",
        )
    )
    await db_session.commit()

    packet = await sourcing_review_latest_packet(
        platform=SourcingPlatform.KLEINANZEIGEN,
        limit=10,
        in_stock_only=False,
        session=db_session,
    )

    assert packet.latest_run is not None
    assert packet.latest_run.id == run.id
    assert len(packet.items) == 1
    assert packet.items[0].title == "Mario Sunshine Bundle"
    assert packet.items[0].external_id == "review-item-1"
    assert packet.items[0].raw_data == {"shipping_possible": True}
    assert len(packet.catalog) == 1
    assert packet.catalog[0].title == "Super Mario Sunshine"
    assert packet.catalog[0].in_stock_count == 1
    assert packet.catalog[0].amazon_cached.buybox_total_cents == 4599


@pytest.mark.asyncio
async def test_sourcing_review_packet_hides_stale_evaluation_for_non_completed_items(db_session: AsyncSession) -> None:
    from app.api.v1.endpoints.sourcing import sourcing_review_latest_packet

    run = SourcingRun(
        trigger="manual",
        platform=SourcingPlatform.KLEINANZEIGEN,
        started_at=datetime.now(UTC),
        finished_at=datetime.now(UTC),
        ok=True,
        items_scraped=1,
        items_new=1,
    )
    db_session.add(run)
    await db_session.flush()

    item = SourcingItem(
        platform=SourcingPlatform.KLEINANZEIGEN,
        external_id="review-item-stale",
        url="https://www.kleinanzeigen.de/s-anzeige/review-item-stale",
        title="Ambiguous Bundle",
        price_cents=1234,
        last_run_id=run.id,
        evaluation_status=SourcingEvaluationStatus.FAILED,
        recommendation="SKIP",
        evaluation_summary="Old summary",
        expected_profit_cents=-100,
        expected_roi_bp=-200,
        max_buy_price_cents=0,
        evaluation_confidence=12,
        amazon_source_used="cached",
        evaluation_result_json={
            "recommendation": "SKIP",
            "summary": "Old nested payload",
            "expected_profit_cents": -100,
            "expected_roi_bp": -200,
            "max_buy_price_cents": 0,
            "confidence": 12,
            "amazon_source_used": "cached",
            "matched_products": [],
            "risks": [],
            "reasoning_notes": [],
        },
        evaluation_last_error="Timed out",
    )
    db_session.add(item)
    await db_session.commit()

    packet = await sourcing_review_latest_packet(
        platform=SourcingPlatform.KLEINANZEIGEN,
        limit=10,
        in_stock_only=False,
        session=db_session,
    )

    assert len(packet.items) == 1
    out = packet.items[0]
    assert out.evaluation_status == SourcingEvaluationStatus.FAILED
    assert out.recommendation is None
    assert out.evaluation_summary is None
    assert out.expected_profit_cents is None
    assert out.max_buy_price_cents is None
    assert out.evaluation_confidence is None
    assert out.amazon_source_used is None
    assert out.evaluation is None


@pytest.mark.asyncio
async def test_sourcing_review_packet_refreshes_missing_detail_context(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.api.v1.endpoints.sourcing import sourcing_review_latest_packet

    run = SourcingRun(
        trigger="manual",
        platform=SourcingPlatform.KLEINANZEIGEN,
        started_at=datetime.now(UTC),
        finished_at=datetime.now(UTC),
        ok=True,
        items_scraped=1,
        items_new=0,
    )
    db_session.add(run)
    await db_session.flush()

    item = SourcingItem(
        platform=SourcingPlatform.KLEINANZEIGEN,
        external_id="review-item-detail",
        url="https://www.kleinanzeigen.de/s-anzeige/review-item-detail",
        title="Detail Candidate",
        description="Kurzbeschreibung...",
        price_cents=4500,
        image_urls=["https://img.example/thumb.jpg"],
        primary_image_url="https://img.example/thumb.jpg",
        raw_data={"description": "Kurzbeschreibung..."},
        last_run_id=run.id,
        evaluation_status=SourcingEvaluationStatus.PENDING,
    )
    db_session.add(item)
    await db_session.commit()

    async def _fake_listing_detail(*, app_settings, platform, url):  # noqa: ARG001
        return {
            "listing": {
                "description_full": "Volle Beschreibung mit Zustand, Lieferumfang und Besonderheiten.",
                "image_urls": [
                    "https://img.example/1.jpg",
                    "https://img.example/2.jpg",
                ],
                "seller_type": "private",
                "price_cents": 4300,
            }
        }

    monkeypatch.setattr("app.api.v1.endpoints.sourcing._scraper_fetch_listing_detail", _fake_listing_detail)

    packet = await sourcing_review_latest_packet(
        platform=SourcingPlatform.KLEINANZEIGEN,
        limit=10,
        in_stock_only=False,
        ensure_detail=True,
        session=db_session,
    )

    assert len(packet.items) == 1
    out = packet.items[0]
    assert out.description == "Volle Beschreibung mit Zustand, Lieferumfang und Besonderheiten."
    assert out.image_urls == [
        "https://img.example/1.jpg",
        "https://img.example/2.jpg",
    ]
    assert out.primary_image_url == "https://img.example/1.jpg"
    assert out.price_cents == 4300
    assert out.seller_type == "private"
    assert out.raw_data is not None
    assert out.raw_data["description_full"] == "Volle Beschreibung mit Zustand, Lieferumfang und Besonderheiten."
    assert out.raw_data["detail_enriched_at"]


@pytest.mark.asyncio
async def test_sourcing_review_packet_refreshes_incomplete_prior_detail_enrichment(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.api.v1.endpoints.sourcing import sourcing_review_latest_packet

    run = SourcingRun(
        trigger="manual",
        platform=SourcingPlatform.KLEINANZEIGEN,
        started_at=datetime.now(UTC),
        finished_at=datetime.now(UTC),
        ok=True,
        items_scraped=1,
        items_new=0,
    )
    db_session.add(run)
    await db_session.flush()

    item = SourcingItem(
        platform=SourcingPlatform.KLEINANZEIGEN,
        external_id="review-item-detail-stale",
        url="https://www.kleinanzeigen.de/s-anzeige/review-item-detail-stale",
        title="Detail Candidate",
        description="Kurzbeschreibung...",
        price_cents=4500,
        image_urls=["https://img.example/thumb.jpg"],
        primary_image_url="https://img.example/thumb.jpg",
        raw_data={
            "description_full": None,
            "posted_at_text": "02.08.2025",
            "image_urls": ["https://img.example/thumb.jpg"],
            "detail_enriched_at": "2026-03-09T12:00:00+00:00",
        },
        last_run_id=run.id,
        evaluation_status=SourcingEvaluationStatus.PENDING,
    )
    db_session.add(item)
    await db_session.commit()

    async def _fake_listing_detail(*, app_settings, platform, url):  # noqa: ARG001
        return {
            "listing": {
                "description_full": "Volle Beschreibung aus nachgezogener Detailabfrage.",
                "image_urls": [
                    "https://img.example/1.jpg",
                    "https://img.example/2.jpg",
                ],
                "seller_type": "private",
                "price_cents": 4300,
                "posted_at_text": "02.08.2025",
            }
        }

    monkeypatch.setattr("app.api.v1.endpoints.sourcing._scraper_fetch_listing_detail", _fake_listing_detail)

    packet = await sourcing_review_latest_packet(
        platform=SourcingPlatform.KLEINANZEIGEN,
        limit=10,
        in_stock_only=False,
        ensure_detail=True,
        session=db_session,
    )

    assert len(packet.items) == 1
    out = packet.items[0]
    assert out.description == "Volle Beschreibung aus nachgezogener Detailabfrage."
    assert out.raw_data is not None
    assert out.raw_data["description_full"] == "Volle Beschreibung aus nachgezogener Detailabfrage."


@pytest.mark.asyncio
async def test_sourcing_review_packet_dedupes_image_variants_in_output(db_session: AsyncSession) -> None:
    from app.api.v1.endpoints.sourcing import sourcing_review_latest_packet

    run = SourcingRun(
        trigger="manual",
        platform=SourcingPlatform.KLEINANZEIGEN,
        started_at=datetime.now(UTC),
        finished_at=datetime.now(UTC),
        ok=True,
        items_scraped=1,
        items_new=0,
    )
    db_session.add(run)
    await db_session.flush()

    item = SourcingItem(
        platform=SourcingPlatform.KLEINANZEIGEN,
        external_id="review-item-images",
        url="https://www.kleinanzeigen.de/s-anzeige/review-item-images",
        title="Image Variant Bundle",
        description="Beschreibung vollständig",
        price_cents=1234,
        image_urls=[
            "https://img.kleinanzeigen.de/api/v1/prod-ads/images/04/asset-a?rule=$_59.AUTO",
            "https://img.kleinanzeigen.de/api/v1/prod-ads/images/04/asset-a?rule=$_59.JPG",
            "https://img.kleinanzeigen.de/api/v1/prod-ads/images/05/asset-b?rule=$_35.AUTO",
            "https://img.kleinanzeigen.de/api/v1/prod-ads/images/05/asset-b?rule=$_57.AUTO",
        ],
        raw_data={
            "posted_at_text": "02.08.2025",
            "description_full": "Beschreibung vollständig",
            "image_urls": [
                "https://img.kleinanzeigen.de/api/v1/prod-ads/images/04/asset-a?rule=$_59.AUTO",
                "https://img.kleinanzeigen.de/api/v1/prod-ads/images/04/asset-a?rule=$_59.JPG",
                "https://img.kleinanzeigen.de/api/v1/prod-ads/images/05/asset-b?rule=$_35.AUTO",
                "https://img.kleinanzeigen.de/api/v1/prod-ads/images/05/asset-b?rule=$_57.AUTO",
            ],
        },
        last_run_id=run.id,
        evaluation_status=SourcingEvaluationStatus.PENDING,
    )
    db_session.add(item)
    await db_session.commit()

    packet = await sourcing_review_latest_packet(
        platform=SourcingPlatform.KLEINANZEIGEN,
        limit=10,
        in_stock_only=False,
        ensure_detail=False,
        session=db_session,
    )

    out = packet.items[0]
    assert out.image_urls == [
        "https://img.kleinanzeigen.de/api/v1/prod-ads/images/04/asset-a?rule=$_59.JPG",
        "https://img.kleinanzeigen.de/api/v1/prod-ads/images/05/asset-b?rule=$_57.AUTO",
    ]
    assert out.primary_image_url == "https://img.kleinanzeigen.de/api/v1/prod-ads/images/04/asset-a?rule=$_59.JPG"
    assert out.raw_data is not None
    assert out.raw_data["image_urls"] == [
        "https://img.kleinanzeigen.de/api/v1/prod-ads/images/04/asset-a?rule=$_59.JPG",
        "https://img.kleinanzeigen.de/api/v1/prod-ads/images/05/asset-b?rule=$_57.AUTO",
    ]


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
