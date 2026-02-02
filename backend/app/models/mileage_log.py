from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import Date, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.enums import MileagePurpose
from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.sql_enums import mileage_purpose_enum


class MileageLog(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "mileage_logs"

    log_date: Mapped[date] = mapped_column(Date, nullable=False)
    start_location: Mapped[str] = mapped_column(String(200), nullable=False)
    destination: Mapped[str] = mapped_column(String(200), nullable=False)
    purpose: Mapped[MileagePurpose] = mapped_column(mileage_purpose_enum, nullable=False)

    distance_meters: Mapped[int] = mapped_column(Integer, nullable=False)
    rate_cents_per_km: Mapped[int] = mapped_column(Integer, nullable=False)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)

    purchase_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("purchases.id"),
        nullable=True,
    )

