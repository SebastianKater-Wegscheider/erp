from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class PurchaseAttachment(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "purchase_attachments"
    __table_args__ = (
        UniqueConstraint("purchase_id", "upload_path", name="uq_purchase_attachment_path"),
    )

    purchase_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("purchases.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    upload_path: Mapped[str] = mapped_column(String(500), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(300), nullable=False)
    kind: Mapped[str] = mapped_column(String(40), nullable=False, default="OTHER")
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    purchase: Mapped["Purchase"] = relationship(back_populates="attachments")
