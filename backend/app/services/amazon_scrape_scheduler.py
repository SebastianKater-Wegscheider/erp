from __future__ import annotations

import asyncio
import os
import random
import socket
import uuid
import logging
from datetime import timedelta

from sqlalchemy import text, select

from app.core.config import Settings
from app.core.db import SessionLocal
from app.models.amazon_scrape import AmazonProductMetricsLatest, AmazonScrapeRun
from app.services.amazon_scrape_metrics import (
    ScraperBusyError,
    next_backoff_seconds,
    scrape_master_product_once,
    select_due_master_product_ids,
    set_next_retry_at,
    utcnow,
)


logger = logging.getLogger(__name__)


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

    async with SessionLocal() as session:
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
            # rowcount is 1 if inserted/updated, 0 if someone else holds it.
            return bool(res.rowcount == 1)


async def _process_one_due(settings: Settings) -> None:
    now = utcnow()
    async with SessionLocal() as session:
        async with session.begin():
            due = await select_due_master_product_ids(
                session=session,
                min_success_interval_seconds=settings.amazon_scraper_min_success_interval_seconds,
                now=now,
            )
            if not due:
                return
            master_product_id, asin = due[0]

        # Run scrape in its own transaction so we can safely retry scheduling on errors.
        async with session.begin():
            try:
                run_id = await scrape_master_product_once(
                    session=session,
                    settings=settings,
                    master_product_id=master_product_id,
                    asin=asin,
                )
            except ScraperBusyError:
                await set_next_retry_at(
                    session=session,
                    master_product_id=master_product_id,
                    next_retry_at=utcnow() + timedelta(seconds=random.randint(10, 30)),
                )
                logger.info("Scraper busy (429); retry scheduled", extra={"master_product_id": str(master_product_id), "asin": asin})
                return

            run = await session.get(AmazonScrapeRun, run_id)
            latest = await session.get(AmazonProductMetricsLatest, master_product_id)

            if run is None or latest is None:
                return

            if not run.ok:
                backoff = next_backoff_seconds(
                    consecutive_failures=int(latest.consecutive_failures or 1),
                    max_backoff_seconds=settings.amazon_scraper_max_backoff_seconds,
                )
                await set_next_retry_at(
                    session=session,
                    master_product_id=master_product_id,
                    next_retry_at=utcnow() + timedelta(seconds=backoff),
                )
                logger.warning(
                    "Amazon scrape failed; retry scheduled",
                    extra={
                        "master_product_id": str(master_product_id),
                        "asin": asin,
                        "blocked": run.blocked,
                        "error": run.error,
                        "backoff_seconds": backoff,
                    },
                )
            else:
                logger.info(
                    "Amazon scrape ok",
                    extra={
                        "master_product_id": str(master_product_id),
                        "asin": asin,
                        "run_id": str(run_id),
                    },
                )


async def amazon_scrape_scheduler_loop(settings: Settings) -> None:
    """
    Background loop that keeps Amazon scrape data fresh (>= 1 success per 24h).

    Work is intentionally single-threaded to reduce load and blocking risk.
    """
    if not settings.amazon_scraper_enabled:
        return

    holder = _lock_holder_id()
    lock_name = "amazon_scrape_scheduler"
    tick = max(5, int(settings.amazon_scraper_loop_tick_seconds))

    while True:
        try:
            acquired = await _try_acquire_or_renew_lock(
                name=lock_name,
                holder=holder,
                ttl_seconds=settings.amazon_scraper_lock_ttl_seconds,
            )
            if not acquired:
                await asyncio.sleep(tick)
                continue

            await _process_one_due(settings)

        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Amazon scrape scheduler tick failed")

        # Add a small jitter to avoid steady beats if multiple services are running.
        await asyncio.sleep(tick + random.uniform(0, 3))


async def amazon_scrape_due_counts(settings: Settings) -> dict[str, int]:
    """
    Lightweight stats for an ops/status endpoint.
    """
    now = utcnow()
    cutoff = now - timedelta(seconds=max(0, int(settings.amazon_scraper_min_success_interval_seconds)))

    async with SessionLocal() as session:
        async with session.begin():
            total_with_asin = (
                await session.scalar(
                    select(text("count(*)")).select_from(text("master_products")).where(text("asin IS NOT NULL AND asin != ''"))
                )
            ) or 0
            stale = (
                await session.scalar(
                    select(text("count(*)"))
                    .select_from(text("master_products mp"))
                    .join(text("amazon_product_metrics_latest aml"), text("aml.master_product_id = mp.id"), isouter=True)
                    .where(text("mp.asin IS NOT NULL AND mp.asin != ''"))
                    .where(text("aml.last_success_at IS NULL OR aml.last_success_at < :cutoff"))
                    .params(cutoff=cutoff)
                )
            ) or 0
            blocked_last = (
                await session.scalar(
                    select(text("count(*)"))
                    .select_from(text("amazon_product_metrics_latest"))
                    .where(text("blocked_last = TRUE"))
                )
            ) or 0
            return {
                "total_with_asin": int(total_with_asin),
                "stale": int(stale),
                "blocked_last": int(blocked_last),
            }

