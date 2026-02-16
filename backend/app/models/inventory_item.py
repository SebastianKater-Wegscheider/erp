from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import Date, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.enums import InventoryCondition, InventoryStatus, PurchaseType, TargetPriceMode
from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.sql_enums import inventory_condition_enum, inventory_status_enum, purchase_type_enum


def inventory_item_code_from_id(id_: uuid.UUID) -> str:
    # Stable, unique, human-friendly per-unit code derived from the UUID.
    # Example: IT-3F2504E04F89
    return f"IT-{id_.hex[:12].upper()}"


def _item_code_default(context) -> str:
    # Try to derive the item code from the (already-known) UUID primary key; otherwise fall back to a new UUID.
    get_params = getattr(context, "get_current_parameters", None)
    params = get_params() if callable(get_params) else {}
    id_ = params.get("id")

    if isinstance(id_, uuid.UUID):
        return inventory_item_code_from_id(id_)
    if isinstance(id_, str):
        try:
            return inventory_item_code_from_id(uuid.UUID(id_))
        except ValueError:
            pass
    return inventory_item_code_from_id(uuid.uuid4())


class InventoryItem(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "inventory_items"

    item_code: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, default=_item_code_default)

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

    # --- Target pricing ---
    target_price_mode: Mapped[str] = mapped_column(
        String(16), nullable=False, default=TargetPriceMode.AUTO, server_default="AUTO",
    )
    manual_target_sell_price_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
