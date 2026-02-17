from __future__ import annotations

import asyncio
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.config import get_settings
from app.models.sourcing import SourcingItem
from app.services.sourcing import execute_sourcing_run


def _pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.skipif(
    os.getenv("RUN_LIVE_KLEINANZEIGEN_TEST") != "1",
    reason="requires RUN_LIVE_KLEINANZEIGEN_TEST=1 and internet access",
)
async def test_live_kleinanzeigen_content_is_ingested(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if shutil.which("agent-browser") is None:
        pytest.skip("agent-browser binary not available")

    repo_root = Path(__file__).resolve().parents[2]
    scraper_port = _pick_free_port()
    scraper_base_url = f"http://127.0.0.1:{scraper_port}"

    env = os.environ.copy()
    env["PYTHONPATH"] = str(repo_root / "sourcing-scraper")
    env.setdefault("SOURCING_SCRAPER_USE_AGENT_BROWSER", "true")

    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(scraper_port),
        ],
        env=env,
        cwd=str(repo_root / "sourcing-scraper"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    async def _wait_for_health() -> None:
        timeout = httpx.Timeout(5.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            for _ in range(40):
                if proc.poll() is not None:
                    raise RuntimeError("sourcing-scraper process exited before health became ready")
                try:
                    resp = await client.get(f"{scraper_base_url}/healthz")
                    if resp.status_code == 200:
                        return
                except Exception:
                    pass
                await asyncio.sleep(0.5)
        raise RuntimeError("sourcing-scraper health check did not become ready")

    try:
        await _wait_for_health()

        timeout = httpx.Timeout(120.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            probe = await client.post(
                f"{scraper_base_url}/scrape",
                json={"platform": "kleinanzeigen", "search_terms": ["nintendo"]},
            )
            probe.raise_for_status()
            probe_payload = probe.json()
            assert probe_payload.get("error_type") in {None, ""}
            assert isinstance(probe_payload.get("listings"), list)
            assert len(probe_payload.get("listings")) > 0

        monkeypatch.setattr("app.services.sourcing.SessionLocal", session_factory)
        monkeypatch.setenv("SOURCING_SCRAPER_BASE_URL", scraper_base_url)
        monkeypatch.setenv("SOURCING_SCRAPER_TIMEOUT_SECONDS", "120")
        monkeypatch.setenv("SOURCING_MATCH_CONFIDENCE_MIN_SCORE", "80")
        get_settings.cache_clear()

        result = await execute_sourcing_run(
            force=True,
            search_terms=["nintendo"],
            trigger="live-test",
            app_settings=get_settings(),
        )
        assert result.items_scraped > 0, f"Expected live scrape >0 items, got status={result.status}"
        assert result.items_new > 0, f"Expected new items >0, got status={result.status}"

        async with session_factory() as session:
            total = (await session.execute(select(func.count()).select_from(SourcingItem))).scalar_one()
            assert total > 0

            row = (
                await session.execute(
                    select(SourcingItem.title, SourcingItem.url, SourcingItem.external_id).limit(1)
                )
            ).one()
            assert row[0]
            assert row[1].startswith("https://www.kleinanzeigen.de/")
            assert row[2]
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        get_settings.cache_clear()
