from __future__ import annotations

import uuid
from datetime import date

from typing import TYPE_CHECKING

from sqlalchemy import Boolean, Column, Date, ForeignKey, Index, Integer, String, Table, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from app.models.bank_account import BankAccount
    from app.models.purchase import Purchase


_bank_transaction_purchases = Table(
    "bank_transaction_purchases",
    Base.metadata,
    Column("bank_transaction_id", UUID(as_uuid=True), ForeignKey("bank_transactions.id", ondelete="CASCADE"), primary_key=True),
    Column("purchase_id", UUID(as_uuid=True), ForeignKey("purchases.id", ondelete="CASCADE"), primary_key=True),
)

# Keep these indexes explicit for migrations and query performance.
Index("ix_bank_transaction_purchases_purchase_id", _bank_transaction_purchases.c.purchase_id)
Index("ix_bank_transaction_purchases_bank_transaction_id", _bank_transaction_purchases.c.bank_transaction_id)


class BankTransaction(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "bank_transactions"
    __table_args__ = (
        UniqueConstraint("bank_account_id", "external_id", name="uq_bank_tx_account_external_id"),
        Index("ix_bank_transactions_booked_date", "booked_date"),
        Index("ix_bank_transactions_account_booked_date", "bank_account_id", "booked_date"),
    )

    bank_account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("bank_accounts.id", ondelete="CASCADE"),
        nullable=False,
    )

    # Provider-specific transaction identifier (or a stable hash fallback).
    external_id: Mapped[str] = mapped_column(String(200), nullable=False)

    booked_date: Mapped[date] = mapped_column(Date, nullable=False)
    value_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    # Positive=inflow, Negative=outflow
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)

    counterparty_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    remittance_information: Mapped[str | None] = mapped_column(Text, nullable=True)

    is_pending: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Raw provider payload for audit/debugging.
    raw: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    account: Mapped[BankAccount] = relationship("BankAccount", back_populates="transactions")

    purchases: Mapped[list[Purchase]] = relationship("Purchase", secondary=_bank_transaction_purchases)

    @property
    def purchase_ids(self) -> list[uuid.UUID]:
        return [p.id for p in (self.purchases or [])]
