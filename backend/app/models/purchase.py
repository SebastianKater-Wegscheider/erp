from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import Date, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import InventoryCondition, PaymentSource, PurchaseKind, PurchaseType
from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.sql_enums import inventory_condition_enum, payment_source_enum, purchase_kind_enum, purchase_type_enum


class Purchase(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "purchases"

    kind: Mapped[PurchaseKind] = mapped_column(purchase_kind_enum, nullable=False)
    purchase_date: Mapped[date] = mapped_column(Date, nullable=False)

    counterparty_name: Mapped[str] = mapped_column(String(200), nullable=False)
    counterparty_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    counterparty_birthdate: Mapped[date | None] = mapped_column(Date, nullable=True)
    counterparty_id_number: Mapped[str | None] = mapped_column(String(80), nullable=True)

    total_amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    shipping_cost_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    buyer_protection_fee_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_net_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_tax_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tax_rate_bp: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    payment_source: Mapped[PaymentSource] = mapped_column(payment_source_enum, nullable=False)

    document_number: Mapped[str | None] = mapped_column(String(64), nullable=True)
    pdf_path: Mapped[str | None] = mapped_column(String(500), nullable=True)

    external_invoice_number: Mapped[str | None] = mapped_column(String(128), nullable=True)
    receipt_upload_path: Mapped[str | None] = mapped_column(String(500), nullable=True)

    lines: Mapped[list["PurchaseLine"]] = relationship(back_populates="purchase", cascade="all, delete-orphan")


class PurchaseLine(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "purchase_lines"

    purchase_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("purchases.id"), nullable=False)
    master_product_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("master_products.id"), nullable=False)

    condition: Mapped[InventoryCondition] = mapped_column(inventory_condition_enum, nullable=False)
    purchase_type: Mapped[PurchaseType] = mapped_column(purchase_type_enum, nullable=False)
    purchase_price_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    shipping_allocated_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    buyer_protection_fee_allocated_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    purchase_price_net_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    purchase_price_tax_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tax_rate_bp: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    purchase: Mapped[Purchase] = relationship(back_populates="lines")
