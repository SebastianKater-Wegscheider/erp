from __future__ import annotations

from datetime import datetime

from typing import TYPE_CHECKING

from sqlalchemy import DateTime, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from app.models.bank_transaction import BankTransaction


class BankAccount(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "bank_accounts"
    __table_args__ = (UniqueConstraint("provider", "external_id", name="uq_bank_accounts_provider_external_id"),)

    # Provider name, e.g. "GOCARDLESS_BANK_DATA"
    provider: Mapped[str] = mapped_column(String(50), nullable=False)

    # Provider-specific account identifier (e.g. GoCardless/Nordigen "account id").
    external_id: Mapped[str] = mapped_column(String(128), nullable=False)

    iban: Mapped[str | None] = mapped_column(String(34), nullable=True)
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(3), nullable=True)

    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    transactions: Mapped[list[BankTransaction]] = relationship(
        "BankTransaction",
        back_populates="account",
        cascade="all, delete-orphan",
    )
