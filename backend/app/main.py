from __future__ import annotations

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import JSONResponse

from app.api.v1.router import api_router
from app.core.config import get_settings
from app.core.db import engine
from app.core.security import require_basic_auth
from app.models.base import Base

# Ensure models are imported before metadata creation
import app.models  # noqa: F401


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Reseller ERP (AT EPU)",
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
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    app.include_router(api_router, prefix="/api/v1")
    return app


app = create_app()
