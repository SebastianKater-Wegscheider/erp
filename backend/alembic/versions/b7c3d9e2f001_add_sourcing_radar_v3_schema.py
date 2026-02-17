"""add sourcing radar v3 schema

Revision ID: b7c3d9e2f001
Revises: a1b2c3d4e5f6
Create Date: 2026-02-17 20:10:00.000000

"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "b7c3d9e2f001"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    sourcing_status_enum = postgresql.ENUM(
        "NEW",
        "ANALYZING",
        "READY",
        "LOW_VALUE",
        "CONVERTED",
        "DISCARDED",
        "ERROR",
        name="sourcing_status",
        create_type=False,
    )
    sourcing_platform_enum = postgresql.ENUM(
        "KLEINANZEIGEN",
        "WILLHABEN",
        "EBAY_KLEINANZEIGEN",
        name="sourcing_platform",
        create_type=False,
    )

    op.execute(
        "CREATE TYPE sourcing_status AS ENUM ('NEW', 'ANALYZING', 'READY', 'LOW_VALUE', 'CONVERTED', 'DISCARDED', 'ERROR');"
    )
    op.execute(
        "CREATE TYPE sourcing_platform AS ENUM ('KLEINANZEIGEN', 'WILLHABEN', 'EBAY_KLEINANZEIGEN');"
    )

    op.create_table(
        "sourcing_runs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("trigger", sa.String(length=32), nullable=False, server_default="scheduler"),
        sa.Column("platform", sourcing_platform_enum, nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ok", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("blocked", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("error_type", sa.String(length=32), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("items_scraped", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("items_new", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("items_ready", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("search_terms", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "sourcing_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("platform", sourcing_platform_enum, nullable=False),
        sa.Column("external_id", sa.String(length=255), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("title", sa.String(length=500), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("price_cents", sa.Integer(), nullable=False),
        sa.Column("location_zip", sa.String(length=10), nullable=True),
        sa.Column("location_city", sa.String(length=100), nullable=True),
        sa.Column("seller_type", sa.String(length=50), nullable=True),
        sa.Column("image_urls", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("primary_image_url", sa.Text(), nullable=True),
        sa.Column("status", sourcing_status_enum, nullable=False, server_default="NEW"),
        sa.Column("status_reason", sa.Text(), nullable=True),
        sa.Column("estimated_revenue_cents", sa.Integer(), nullable=True),
        sa.Column("estimated_profit_cents", sa.Integer(), nullable=True),
        sa.Column("estimated_roi_bp", sa.Integer(), nullable=True),
        sa.Column("raw_data", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("scraped_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("analyzed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("converted_purchase_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("last_run_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["converted_purchase_id"], ["purchases.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["last_run_id"], ["sourcing_runs.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("platform", "external_id", name="uq_sourcing_item_platform_external"),
    )
    op.create_index("ix_sourcing_items_status", "sourcing_items", ["status"])
    op.create_index("ix_sourcing_items_scraped_at", "sourcing_items", ["scraped_at"])
    op.create_index("ix_sourcing_items_run_id", "sourcing_items", ["last_run_id"])

    op.create_table(
        "sourcing_matches",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sourcing_item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("master_product_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("confidence_score", sa.Integer(), nullable=False),
        sa.Column("match_method", sa.String(length=50), nullable=False),
        sa.Column("matched_substring", sa.Text(), nullable=True),
        sa.Column("user_confirmed", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("user_rejected", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("user_adjusted_condition", sa.String(length=20), nullable=True),
        sa.Column("snapshot_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("snapshot_bsr", sa.Integer(), nullable=True),
        sa.Column("snapshot_new_price_cents", sa.Integer(), nullable=True),
        sa.Column("snapshot_used_price_cents", sa.Integer(), nullable=True),
        sa.Column("snapshot_fba_payout_cents", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("confidence_score >= 0 AND confidence_score <= 100", name="ck_sourcing_match_confidence_range"),
        sa.ForeignKeyConstraint(["master_product_id"], ["master_products.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["sourcing_item_id"], ["sourcing_items.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("sourcing_item_id", "master_product_id", name="uq_sourcing_match_item_product"),
    )
    op.create_index("ix_sourcing_matches_sourcing_item_id", "sourcing_matches", ["sourcing_item_id"])
    op.create_index("ix_sourcing_matches_confidence_score", "sourcing_matches", ["confidence_score"])

    op.create_table(
        "sourcing_settings",
        sa.Column("key", sa.String(length=100), nullable=False),
        sa.Column("value_int", sa.Integer(), nullable=True),
        sa.Column("value_text", sa.Text(), nullable=True),
        sa.Column("value_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("key"),
    )

    op.execute(
        """
        INSERT INTO sourcing_settings (key, value_int, value_text, value_json, description)
        VALUES
            ('bsr_max_threshold', 50000, NULL, NULL, 'Max BSR for sellable items'),
            ('price_min_cents', 500, NULL, NULL, 'Minimum listing price in cents'),
            ('price_max_cents', 30000, NULL, NULL, 'Maximum listing price in cents'),
            ('confidence_min_score', 80, NULL, NULL, 'Minimum fuzzy confidence score'),
            ('profit_min_cents', 3000, NULL, NULL, 'Minimum profit to mark READY'),
            ('roi_min_bp', 5000, NULL, NULL, 'Minimum ROI basis points to mark READY'),
            ('scrape_interval_seconds', 1800, NULL, NULL, 'Scheduler interval in seconds'),
            ('handling_cost_per_item_cents', 150, NULL, NULL, 'Handling cost per matched item in cents'),
            ('shipping_cost_cents', 690, NULL, NULL, 'Assumed shipping cost in cents'),
            ('search_terms', NULL, NULL, '["videospiele konvolut", "retro spiele sammlung", "nintendo spiele paket"]'::jsonb, 'Search terms for sourcing scraper')
        """
    )


def downgrade() -> None:
    op.drop_table("sourcing_settings")

    op.drop_index("ix_sourcing_matches_confidence_score", table_name="sourcing_matches")
    op.drop_index("ix_sourcing_matches_sourcing_item_id", table_name="sourcing_matches")
    op.drop_table("sourcing_matches")

    op.drop_index("ix_sourcing_items_run_id", table_name="sourcing_items")
    op.drop_index("ix_sourcing_items_scraped_at", table_name="sourcing_items")
    op.drop_index("ix_sourcing_items_status", table_name="sourcing_items")
    op.drop_table("sourcing_items")

    op.drop_table("sourcing_runs")

    op.execute("DROP TYPE sourcing_platform")
    op.execute("DROP TYPE sourcing_status")
