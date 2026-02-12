"""add private equity purchase flow

Revision ID: 7c9a1e2d4b11
Revises: c4b2d9a3f11e
Create Date: 2026-02-12 14:20:00.000000

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "7c9a1e2d4b11"
down_revision = "c4b2d9a3f11e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE purchase_kind ADD VALUE IF NOT EXISTS 'PRIVATE_EQUITY'")
    op.execute("ALTER TYPE payment_source ADD VALUE IF NOT EXISTS 'PRIVATE_EQUITY'")
    op.execute("ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'PRIVATE_EQUITY_NOTE'")

    op.add_column("purchase_lines", sa.Column("market_value_cents", sa.Integer(), nullable=True))
    op.add_column("purchase_lines", sa.Column("held_privately_over_12_months", sa.Boolean(), nullable=True))
    op.add_column("purchase_lines", sa.Column("valuation_reason", sa.Text(), nullable=True))

    op.add_column("purchase_attachments", sa.Column("purchase_line_id", sa.UUID(), nullable=True))
    op.create_index(op.f("ix_purchase_attachments_purchase_line_id"), "purchase_attachments", ["purchase_line_id"], unique=False)
    op.create_foreign_key(
        "fk_purchase_attachments_purchase_line_id",
        "purchase_attachments",
        "purchase_lines",
        ["purchase_line_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_purchase_attachments_purchase_line_id", "purchase_attachments", type_="foreignkey")
    op.drop_index(op.f("ix_purchase_attachments_purchase_line_id"), table_name="purchase_attachments")
    op.drop_column("purchase_attachments", "purchase_line_id")

    op.drop_column("purchase_lines", "valuation_reason")
    op.drop_column("purchase_lines", "held_privately_over_12_months")
    op.drop_column("purchase_lines", "market_value_cents")

    # Enum value removal is intentionally omitted for PostgreSQL compatibility.
