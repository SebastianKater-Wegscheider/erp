from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "5f3e8c1c6c2b"
down_revision = "e61db2bd6234"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "job_locks",
        sa.Column("name", sa.String(length=120), primary_key=True),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("locked_by", sa.String(length=200), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "amazon_scrape_runs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "master_product_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("master_products.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("asin", sa.String(length=32), nullable=False),
        sa.Column("marketplace", sa.String(length=32), nullable=False, server_default=sa.text("'amazon.de'")),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ok", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("blocked", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("block_reason", sa.Text(), nullable=True),
        sa.Column("offers_truncated", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("dp_url", sa.Text(), nullable=True),
        sa.Column("offer_listing_url", sa.Text(), nullable=True),
        sa.Column("delivery_zip", sa.String(length=32), nullable=True),
    )
    op.create_index("ix_amazon_scrape_runs_master_product_id", "amazon_scrape_runs", ["master_product_id"])
    op.create_index("ix_amazon_scrape_runs_asin", "amazon_scrape_runs", ["asin"])

    op.create_table(
        "amazon_scrape_sales_ranks",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "run_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("amazon_scrape_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("idx", sa.Integer(), nullable=False),
        sa.Column("rank", sa.Integer(), nullable=False),
        sa.Column("category", sa.Text(), nullable=False),
        sa.Column("raw", sa.Text(), nullable=True),
    )
    op.create_index("ix_amazon_scrape_sales_ranks_run_id", "amazon_scrape_sales_ranks", ["run_id"])

    op.create_table(
        "amazon_scrape_best_prices",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "run_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("amazon_scrape_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("condition_bucket", sa.String(length=40), nullable=False),
        sa.Column("price_total_cents", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(length=8), nullable=False, server_default=sa.text("'EUR'")),
        sa.Column("source_offer_page", sa.Integer(), nullable=True),
        sa.Column("source_offer_position", sa.Integer(), nullable=True),
        sa.Column("source_seller_name", sa.Text(), nullable=True),
    )
    op.create_index("ix_amazon_scrape_best_prices_run_id", "amazon_scrape_best_prices", ["run_id"])
    op.create_index("ix_amazon_scrape_best_prices_condition_bucket", "amazon_scrape_best_prices", ["condition_bucket"])

    op.create_table(
        "amazon_product_metrics_latest",
        sa.Column(
            "master_product_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("master_products.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_run_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("blocked_last", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("block_reason_last", sa.Text(), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("rank_overall", sa.Integer(), nullable=True),
        sa.Column("rank_overall_category", sa.Text(), nullable=True),
        sa.Column("rank_specific", sa.Integer(), nullable=True),
        sa.Column("rank_specific_category", sa.Text(), nullable=True),
        sa.Column("price_new_cents", sa.Integer(), nullable=True),
        sa.Column("price_used_like_new_cents", sa.Integer(), nullable=True),
        sa.Column("price_used_very_good_cents", sa.Integer(), nullable=True),
        sa.Column("price_used_good_cents", sa.Integer(), nullable=True),
        sa.Column("price_used_acceptable_cents", sa.Integer(), nullable=True),
        sa.Column("price_collectible_cents", sa.Integer(), nullable=True),
        sa.Column("next_retry_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("consecutive_failures", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )
    op.create_index("ix_amazon_product_metrics_latest_next_retry_at", "amazon_product_metrics_latest", ["next_retry_at"])


def downgrade() -> None:
    op.drop_index("ix_amazon_product_metrics_latest_next_retry_at", table_name="amazon_product_metrics_latest")
    op.drop_table("amazon_product_metrics_latest")

    op.drop_index("ix_amazon_scrape_best_prices_condition_bucket", table_name="amazon_scrape_best_prices")
    op.drop_index("ix_amazon_scrape_best_prices_run_id", table_name="amazon_scrape_best_prices")
    op.drop_table("amazon_scrape_best_prices")

    op.drop_index("ix_amazon_scrape_sales_ranks_run_id", table_name="amazon_scrape_sales_ranks")
    op.drop_table("amazon_scrape_sales_ranks")

    op.drop_index("ix_amazon_scrape_runs_asin", table_name="amazon_scrape_runs")
    op.drop_index("ix_amazon_scrape_runs_master_product_id", table_name="amazon_scrape_runs")
    op.drop_table("amazon_scrape_runs")

    op.drop_table("job_locks")

