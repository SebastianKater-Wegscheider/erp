"""add sourcing item posted_at

Revision ID: ce8a1f2d9b77
Revises: b7c3d9e2f001
Create Date: 2026-02-17 09:20:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "ce8a1f2d9b77"
down_revision = "b7c3d9e2f001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sourcing_items", sa.Column("posted_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_sourcing_items_posted_at", "sourcing_items", ["posted_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_sourcing_items_posted_at", table_name="sourcing_items")
    op.drop_column("sourcing_items", "posted_at")
