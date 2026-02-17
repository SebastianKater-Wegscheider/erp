"""add sourcing agents and ebay fields

Revision ID: f1c6d8a9e112
Revises: ce8a1f2d9b77
Create Date: 2026-02-17 10:20:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "f1c6d8a9e112"
down_revision = "ce8a1f2d9b77"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE sourcing_platform ADD VALUE IF NOT EXISTS 'EBAY_DE';")

    op.create_table(
        "sourcing_agents",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("interval_seconds", sa.Integer(), nullable=False, server_default=sa.text("21600")),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_type", sa.String(length=64), nullable=True),
        sa.Column("last_error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_sourcing_agents_enabled_next_run_at",
        "sourcing_agents",
        ["enabled", "next_run_at"],
        unique=False,
    )

    sourcing_platform_enum = postgresql.ENUM(
        "KLEINANZEIGEN",
        "WILLHABEN",
        "EBAY_KLEINANZEIGEN",
        "EBAY_DE",
        name="sourcing_platform",
        create_type=False,
    )

    op.create_table(
        "sourcing_agent_queries",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("platform", sourcing_platform_enum, nullable=False),
        sa.Column("keyword", sa.String(length=200), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("max_pages", sa.Integer(), nullable=False, server_default=sa.text("3")),
        sa.Column("detail_enrichment_enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("options_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["agent_id"], ["sourcing_agents.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("agent_id", "platform", "keyword", name="uq_sourcing_agent_query_platform_keyword"),
    )
    op.create_index("ix_sourcing_agent_queries_agent_id", "sourcing_agent_queries", ["agent_id"], unique=False)
    op.create_index("ix_sourcing_agent_queries_enabled", "sourcing_agent_queries", ["enabled"], unique=False)

    op.add_column("sourcing_runs", sa.Column("agent_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("sourcing_runs", sa.Column("agent_query_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_sourcing_runs_agent_id",
        "sourcing_runs",
        "sourcing_agents",
        ["agent_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_sourcing_runs_agent_query_id",
        "sourcing_runs",
        "sourcing_agent_queries",
        ["agent_query_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.add_column("sourcing_items", sa.Column("agent_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("sourcing_items", sa.Column("agent_query_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("sourcing_items", sa.Column("auction_end_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("sourcing_items", sa.Column("auction_current_price_cents", sa.Integer(), nullable=True))
    op.add_column("sourcing_items", sa.Column("auction_bid_count", sa.Integer(), nullable=True))
    op.add_column("sourcing_items", sa.Column("max_purchase_price_cents", sa.Integer(), nullable=True))
    op.add_column("sourcing_items", sa.Column("bidbag_sent_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("sourcing_items", sa.Column("bidbag_last_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True))

    op.create_foreign_key(
        "fk_sourcing_items_agent_id",
        "sourcing_items",
        "sourcing_agents",
        ["agent_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_sourcing_items_agent_query_id",
        "sourcing_items",
        "sourcing_agent_queries",
        ["agent_query_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_sourcing_items_auction_end_at", "sourcing_items", ["auction_end_at"], unique=False)
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_sourcing_items_ebay_ready_auction_end "
        "ON sourcing_items (platform, status, auction_end_at) "
        "WHERE platform = 'EBAY_DE'"
    )

    op.execute(
        """
        INSERT INTO sourcing_settings (key, value_int, value_text, value_json, description)
        VALUES
            ('bidbag_deeplink_template', NULL, NULL, NULL, 'Optional deep-link template for bidbag handoff'),
            ('ebay_bid_buffer_cents', 0, NULL, NULL, 'Safety buffer subtracted from computed ebay max bid')
        ON CONFLICT (key) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute("DELETE FROM sourcing_settings WHERE key IN ('bidbag_deeplink_template', 'ebay_bid_buffer_cents')")

    op.execute("DROP INDEX IF EXISTS ix_sourcing_items_ebay_ready_auction_end")
    op.drop_index("ix_sourcing_items_auction_end_at", table_name="sourcing_items")

    op.drop_constraint("fk_sourcing_items_agent_query_id", "sourcing_items", type_="foreignkey")
    op.drop_constraint("fk_sourcing_items_agent_id", "sourcing_items", type_="foreignkey")

    op.drop_column("sourcing_items", "bidbag_last_payload")
    op.drop_column("sourcing_items", "bidbag_sent_at")
    op.drop_column("sourcing_items", "max_purchase_price_cents")
    op.drop_column("sourcing_items", "auction_bid_count")
    op.drop_column("sourcing_items", "auction_current_price_cents")
    op.drop_column("sourcing_items", "auction_end_at")
    op.drop_column("sourcing_items", "agent_query_id")
    op.drop_column("sourcing_items", "agent_id")

    op.drop_constraint("fk_sourcing_runs_agent_query_id", "sourcing_runs", type_="foreignkey")
    op.drop_constraint("fk_sourcing_runs_agent_id", "sourcing_runs", type_="foreignkey")
    op.drop_column("sourcing_runs", "agent_query_id")
    op.drop_column("sourcing_runs", "agent_id")

    op.drop_index("ix_sourcing_agent_queries_enabled", table_name="sourcing_agent_queries")
    op.drop_index("ix_sourcing_agent_queries_agent_id", table_name="sourcing_agent_queries")
    op.drop_table("sourcing_agent_queries")

    op.drop_index("ix_sourcing_agents_enabled_next_run_at", table_name="sourcing_agents")
    op.drop_table("sourcing_agents")

    # Note: PostgreSQL enum values cannot be removed safely in-place for downgrade.
