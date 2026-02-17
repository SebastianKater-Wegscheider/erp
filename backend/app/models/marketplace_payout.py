from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import Date, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.enums import OrderChannel
from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.sql_enums import order_channel_enum


class MarketplacePayout(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "marketplace_payouts"
    __table_args__ = (
        UniqueConstraint("channel", "external_payout_id", name="uq_marketplace_payout_identity"),
    )

    channel: Mapped[OrderChannel] = mapped_column(order_channel_enum, nullable=False)
    external_payout_id: Mapped[str] = mapped_column(String(200), nullable=False)
    payout_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    net_amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)

    ledger_entry_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("ledger_entries.id", ondelete="SET NULL"),
        nullable=True,
        unique=True,
    )
