from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import Date, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.enums import PaymentSource
from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.sql_enums import payment_source_enum


class LedgerEntry(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "ledger_entries"

    entry_date: Mapped[date] = mapped_column(Date, nullable=False)
    account: Mapped[PaymentSource] = mapped_column(payment_source_enum, nullable=False)

    # Positive=inflow, Negative=outflow
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)

    entity_type: Mapped[str] = mapped_column(String(100), nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    memo: Mapped[str | None] = mapped_column(String(500), nullable=True)

