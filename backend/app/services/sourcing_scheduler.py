from __future__ import annotations

import asyncio
import logging
import os
import random
import socket
import uuid
from datetime import timedelta

from sqlalchemy import or_, select, text
from sqlalchemy.orm import selectinload

from app.core.config import Settings
from app.models.sourcing import SourcingAgent
from app.services.sourcing import execute_sourcing_run, prune_old_sourcing_items, utcnow


logger = logging.getLogger(__name__)
SessionLocal = None


def _lock_holder_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


async def _try_acquire_or_renew_lock(*, name: str, holder: str, ttl_seconds: int) -> bool:
    now = utcnow()
    expires = now + timedelta(seconds=max(30, int(ttl_seconds)))

    stmt = text(
        "INSERT INTO job_locks (name, locked_at, locked_by, expires_at) "
        "VALUES (:name, :locked_at, :locked_by, :expires_at) "
        "ON CONFLICT (name) DO UPDATE SET "
        "locked_at = excluded.locked_at, "
        "locked_by = excluded.locked_by, "
        "expires_at = excluded.expires_at "
        "WHERE job_locks.expires_at <= :locked_at OR job_locks.locked_by = :locked_by"
    )

    async with _get_session_local()() as session:
        async with session.begin():
            res = await session.execute(
                stmt,
                {
                    "name": name,
                    "locked_at": now,
                    "locked_by": holder,
                    "expires_at": expires,
                },
            )
            return bool(res.rowcount == 1)


async def sourcing_scheduler_loop(settings: Settings) -> None:
    if not settings.sourcing_enabled:
        return

    holder = _lock_holder_id()
    lock_name = "sourcing_scheduler"
    tick = max(10, int(settings.sourcing_loop_tick_seconds))
    cooldown_until = utcnow()

    while True:
        try:
            if not settings.sourcing_enabled:
                await asyncio.sleep(tick)
                continue

            now = utcnow()
            if now < cooldown_until:
                wait_seconds = (cooldown_until - now).total_seconds()
                await asyncio.sleep(min(tick, max(1.0, wait_seconds)))
                continue

            acquired = await _try_acquire_or_renew_lock(
                name=lock_name,
                holder=holder,
                ttl_seconds=settings.sourcing_lock_ttl_seconds,
            )
            if not acquired:
                await asyncio.sleep(tick)
                continue

            due_agents = await _load_due_agents()
            async with _get_session_local()() as session:
                async with session.begin():
                    pruned = await prune_old_sourcing_items(session=session, app_settings=settings)
                if pruned > 0:
                    logger.info("Sourcing retention pruned %s low-signal items", pruned)
            if due_agents:
                for agent in due_agents:
                    try:
                        await _run_agent_queries(agent=agent, settings=settings)
                        await _mark_agent_run_success(agent_id=agent.id)
                    except Exception as exc:
                        logger.exception("Sourcing agent run failed for %s", agent.id)
                        await _mark_agent_run_error(agent_id=agent.id, error=exc)
                        cooldown_until = utcnow() + timedelta(seconds=max(30, settings.sourcing_error_backoff_seconds))
            elif settings.sourcing_kleinanzeigen_enabled and not await _has_enabled_agents():
                result = await execute_sourcing_run(
                    force=False,
                    search_terms=None,
                    trigger="scheduler",
                    app_settings=settings,
                )
                if result.status in {"error", "blocked"}:
                    cooldown_until = utcnow() + timedelta(seconds=max(30, settings.sourcing_error_backoff_seconds))

        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Sourcing scheduler tick failed")
            cooldown_until = utcnow() + timedelta(seconds=max(30, settings.sourcing_error_backoff_seconds))

        await asyncio.sleep(tick + random.uniform(0, 3))


def _get_session_local():
    global SessionLocal
    if SessionLocal is None:
        from app.core.db import SessionLocal as _SessionLocal

        SessionLocal = _SessionLocal
    return SessionLocal


async def _load_due_agents() -> list[SourcingAgent]:
    now = utcnow()
    async with _get_session_local()() as session:
        rows = (
            await session.execute(
                select(SourcingAgent)
                .where(
                    SourcingAgent.enabled.is_(True),
                    or_(SourcingAgent.next_run_at.is_(None), SourcingAgent.next_run_at <= now),
                )
                .options(selectinload(SourcingAgent.queries))
                .order_by(SourcingAgent.next_run_at.asc().nullsfirst(), SourcingAgent.created_at.asc())
            )
        ).scalars().all()
    return list(rows)


async def _has_enabled_agents() -> bool:
    async with _get_session_local()() as session:
        agent_id = (
            await session.execute(
                select(SourcingAgent.id)
                .where(SourcingAgent.enabled.is_(True))
                .limit(1)
            )
        ).scalar_one_or_none()
    return agent_id is not None


async def _run_agent_queries(*, agent: SourcingAgent, settings: Settings) -> None:
    enabled_queries = [q for q in agent.queries if q.enabled]
    failures: list[str] = []
    for query in enabled_queries:
        options = query.options_json if isinstance(query.options_json, dict) else {}
        result = await execute_sourcing_run(
            force=True,
            search_terms=[query.keyword],
            trigger="scheduler",
            app_settings=settings,
            platform=query.platform,
            options=options,
            agent_id=agent.id,
            agent_query_id=query.id,
            max_pages=query.max_pages,
            detail_enrichment_enabled=query.detail_enrichment_enabled,
        )
        if result.status in {"error", "blocked", "degraded"}:
            failures.append(f"{query.id}:{result.status}")
    if failures:
        raise RuntimeError(f"Agent query run issues: {', '.join(failures)}")


async def _mark_agent_run_success(*, agent_id: uuid.UUID) -> None:
    now = utcnow()
    async with _get_session_local()() as session:
        async with session.begin():
            agent = await session.get(SourcingAgent, agent_id)
            if agent is None:
                return
            agent.last_run_at = now
            agent.next_run_at = now + timedelta(seconds=max(3600, int(agent.interval_seconds)))
            agent.last_error_type = None
            agent.last_error_message = None


async def _mark_agent_run_error(*, agent_id: uuid.UUID, error: Exception) -> None:
    now = utcnow()
    async with _get_session_local()() as session:
        async with session.begin():
            agent = await session.get(SourcingAgent, agent_id)
            if agent is None:
                return
            agent.last_run_at = now
            agent.next_run_at = now + timedelta(seconds=max(3600, int(agent.interval_seconds)))
            agent.last_error_type = type(error).__name__
            agent.last_error_message = str(error)
