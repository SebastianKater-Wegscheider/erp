from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import Column, Date, ForeignKey, Integer, String, Table
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import MileagePurpose
from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.sql_enums import mileage_purpose_enum


_mileage_log_purchases = Table(
    "mileage_log_purchases",
    Base.metadata,
    Column("mileage_log_id", UUID(as_uuid=True), ForeignKey("mileage_logs.id", ondelete="CASCADE"), primary_key=True),
    Column("purchase_id", UUID(as_uuid=True), ForeignKey("purchases.id", ondelete="CASCADE"), primary_key=True),
)


class MileageLog(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "mileage_logs"

    log_date: Mapped[date] = mapped_column(Date, nullable=False)
    start_location: Mapped[str] = mapped_column(String(200), nullable=False)
    destination: Mapped[str] = mapped_column(String(200), nullable=False)
    purpose: Mapped[MileagePurpose] = mapped_column(mileage_purpose_enum, nullable=False)
    purpose_text: Mapped[str | None] = mapped_column(String(300), nullable=True)

    distance_meters: Mapped[int] = mapped_column(Integer, nullable=False)
    rate_cents_per_km: Mapped[int] = mapped_column(Integer, nullable=False)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)

    # Legacy single-link (kept for backward compatibility).
    purchase_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("purchases.id"),
        nullable=True,
    )

    purchases: Mapped[list["Purchase"]] = relationship("Purchase", secondary=_mileage_log_purchases)

    @property
    def purchase_ids(self) -> list[uuid.UUID]:
        """
        Convenience accessor for API serialization.

        `purchase_id` is the legacy single-link; new links are stored via the
        `mileage_log_purchases` join table.
        """
        ids = [p.id for p in (self.purchases or [])]
        if not ids and self.purchase_id:
            ids.append(self.purchase_id)
        return ids
