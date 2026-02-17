from __future__ import annotations

import asyncio
import os
from contextlib import suppress
from functools import lru_cache
from pathlib import Path
from typing import Any

from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import text

from app.api.v1.router import api_router
from app.core.config import get_settings
from app.core.db import engine
from app.core.security import require_basic_auth
from app.services.amazon_scrape_scheduler import amazon_scrape_scheduler_loop
from app.services.sourcing_scheduler import sourcing_scheduler_loop


@lru_cache
def _repo_head_revision() -> str | None:
    default_alembic_path = Path(__file__).resolve().parents[1] / "alembic.ini"
    alembic_path = Path(os.getenv("ALEMBIC_CONFIG_PATH", str(default_alembic_path)))
    if not alembic_path.exists():
        return None

    cfg = Config(str(alembic_path))
    script = ScriptDirectory.from_config(cfg)
    return script.get_current_head()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Kater-Wegscheider Company (AT EPU)",
        version="1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    if settings.cors_origins:
        origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/healthz/deep")
    async def deep_healthz() -> JSONResponse:
        payload: dict[str, Any] = {
            "status": "ok",
            "checks": {
                "database": "ok",
            },
        }
        try:
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
                table_count = int(
                    (
                        await conn.scalar(
                            text(
                                """
                                SELECT count(*)
                                FROM information_schema.tables
                                WHERE table_schema = 'public'
                                  AND table_name <> 'alembic_version'
                                """
                            )
                        )
                    )
                    or 0
                )
                has_alembic_version = bool(
                    await conn.scalar(text("SELECT to_regclass('public.alembic_version') IS NOT NULL"))
                )
                current_revision: str | None = None
                if has_alembic_version:
                    current_revision = await conn.scalar(text("SELECT version_num FROM alembic_version LIMIT 1"))
        except Exception as exc:
            payload["status"] = "error"
            payload["checks"]["database"] = "error"
            payload["error"] = f"{exc.__class__.__name__}: {exc}"
            return JSONResponse(status_code=503, content=payload)

        repo_head = _repo_head_revision()
        if not has_alembic_version:
            migration_state = "empty_schema" if table_count == 0 else "missing_alembic_version"
        elif repo_head is None:
            migration_state = "unknown_repo_head"
        elif current_revision == repo_head:
            migration_state = "up_to_date"
        else:
            migration_state = "behind_head"

        payload["checks"]["migration"] = {
            "state": migration_state,
            "table_count": table_count,
            "has_alembic_version": has_alembic_version,
            "current_revision": current_revision,
            "repo_head_revision": repo_head,
        }

        healthy = migration_state in {"up_to_date", "empty_schema"}
        payload["status"] = "ok" if healthy else "degraded"
        return JSONResponse(status_code=200 if healthy else 503, content=payload)

    @app.get("/public/master-product-images/{file_path:path}", include_in_schema=False)
    async def public_master_product_image(file_path: str) -> FileResponse:
        rel = file_path.lstrip("/")
        if not rel.startswith("uploads/master-product-reference/"):
            raise HTTPException(status_code=403, detail="Forbidden path")

        base_dir = settings.app_storage_dir.resolve()
        abs_path = (settings.app_storage_dir / rel).resolve()
        try:
            abs_path.relative_to(base_dir)
        except ValueError as e:
            raise HTTPException(status_code=403, detail="Forbidden path") from e

        if not abs_path.is_file():
            raise HTTPException(status_code=404, detail="Not found")

        return FileResponse(
            path=str(abs_path),
            filename=Path(rel).name,
            headers={
                "Cache-Control": "public, max-age=86400",
            },
        )

    @app.get("/openapi.json", include_in_schema=False, dependencies=[Depends(require_basic_auth)])
    async def openapi_json() -> JSONResponse:
        return JSONResponse(app.openapi())

    @app.get("/docs", include_in_schema=False, dependencies=[Depends(require_basic_auth)])
    async def swagger_ui_html():
        return get_swagger_ui_html(openapi_url="/openapi.json", title=app.title)

    @app.on_event("startup")
    async def startup() -> None:
        settings.pdf_dir.mkdir(parents=True, exist_ok=True)
        settings.upload_dir.mkdir(parents=True, exist_ok=True)

        if settings.amazon_scraper_enabled:
            app.state.amazon_scrape_task = asyncio.create_task(amazon_scrape_scheduler_loop(settings))
        if settings.sourcing_enabled:
            app.state.sourcing_task = asyncio.create_task(sourcing_scheduler_loop(settings))

    @app.on_event("shutdown")
    async def shutdown() -> None:
        task = getattr(app.state, "amazon_scrape_task", None)
        if task is not None:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        task = getattr(app.state, "sourcing_task", None)
        if task is not None:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    app.include_router(api_router, prefix="/api/v1")
    return app


app = create_app()
