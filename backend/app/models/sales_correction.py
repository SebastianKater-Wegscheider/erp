from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import Date, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import PaymentSource, PurchaseType, ReturnAction
from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.sql_enums import payment_source_enum, purchase_type_enum, return_action_enum


class SalesCorrection(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "sales_corrections"

    order_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sales_orders.id"), nullable=False)

    correction_date: Mapped[date] = mapped_column(Date, nullable=False)
    correction_number: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    pdf_path: Mapped[str | None] = mapped_column(String(500), nullable=True)

    refund_gross_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    shipping_refund_gross_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    shipping_refund_regular_gross_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    shipping_refund_regular_net_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    shipping_refund_regular_tax_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    shipping_refund_margin_gross_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    payment_source: Mapped[PaymentSource] = mapped_column(payment_source_enum, nullable=False)

    lines: Mapped[list["SalesCorrectionLine"]] = relationship(back_populates="correction", cascade="all, delete-orphan")


class SalesCorrectionLine(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "sales_correction_lines"

    correction_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sales_corrections.id"), nullable=False
    )
    inventory_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("inventory_items.id"),
        nullable=False,
        unique=True,
    )

    action: Mapped[ReturnAction] = mapped_column(return_action_enum, nullable=False)
    purchase_type: Mapped[PurchaseType] = mapped_column(purchase_type_enum, nullable=False)

    refund_gross_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    refund_net_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    refund_tax_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    tax_rate_bp: Mapped[int] = mapped_column(Integer, nullable=False)

    shipping_refund_allocated_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    margin_vat_adjustment_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    correction: Mapped[SalesCorrection] = relationship(back_populates="lines")
