from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy.ext.asyncio import create_async_engine

# Script entrypoint: ensure `backend/` is importable.
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app.models  # noqa: E402,F401  (register models with Base.metadata)
from app.models.base import Base  # noqa: E402


def _include_object(obj, name: str | None, type_: str, reflected: bool, compare_to) -> bool:  # noqa: ANN001
    # Ignore Alembic's own version table.
    if type_ == "table" and name == "alembic_version":
        return False
    return True


async def _main() -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL is required.", file=sys.stderr)
        return 2

    engine = create_async_engine(url, pool_pre_ping=True)
    try:
        async with engine.connect() as conn:
            def _run_check(sync_conn) -> list:
                ctx = MigrationContext.configure(
                    sync_conn,
                    opts={
                        "target_metadata": Base.metadata,
                        "compare_type": True,
                        # Ignore server-default drift (we intentionally use SQLAlchemy defaults for many columns).
                        "compare_server_default": False,
                        "include_object": _include_object,
                    },
                )
                return compare_metadata(ctx, Base.metadata)

            diffs = await conn.run_sync(_run_check)
    finally:
        await engine.dispose()

    if diffs:
        print("Schema drift detected (models != DB).", file=sys.stderr)
        for d in diffs:
            print(d, file=sys.stderr)
        return 1

    print("Schema matches models (no drift).")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))

