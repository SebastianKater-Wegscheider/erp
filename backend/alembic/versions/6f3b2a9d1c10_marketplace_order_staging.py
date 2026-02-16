"""marketplace order staging

Revision ID: 6f3b2a9d1c10
Revises: 3c7f1c0a8b21
Create Date: 2026-02-15

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "6f3b2a9d1c10"
down_revision = "3c7f1c0a8b21"
branch_labels = None
depends_on = None


def upgrade() -> None:
    marketplace_import_kind_enum = sa.Enum("ORDERS", "PAYOUTS", name="marketplace_import_kind", create_type=False)
    marketplace_staged_order_status_enum = sa.Enum(
        "READY", "NEEDS_ATTENTION", "APPLIED", name="marketplace_staged_order_status", create_type=False
    )
    marketplace_match_strategy_enum = sa.Enum(
        "ITEM_CODE", "MASTER_SKU_FIFO", "NONE", name="marketplace_match_strategy", create_type=False
    )
    order_channel_enum = sa.Enum("EBAY", "AMAZON", "WILLHABEN", "OTHER", name="order_channel", create_type=False)

    op.execute(
        "DO $$ BEGIN "
        "CREATE TYPE marketplace_import_kind AS ENUM ('ORDERS', 'PAYOUTS'); "
        "EXCEPTION WHEN duplicate_object THEN null; "
        "END $$;"
    )
    op.execute(
        "DO $$ BEGIN "
        "CREATE TYPE marketplace_staged_order_status AS ENUM ('READY', 'NEEDS_ATTENTION', 'APPLIED'); "
        "EXCEPTION WHEN duplicate_object THEN null; "
        "END $$;"
    )
    op.execute(
        "DO $$ BEGIN "
        "CREATE TYPE marketplace_match_strategy AS ENUM ('ITEM_CODE', 'MASTER_SKU_FIFO', 'NONE'); "
        "EXCEPTION WHEN duplicate_object THEN null; "
        "END $$;"
    )

    op.create_table(
        "marketplace_import_batches",
        sa.Column("kind", marketplace_import_kind_enum, nullable=False),
        sa.Column("actor", sa.String(length=200), nullable=False),
        sa.Column("source_label", sa.String(length=200), nullable=True),
        sa.Column("raw_csv_text", sa.Text(), nullable=False),
        sa.Column("total_rows", sa.Integer(), server_default="0", nullable=False),
        sa.Column("imported_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("skipped_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("failed_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("errors", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "marketplace_staged_orders",
        sa.Column("batch_id", sa.UUID(), nullable=True),
        sa.Column("channel", order_channel_enum, nullable=False),
        sa.Column("external_order_id", sa.String(length=200), nullable=False),
        sa.Column("order_date", sa.Date(), nullable=False),
        sa.Column("buyer_name", sa.String(length=200), nullable=False),
        sa.Column("buyer_address", sa.Text(), nullable=True),
        sa.Column("shipping_gross_cents", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "status",
            marketplace_staged_order_status_enum,
            server_default="NEEDS_ATTENTION",
            nullable=False,
        ),
        sa.Column("sales_order_id", sa.UUID(), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["batch_id"], ["marketplace_import_batches.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["sales_order_id"], ["sales_orders.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("sales_order_id"),
        sa.UniqueConstraint("channel", "external_order_id", name="uq_marketplace_staged_order_identity"),
    )
    op.create_index(op.f("ix_marketplace_staged_orders_batch_id"), "marketplace_staged_orders", ["batch_id"], unique=False)

    op.create_table(
        "marketplace_staged_order_lines",
        sa.Column("staged_order_id", sa.UUID(), nullable=False),
        sa.Column("sku", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=True),
        sa.Column("sale_gross_cents", sa.Integer(), nullable=False),
        sa.Column("shipping_gross_cents", sa.Integer(), server_default="0", nullable=False),
        sa.Column("matched_inventory_item_id", sa.UUID(), nullable=True),
        sa.Column(
            "match_strategy",
            marketplace_match_strategy_enum,
            server_default="NONE",
            nullable=False,
        ),
        sa.Column("match_error", sa.Text(), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["matched_inventory_item_id"], ["inventory_items.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["staged_order_id"], ["marketplace_staged_orders.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("matched_inventory_item_id"),
    )
    op.create_index(
        op.f("ix_marketplace_staged_order_lines_staged_order_id"),
        "marketplace_staged_order_lines",
        ["staged_order_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_marketplace_staged_order_lines_staged_order_id"), table_name="marketplace_staged_order_lines")
    op.drop_table("marketplace_staged_order_lines")

    op.drop_index(op.f("ix_marketplace_staged_orders_batch_id"), table_name="marketplace_staged_orders")
    op.drop_table("marketplace_staged_orders")

    op.drop_table("marketplace_import_batches")

    # Enum type removal is intentionally omitted for PostgreSQL compatibility.
