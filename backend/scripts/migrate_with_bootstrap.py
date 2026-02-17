from __future__ import annotations

import asyncio
import os
import shlex
import subprocess
import sys
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine


DEFAULT_BASELINE_REVISION = "e61db2bd6234"
DEFAULT_MARKER_TABLES = (
    "audit_logs",
    "purchases",
    "purchase_lines",
    "inventory_items",
    "sales_orders",
)


def _truthy(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _run_alembic(alembic_config_path: str, *args: str) -> None:
    cmd = ["alembic", "-c", alembic_config_path, *args]
    print(f"+ {' '.join(shlex.quote(part) for part in cmd)}")
    subprocess.run(cmd, check=True)


async def _detect_state(database_url: str, marker_tables: tuple[str, ...]) -> tuple[bool, int, list[str]]:
    engine = create_async_engine(database_url, pool_pre_ping=True)
    try:
        async with engine.connect() as conn:
            has_alembic_version = bool(
                await conn.scalar(text("SELECT to_regclass('public.alembic_version') IS NOT NULL"))
            )
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

            present_markers: list[str] = []
            for marker in marker_tables:
                present = bool(
                    await conn.scalar(
                        text("SELECT to_regclass(:qualified_name) IS NOT NULL"),
                        {"qualified_name": f"public.{marker}"},
                    )
                )
                if present:
                    present_markers.append(marker)
    finally:
        await engine.dispose()

    return has_alembic_version, table_count, present_markers


def _repo_head_revision(alembic_config_path: str) -> str | None:
    cfg = Config(alembic_config_path)
    script = ScriptDirectory.from_config(cfg)
    return script.get_current_head()


def main() -> int:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL is required.", file=sys.stderr)
        return 2

    alembic_config_path = os.getenv("ALEMBIC_CONFIG_PATH")
    if not alembic_config_path:
        default_path = Path(__file__).resolve().parents[1] / "alembic.ini"
        alembic_config_path = str(default_path)

    bootstrap_enabled = _truthy(os.getenv("ALEMBIC_BOOTSTRAP_LEGACY"))
    bootstrap_revision = os.getenv("ALEMBIC_BOOTSTRAP_REVISION")
    marker_tables = DEFAULT_MARKER_TABLES

    has_alembic_version, table_count, present_markers = asyncio.run(
        _detect_state(database_url, marker_tables)
    )
    repo_head = _repo_head_revision(alembic_config_path)

    print(
        "Migration preflight: "
        f"has_alembic_version={has_alembic_version} "
        f"table_count={table_count} "
        f"present_markers={','.join(present_markers) or '-'} "
        f"repo_head={repo_head or '-'}"
    )

    if not has_alembic_version and table_count > 0:
        if not bootstrap_enabled:
            print(
                "Legacy schema detected (tables exist, alembic_version missing).\n"
                "Refusing automatic stamp without explicit operator opt-in.\n"
                "Set ALEMBIC_BOOTSTRAP_LEGACY=true and ALEMBIC_BOOTSTRAP_REVISION=<revision> "
                "to confirm bootstrap.",
                file=sys.stderr,
            )
            return 3

        if not bootstrap_revision:
            print(
                "ALEMBIC_BOOTSTRAP_REVISION is required when ALEMBIC_BOOTSTRAP_LEGACY=true.",
                file=sys.stderr,
            )
            return 4

        missing_markers = [name for name in marker_tables if name not in present_markers]
        if missing_markers:
            print(
                "Refusing bootstrap stamp: schema does not look like baseline."
                f" Missing marker tables: {missing_markers}",
                file=sys.stderr,
            )
            return 5

        print(f"Bootstrapping legacy schema via alembic stamp {bootstrap_revision}.")
        _run_alembic(alembic_config_path, "stamp", bootstrap_revision)

    _run_alembic(alembic_config_path, "upgrade", "head")
    print("Migration step completed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
