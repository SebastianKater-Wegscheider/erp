from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.config import get_settings
from app.core.enums import SourcingEvaluationStatus, SourcingPlatform, SourcingStatus
from app.models.sourcing import SourcingItem, SourcingRun
from app.services.sourcing import _parse_kleinanzeigen_posted_at, execute_sourcing_run
from app.services.sourcing_codex import (
    PROMPT_VERSION,
    _build_codex_command,
    _workspace_for_item,
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
    assert summary["task"]["rules"][0] == "Do not fetch the marketplace listing URL."
    assert full["listing"]["raw_data"]["shipping_possible"] is True
    assert workspace.prompt_path.read_text(encoding="utf-8")


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
                "amazon_source_used": "db_cache",
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
