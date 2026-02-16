from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "a1b2c3d4e5f6"
down_revision = "6f3b2a9d1c10"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("inventory_items", sa.Column("target_price_mode", sa.String(16), nullable=False, server_default="AUTO"))
    op.add_column("inventory_items", sa.Column("manual_target_sell_price_cents", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("inventory_items", "manual_target_sell_price_cents")
    op.drop_column("inventory_items", "target_price_mode")
