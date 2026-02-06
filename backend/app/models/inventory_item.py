from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import Date, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.enums import InventoryCondition, InventoryStatus, PurchaseType
from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.sql_enums import inventory_condition_enum, inventory_status_enum, purchase_type_enum


class InventoryItem(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "inventory_items"

    master_product_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("master_products.id"), nullable=False)
    purchase_line_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("purchase_lines.id"),
        unique=True,
        nullable=True,
    )

    condition: Mapped[InventoryCondition] = mapped_column(inventory_condition_enum, nullable=False)
    purchase_type: Mapped[PurchaseType] = mapped_column(purchase_type_enum, nullable=False)

    purchase_price_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    allocated_costs_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    storage_location: Mapped[str | None] = mapped_column(String(100), nullable=True)
    serial_number: Mapped[str | None] = mapped_column(String(120), nullable=True)
    status: Mapped[InventoryStatus] = mapped_column(inventory_status_enum, nullable=False, default=InventoryStatus.DRAFT)

    acquired_date: Mapped[date | None] = mapped_column(Date, nullable=True)
