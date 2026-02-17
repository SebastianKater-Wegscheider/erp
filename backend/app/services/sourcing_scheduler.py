from __future__ import annotations

import asyncio
import logging
import os
import random
import socket
from datetime import timedelta

from sqlalchemy import text

from app.core.config import Settings
from app.services.sourcing import execute_sourcing_run, utcnow


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
            if not settings.sourcing_enabled or not settings.sourcing_kleinanzeigen_enabled:
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
