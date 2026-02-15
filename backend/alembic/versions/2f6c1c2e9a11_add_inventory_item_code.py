"""add inventory item code

Revision ID: 2f6c1c2e9a11
Revises: 7c9a1e2d4b11
Create Date: 2026-02-15

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "2f6c1c2e9a11"
down_revision = "7c9a1e2d4b11"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("inventory_items", sa.Column("item_code", sa.String(length=32), nullable=True))

    # Backfill from UUID: IT- + first 12 hex chars (uppercase).
    op.execute(
        "UPDATE inventory_items "
        "SET item_code = 'IT-' || upper(substring(replace(id::text, '-', ''), 1, 12)) "
        "WHERE item_code IS NULL"
    )

    op.alter_column("inventory_items", "item_code", existing_type=sa.String(length=32), nullable=False)
    op.create_index(op.f("ix_inventory_items_item_code"), "inventory_items", ["item_code"], unique=True)


def downgrade() -> None:
    op.drop_index(op.f("ix_inventory_items_item_code"), table_name="inventory_items")
    op.drop_column("inventory_items", "item_code")

