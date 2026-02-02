from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import Date, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import OrderChannel, OrderStatus, PaymentSource, PurchaseType
from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.sql_enums import order_channel_enum, order_status_enum, payment_source_enum, purchase_type_enum


class SalesOrder(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "sales_orders"

    order_date: Mapped[date] = mapped_column(Date, nullable=False)
    channel: Mapped[OrderChannel] = mapped_column(order_channel_enum, nullable=False)
    status: Mapped[OrderStatus] = mapped_column(order_status_enum, nullable=False, default=OrderStatus.DRAFT)

    buyer_name: Mapped[str] = mapped_column(String(200), nullable=False)
    buyer_address: Mapped[str | None] = mapped_column(Text, nullable=True)

    shipping_gross_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    payment_source: Mapped[PaymentSource] = mapped_column(payment_source_enum, nullable=False)

    invoice_number: Mapped[str | None] = mapped_column(String(64), nullable=True)
    invoice_pdf_path: Mapped[str | None] = mapped_column(String(500), nullable=True)

    lines: Mapped[list["SalesOrderLine"]] = relationship(back_populates="order", cascade="all, delete-orphan")


class SalesOrderLine(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "sales_order_lines"

    order_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sales_orders.id"), nullable=False)
    inventory_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("inventory_items.id"),
        nullable=False,
        unique=True,
    )

    purchase_type: Mapped[PurchaseType] = mapped_column(purchase_type_enum, nullable=False)

    sale_gross_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    sale_net_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    sale_tax_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    tax_rate_bp: Mapped[int] = mapped_column(Integer, nullable=False)

    order: Mapped[SalesOrder] = relationship(back_populates="lines")
