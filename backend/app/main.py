from __future__ import annotations

import asyncio
from contextlib import suppress
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import FileResponse, JSONResponse

from app.api.v1.router import api_router
from app.core.config import get_settings
from app.core.security import require_basic_auth
from app.services.amazon_scrape_scheduler import amazon_scrape_scheduler_loop


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

    @app.on_event("shutdown")
    async def shutdown() -> None:
        task = getattr(app.state, "amazon_scrape_task", None)
        if task is not None:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    app.include_router(api_router, prefix="/api/v1")
    return app


app = create_app()
