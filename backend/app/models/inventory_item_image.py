from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class InventoryItemImage(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "inventory_item_images"
    __table_args__ = (
        UniqueConstraint("inventory_item_id", "upload_path", name="uq_inventory_item_image_path"),
    )

    inventory_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("inventory_items.id"),
        nullable=False,
        index=True,
    )
    upload_path: Mapped[str] = mapped_column(String(500), nullable=False)

