"""remove bank sync tables and add purchase primary mileage link

Revision ID: c4b2d9a3f11e
Revises: 9f1b1c1f9e4b
Create Date: 2026-02-11 18:20:00.000000

"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "c4b2d9a3f11e"
down_revision = "9f1b1c1f9e4b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("purchases", sa.Column("primary_mileage_log_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_purchases_primary_mileage_log_id",
        "purchases",
        "mileage_logs",
        ["primary_mileage_log_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_unique_constraint("uq_purchases_primary_mileage_log_id", "purchases", ["primary_mileage_log_id"])

    op.drop_index("ix_bank_transaction_purchases_purchase_id", table_name="bank_transaction_purchases")
    op.drop_index("ix_bank_transaction_purchases_bank_transaction_id", table_name="bank_transaction_purchases")
    op.drop_table("bank_transaction_purchases")

    op.drop_index("ix_bank_transactions_booked_date", table_name="bank_transactions")
    op.drop_index("ix_bank_transactions_account_booked_date", table_name="bank_transactions")
    op.drop_table("bank_transactions")

    op.drop_table("bank_accounts")


def downgrade() -> None:
    op.create_table(
        "bank_accounts",
        sa.Column("provider", sa.String(length=50), nullable=False),
        sa.Column("external_id", sa.String(length=128), nullable=False),
        sa.Column("iban", sa.String(length=34), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=True),
        sa.Column("currency", sa.String(length=3), nullable=True),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider", "external_id", name="uq_bank_accounts_provider_external_id"),
    )

    op.create_table(
        "bank_transactions",
        sa.Column("bank_account_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("external_id", sa.String(length=128), nullable=False),
        sa.Column("booked_date", sa.Date(), nullable=False),
        sa.Column("value_date", sa.Date(), nullable=True),
        sa.Column("amount_cents", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(length=8), nullable=False),
        sa.Column("counterparty_name", sa.String(length=300), nullable=True),
        sa.Column("remittance_information", sa.Text(), nullable=True),
        sa.Column("is_pending", sa.Boolean(), nullable=False),
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["bank_account_id"], ["bank_accounts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("bank_account_id", "external_id", name="uq_bank_tx_account_external_id"),
    )
    op.create_index(
        "ix_bank_transactions_account_booked_date",
        "bank_transactions",
        ["bank_account_id", "booked_date"],
        unique=False,
    )
    op.create_index("ix_bank_transactions_booked_date", "bank_transactions", ["booked_date"], unique=False)

    op.create_table(
        "bank_transaction_purchases",
        sa.Column("bank_transaction_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("purchase_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.ForeignKeyConstraint(["bank_transaction_id"], ["bank_transactions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["purchase_id"], ["purchases.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("bank_transaction_id", "purchase_id"),
    )
    op.create_index(
        "ix_bank_transaction_purchases_bank_transaction_id",
        "bank_transaction_purchases",
        ["bank_transaction_id"],
        unique=False,
    )
    op.create_index(
        "ix_bank_transaction_purchases_purchase_id",
        "bank_transaction_purchases",
        ["purchase_id"],
        unique=False,
    )

    op.drop_constraint("uq_purchases_primary_mileage_log_id", "purchases", type_="unique")
    op.drop_constraint("fk_purchases_primary_mileage_log_id", "purchases", type_="foreignkey")
    op.drop_column("purchases", "primary_mileage_log_id")
