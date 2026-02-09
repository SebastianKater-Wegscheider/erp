from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import FBACostDistributionMethod, FBAShipmentStatus, InventoryStatus
from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.sql_enums import (
    fba_cost_distribution_method_enum,
    fba_shipment_status_enum,
    inventory_status_enum,
)


class FBAShipment(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "fba_shipments"

    name: Mapped[str] = mapped_column(String(180), nullable=False)
    status: Mapped[FBAShipmentStatus] = mapped_column(
        fba_shipment_status_enum,
        nullable=False,
        default=FBAShipmentStatus.DRAFT,
        index=True,
    )

    carrier: Mapped[str | None] = mapped_column(String(80), nullable=True)
    tracking_number: Mapped[str | None] = mapped_column(String(120), nullable=True)

    shipping_cost_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cost_distribution_method: Mapped[FBACostDistributionMethod] = mapped_column(
        fba_cost_distribution_method_enum,
        nullable=False,
        default=FBACostDistributionMethod.EQUAL,
    )

    shipped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    items: Mapped[list["FBAShipmentItem"]] = relationship(
        back_populates="shipment",
        cascade="all, delete-orphan",
    )


class FBAShipmentItem(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "fba_shipment_items"
    __table_args__ = (UniqueConstraint("shipment_id", "inventory_item_id", name="uq_fba_shipment_item"),)

    shipment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("fba_shipments.id", ondelete="CASCADE"),
        nullable=False,
    )
    inventory_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("inventory_items.id"),
        nullable=False,
        index=True,
    )

    allocated_shipping_cost_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    received_status: Mapped[InventoryStatus | None] = mapped_column(inventory_status_enum, nullable=True)
    discrepancy_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    shipment: Mapped[FBAShipment] = relationship(back_populates="items")
