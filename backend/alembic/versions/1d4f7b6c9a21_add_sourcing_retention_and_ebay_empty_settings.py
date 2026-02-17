"""add sourcing retention and ebay empty-run settings

Revision ID: 1d4f7b6c9a21
Revises: f1c6d8a9e112
Create Date: 2026-02-17 13:05:00.000000
"""

from __future__ import annotations

from alembic import op


# revision identifiers, used by Alembic.
revision = "1d4f7b6c9a21"
down_revision = "f1c6d8a9e112"
branch_labels = None
depends_on = None


_SETTING_KEYS = (
    "ebay_empty_results_degraded_after_runs",
    "sourcing_retention_days",
    "sourcing_retention_max_delete_per_tick",
)


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO sourcing_settings (key, value_int, value_text, value_json, description)
        VALUES
            ('ebay_empty_results_degraded_after_runs', 3, NULL, NULL, 'Mark eBay runs degraded after N consecutive zero-result runs'),
            ('sourcing_retention_days', 180, NULL, NULL, 'Delete low-signal sourcing items older than N days'),
            ('sourcing_retention_max_delete_per_tick', 500, NULL, NULL, 'Max low-signal sourcing items deleted per scheduler tick')
        ON CONFLICT (key) DO NOTHING
        """
    )


def downgrade() -> None:
    quoted = ", ".join(f"'{key}'" for key in _SETTING_KEYS)
    op.execute(f"DELETE FROM sourcing_settings WHERE key IN ({quoted})")
