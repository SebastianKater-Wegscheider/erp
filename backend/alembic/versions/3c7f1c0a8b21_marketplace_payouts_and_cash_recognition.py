"""marketplace payouts and cash recognition

Revision ID: 3c7f1c0a8b21
Revises: 2f6c1c2e9a11
Create Date: 2026-02-15

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "3c7f1c0a8b21"
down_revision = "2f6c1c2e9a11"
branch_labels = None
depends_on = None


def upgrade() -> None:
    cash_recognition_enum = postgresql.ENUM("AT_FINALIZE", "AT_PAYOUT", name="cash_recognition", create_type=False)
    order_channel_enum = postgresql.ENUM("EBAY", "AMAZON", "WILLHABEN", "OTHER", name="order_channel", create_type=False)

    op.execute(
        "DO $$ BEGIN "
        "CREATE TYPE cash_recognition AS ENUM ('AT_FINALIZE', 'AT_PAYOUT'); "
        "EXCEPTION WHEN duplicate_object THEN null; "
        "END $$;"
    )

    op.add_column(
        "sales_orders",
        sa.Column(
            "cash_recognition",
            cash_recognition_enum,
            nullable=False,
            server_default="AT_FINALIZE",
        ),
    )
    op.add_column("sales_orders", sa.Column("external_order_id", sa.String(length=120), nullable=True))
    op.create_index(
        op.f("ix_sales_orders_external_order_id"),
        "sales_orders",
        ["external_order_id"],
        unique=False,
    )
    op.alter_column("sales_orders", "cash_recognition", server_default=None)

    op.create_table(
        "marketplace_payouts",
        sa.Column("channel", order_channel_enum, nullable=False),
        sa.Column("external_payout_id", sa.String(length=200), nullable=False),
        sa.Column("payout_date", sa.Date(), nullable=False),
        sa.Column("net_amount_cents", sa.Integer(), nullable=False),
        sa.Column("ledger_entry_id", sa.UUID(), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["ledger_entry_id"], ["ledger_entries.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("ledger_entry_id"),
        sa.UniqueConstraint("channel", "external_payout_id", name="uq_marketplace_payout_identity"),
    )
    op.create_index(op.f("ix_marketplace_payouts_payout_date"), "marketplace_payouts", ["payout_date"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_marketplace_payouts_payout_date"), table_name="marketplace_payouts")
    op.drop_table("marketplace_payouts")

    op.drop_index(op.f("ix_sales_orders_external_order_id"), table_name="sales_orders")
    op.drop_column("sales_orders", "external_order_id")
    op.drop_column("sales_orders", "cash_recognition")

    # Enum type removal is intentionally omitted for PostgreSQL compatibility.
