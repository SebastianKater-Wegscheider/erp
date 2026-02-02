from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import Boolean, Date, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import PaymentSource
from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.sql_enums import payment_source_enum


class CostAllocation(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "cost_allocations"

    allocation_date: Mapped[date] = mapped_column(Date, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    amount_net_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    amount_tax_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tax_rate_bp: Mapped[int] = mapped_column(Integer, nullable=False, default=2000)
    input_tax_deductible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    payment_source: Mapped[PaymentSource] = mapped_column(payment_source_enum, nullable=False)

    receipt_upload_path: Mapped[str | None] = mapped_column(String(500), nullable=True)

    lines: Mapped[list["CostAllocationLine"]] = relationship(
        back_populates="allocation", cascade="all, delete-orphan"
    )


class CostAllocationLine(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "cost_allocation_lines"

    allocation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cost_allocations.id"), nullable=False
    )
    inventory_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("inventory_items.id"), nullable=False
    )
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    amount_net_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    amount_tax_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    allocation: Mapped[CostAllocation] = relationship(back_populates="lines")
