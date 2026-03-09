"""add sourcing codex evaluation fields

Revision ID: d9a2d6c4b111
Revises: 8e2b7f4c1d33
Create Date: 2026-03-09 11:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "d9a2d6c4b111"
down_revision = "8e2b7f4c1d33"
branch_labels = None
depends_on = None


def upgrade() -> None:
    sourcing_evaluation_status = postgresql.ENUM(
        "PENDING",
        "RUNNING",
        "COMPLETED",
        "FAILED",
        name="sourcing_evaluation_status",
    )
    sourcing_evaluation_status.create(op.get_bind(), checkfirst=True)

    op.add_column(
        "sourcing_items",
        sa.Column(
            "evaluation_status",
            sourcing_evaluation_status,
            nullable=False,
            server_default=sa.text("'PENDING'"),
        ),
    )
    op.add_column("sourcing_items", sa.Column("evaluation_queued_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("sourcing_items", sa.Column("evaluation_started_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("sourcing_items", sa.Column("evaluation_finished_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "sourcing_items",
        sa.Column("evaluation_attempt_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )
    op.add_column("sourcing_items", sa.Column("evaluation_last_error", sa.Text(), nullable=True))
    op.add_column("sourcing_items", sa.Column("evaluation_summary", sa.Text(), nullable=True))
    op.add_column("sourcing_items", sa.Column("evaluation_result_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column("sourcing_items", sa.Column("evaluation_raw_response", sa.Text(), nullable=True))
    op.add_column("sourcing_items", sa.Column("evaluation_prompt_version", sa.String(length=32), nullable=True))
    op.add_column("sourcing_items", sa.Column("recommendation", sa.String(length=32), nullable=True))
    op.add_column("sourcing_items", sa.Column("expected_profit_cents", sa.Integer(), nullable=True))
    op.add_column("sourcing_items", sa.Column("expected_roi_bp", sa.Integer(), nullable=True))
    op.add_column("sourcing_items", sa.Column("max_buy_price_cents", sa.Integer(), nullable=True))
    op.add_column("sourcing_items", sa.Column("evaluation_confidence", sa.Integer(), nullable=True))
    op.add_column("sourcing_items", sa.Column("amazon_source_used", sa.String(length=32), nullable=True))

    op.create_index("ix_sourcing_items_evaluation_status", "sourcing_items", ["evaluation_status"], unique=False)
    op.create_index("ix_sourcing_items_recommendation", "sourcing_items", ["recommendation"], unique=False)

    op.alter_column("sourcing_items", "evaluation_status", server_default=None)
    op.alter_column("sourcing_items", "evaluation_attempt_count", server_default=None)


def downgrade() -> None:
    op.drop_index("ix_sourcing_items_recommendation", table_name="sourcing_items")
    op.drop_index("ix_sourcing_items_evaluation_status", table_name="sourcing_items")

    op.drop_column("sourcing_items", "amazon_source_used")
    op.drop_column("sourcing_items", "evaluation_confidence")
    op.drop_column("sourcing_items", "max_buy_price_cents")
    op.drop_column("sourcing_items", "expected_roi_bp")
    op.drop_column("sourcing_items", "expected_profit_cents")
    op.drop_column("sourcing_items", "recommendation")
    op.drop_column("sourcing_items", "evaluation_prompt_version")
    op.drop_column("sourcing_items", "evaluation_raw_response")
    op.drop_column("sourcing_items", "evaluation_result_json")
    op.drop_column("sourcing_items", "evaluation_summary")
    op.drop_column("sourcing_items", "evaluation_last_error")
    op.drop_column("sourcing_items", "evaluation_attempt_count")
    op.drop_column("sourcing_items", "evaluation_finished_at")
    op.drop_column("sourcing_items", "evaluation_started_at")
    op.drop_column("sourcing_items", "evaluation_queued_at")
    op.drop_column("sourcing_items", "evaluation_status")

    postgresql.ENUM(name="sourcing_evaluation_status").drop(op.get_bind(), checkfirst=True)
