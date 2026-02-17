from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.enums import SourcingPlatform
from app.models.sourcing import SourcingAgent, SourcingAgentQuery
from app.services import sourcing_scheduler


@pytest.mark.asyncio
async def test_load_due_agents_returns_only_enabled_due_agents(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.services.sourcing_scheduler.SessionLocal", session_factory)

    now = datetime.now(UTC)
    async with session_factory() as session:
        due = SourcingAgent(
            name="Due",
            enabled=True,
            interval_seconds=21_600,
            next_run_at=now - timedelta(minutes=1),
        )
        future = SourcingAgent(
            name="Future",
            enabled=True,
            interval_seconds=21_600,
            next_run_at=now + timedelta(hours=2),
        )
        disabled = SourcingAgent(
            name="Disabled",
            enabled=False,
            interval_seconds=21_600,
            next_run_at=now - timedelta(minutes=1),
        )
        session.add_all([due, future, disabled])
        await session.flush()

        session.add(
            SourcingAgentQuery(
                agent_id=due.id,
                platform=SourcingPlatform.KLEINANZEIGEN,
                keyword="nintendo",
                enabled=True,
            )
        )
        await session.commit()

    due_agents = await sourcing_scheduler._load_due_agents()
    assert [agent.name for agent in due_agents] == ["Due"]


@pytest.mark.asyncio
async def test_mark_agent_run_success_updates_next_run(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.services.sourcing_scheduler.SessionLocal", session_factory)

    async with session_factory() as session:
        agent = SourcingAgent(
            name="Runner",
            enabled=True,
            interval_seconds=21_600,
            next_run_at=datetime.now(UTC) - timedelta(minutes=10),
        )
        session.add(agent)
        await session.commit()
        agent_id = agent.id

    await sourcing_scheduler._mark_agent_run_success(agent_id=agent_id)

    async with session_factory() as session:
        refreshed = await session.get(SourcingAgent, agent_id)
        assert refreshed is not None
        assert refreshed.last_run_at is not None
        assert refreshed.next_run_at is not None
        assert refreshed.next_run_at > refreshed.last_run_at
        assert refreshed.last_error_type is None
        assert refreshed.last_error_message is None


@pytest.mark.asyncio
async def test_run_agent_queries_executes_enabled_queries_only(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict] = []

    async def _fake_execute(**kwargs):
        calls.append(kwargs)

    monkeypatch.setattr("app.services.sourcing_scheduler.execute_sourcing_run", _fake_execute)

    agent = SourcingAgent(
        id=uuid.uuid4(),
        name="Test",
        enabled=True,
        interval_seconds=21_600,
    )
    agent.queries = [
        SourcingAgentQuery(
            id=uuid.uuid4(),
            agent_id=agent.id,
            platform=SourcingPlatform.KLEINANZEIGEN,
            keyword="nintendo",
            enabled=True,
            max_pages=3,
            detail_enrichment_enabled=True,
        ),
        SourcingAgentQuery(
            id=uuid.uuid4(),
            agent_id=agent.id,
            platform=SourcingPlatform.EBAY_DE,
            keyword="switch",
            enabled=False,
            max_pages=2,
            detail_enrichment_enabled=False,
        ),
    ]

    class _FakeSettings:
        pass

    await sourcing_scheduler._run_agent_queries(agent=agent, settings=_FakeSettings())

    assert len(calls) == 1
    assert calls[0]["search_terms"] == ["nintendo"]
    assert calls[0]["platform"] == SourcingPlatform.KLEINANZEIGEN
    assert calls[0]["agent_id"] == agent.id
