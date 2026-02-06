from __future__ import annotations

import uuid

from sqlalchemy import Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.enums import MasterProductKind
from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


def master_product_sku_from_id(id_: uuid.UUID) -> str:
    # Stable, unique, human-friendly internal SKU derived from the UUID.
    # Example: MP-3F2504E04F89
    return f"MP-{id_.hex[:12].upper()}"


def _sku_default(context) -> str:
    # Try to derive the SKU from the (already-known) UUID primary key; otherwise fall back to a new UUID.
    get_params = getattr(context, "get_current_parameters", None)
    params = get_params() if callable(get_params) else {}
    id_ = params.get("id")

    if isinstance(id_, uuid.UUID):
        return master_product_sku_from_id(id_)
    if isinstance(id_, str):
        try:
            return master_product_sku_from_id(uuid.UUID(id_))
        except ValueError:
            pass
    return master_product_sku_from_id(uuid.uuid4())


class MasterProduct(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "master_products"
    __table_args__ = (
        UniqueConstraint("sku", name="uq_master_product_sku"),
        UniqueConstraint("kind", "title", "platform", "region", "variant", name="uq_master_product_identity"),
    )

    sku: Mapped[str] = mapped_column(String(32), nullable=False, default=_sku_default)
    kind: Mapped[MasterProductKind] = mapped_column(String(20), nullable=False, default=MasterProductKind.GAME)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    platform: Mapped[str] = mapped_column(String(50), nullable=False)
    region: Mapped[str] = mapped_column(String(20), nullable=False)
    variant: Mapped[str] = mapped_column(String(80), nullable=False, default="")

    ean: Mapped[str | None] = mapped_column(String(32), nullable=True)
    asin: Mapped[str | None] = mapped_column(String(32), nullable=True)
    manufacturer: Mapped[str | None] = mapped_column(String(80), nullable=True)
    model: Mapped[str | None] = mapped_column(String(80), nullable=True)
    genre: Mapped[str | None] = mapped_column(String(80), nullable=True)
    release_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reference_image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
