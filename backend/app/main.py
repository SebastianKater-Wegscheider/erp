from __future__ import annotations

import asyncio
import logging
from contextlib import suppress

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import JSONResponse

from app.api.v1.router import api_router
from app.core.config import get_settings
from app.core.db import SessionLocal
from app.core.security import require_basic_auth
from app.services.amazon_scrape_scheduler import amazon_scrape_scheduler_loop
from app.services.bank_transactions import sync_bank_transactions


logger = logging.getLogger(__name__)


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

        async def bank_sync_loop() -> None:
            interval = max(60, settings.bank_sync_interval_seconds)
            while True:
                try:
                    async with SessionLocal() as session:
                        async with session.begin():
                            await sync_bank_transactions(session)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("Bank sync failed")
                await asyncio.sleep(interval)

        # Start background syncing only when configured with Bank Account Data credentials.
        bank_data_ready = bool(
            settings.gocardless_bank_data_access_token
            or (settings.gocardless_bank_data_secret_id and settings.gocardless_bank_data_secret_key)
            or (settings.gocardless_token and "." in settings.gocardless_token)
        )
        if settings.bank_sync_enabled and bank_data_ready:
            app.state.bank_sync_task = asyncio.create_task(bank_sync_loop())

        if settings.amazon_scraper_enabled:
            app.state.amazon_scrape_task = asyncio.create_task(amazon_scrape_scheduler_loop(settings))

    @app.on_event("shutdown")
    async def shutdown() -> None:
        task = getattr(app.state, "bank_sync_task", None)
        if task is not None:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

        task = getattr(app.state, "amazon_scrape_task", None)
        if task is not None:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    app.include_router(api_router, prefix="/api/v1")
    return app


app = create_app()
