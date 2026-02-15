from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import Date, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import MarketplaceMatchStrategy, MarketplaceStagedOrderStatus, OrderChannel
from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.sql_enums import marketplace_match_strategy_enum, marketplace_staged_order_status_enum, order_channel_enum


class MarketplaceStagedOrder(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "marketplace_staged_orders"
    __table_args__ = (
        UniqueConstraint("channel", "external_order_id", name="uq_marketplace_staged_order_identity"),
    )

    batch_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("marketplace_import_batches.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    channel: Mapped[OrderChannel] = mapped_column(order_channel_enum, nullable=False)
    external_order_id: Mapped[str] = mapped_column(String(200), nullable=False)
    order_date: Mapped[date] = mapped_column(Date, nullable=False)

    buyer_name: Mapped[str] = mapped_column(String(200), nullable=False)
    buyer_address: Mapped[str | None] = mapped_column(Text, nullable=True)

    shipping_gross_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[MarketplaceStagedOrderStatus] = mapped_column(
        marketplace_staged_order_status_enum, nullable=False, default=MarketplaceStagedOrderStatus.NEEDS_ATTENTION
    )

    sales_order_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sales_orders.id", ondelete="SET NULL"),
        nullable=True,
        unique=True,
    )

    lines: Mapped[list["MarketplaceStagedOrderLine"]] = relationship(
        back_populates="order",
        cascade="all, delete-orphan",
        order_by="MarketplaceStagedOrderLine.created_at.asc()",
    )


class MarketplaceStagedOrderLine(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "marketplace_staged_order_lines"

    staged_order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("marketplace_staged_orders.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    sku: Mapped[str] = mapped_column(String(64), nullable=False)
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    sale_gross_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    shipping_gross_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    matched_inventory_item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("inventory_items.id", ondelete="SET NULL"),
        nullable=True,
        unique=True,
    )
    match_strategy: Mapped[MarketplaceMatchStrategy] = mapped_column(
        marketplace_match_strategy_enum,
        nullable=False,
        default=MarketplaceMatchStrategy.NONE,
    )
    match_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    order: Mapped[MarketplaceStagedOrder] = relationship(back_populates="lines")

