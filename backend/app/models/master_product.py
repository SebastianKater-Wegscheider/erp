from __future__ import annotations

from sqlalchemy import Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.enums import MasterProductKind
from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class MasterProduct(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "master_products"
    __table_args__ = (UniqueConstraint("kind", "title", "platform", "region", "variant", name="uq_master_product_identity"),)

    kind: Mapped[MasterProductKind] = mapped_column(String(20), nullable=False, default=MasterProductKind.GAME)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    platform: Mapped[str] = mapped_column(String(50), nullable=False)
    region: Mapped[str] = mapped_column(String(20), nullable=False)
    variant: Mapped[str] = mapped_column(String(80), nullable=False, default="")

    ean: Mapped[str | None] = mapped_column(String(32), nullable=True)
    asin: Mapped[str | None] = mapped_column(String(32), nullable=True)
    genre: Mapped[str | None] = mapped_column(String(80), nullable=True)
    release_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reference_image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
