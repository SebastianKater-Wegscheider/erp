from __future__ import annotations

import sys
from pathlib import Path
from collections.abc import AsyncIterator

import pytest_asyncio
from sqlalchemy import event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app.models  # noqa: E402,F401
from app.core.config import get_settings  # noqa: E402
from app.models.base import Base  # noqa: E402


@compiles(JSONB, "sqlite")
def _compile_jsonb_for_sqlite(_type, _compiler, **_kw) -> str:
    # Test suite uses SQLite; map PostgreSQL JSONB to JSON for portable DDL.
    return "JSON"


@pytest_asyncio.fixture
async def db_engine(tmp_path, monkeypatch) -> AsyncIterator[AsyncEngine]:
    db_path = tmp_path / "test.db"
    storage_dir = tmp_path / "storage"
    storage_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{db_path}")
    monkeypatch.setenv("APP_STORAGE_DIR", str(storage_dir))
    monkeypatch.setenv("BASIC_AUTH_USERNAME", "test-user")
    monkeypatch.setenv("BASIC_AUTH_PASSWORD", "test-pass")
    # Empty string -> normalized to None => VAT mode enabled by default in tests.
    monkeypatch.setenv("COMPANY_SMALL_BUSINESS_NOTICE", "")
    monkeypatch.setenv("COMPANY_VAT_ID", "ATU12345678")
    get_settings.cache_clear()

    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}", future=True)

    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield engine

    await engine.dispose()
    get_settings.cache_clear()


@pytest_asyncio.fixture
async def session_factory(db_engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(bind=db_engine, expire_on_commit=False)


@pytest_asyncio.fixture
async def db_session(session_factory: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    async with session_factory() as session:
        yield session
