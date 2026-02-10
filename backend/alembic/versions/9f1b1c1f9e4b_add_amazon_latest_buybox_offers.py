from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "9f1b1c1f9e4b"
down_revision = "5f3e8c1c6c2b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("amazon_product_metrics_latest", sa.Column("buybox_total_cents", sa.Integer(), nullable=True))
    op.add_column("amazon_product_metrics_latest", sa.Column("offers_count_total", sa.Integer(), nullable=True))
    op.add_column("amazon_product_metrics_latest", sa.Column("offers_count_priced_total", sa.Integer(), nullable=True))
    op.add_column("amazon_product_metrics_latest", sa.Column("offers_count_used_priced_total", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("amazon_product_metrics_latest", "offers_count_used_priced_total")
    op.drop_column("amazon_product_metrics_latest", "offers_count_priced_total")
    op.drop_column("amazon_product_metrics_latest", "offers_count_total")
    op.drop_column("amazon_product_metrics_latest", "buybox_total_cents")

