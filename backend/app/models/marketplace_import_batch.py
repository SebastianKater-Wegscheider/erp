from __future__ import annotations

from sqlalchemy import Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.enums import MarketplaceImportKind
from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.sql_enums import marketplace_import_kind_enum


class MarketplaceImportBatch(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "marketplace_import_batches"

    kind: Mapped[MarketplaceImportKind] = mapped_column(marketplace_import_kind_enum, nullable=False)
    actor: Mapped[str] = mapped_column(String(200), nullable=False)
    source_label: Mapped[str | None] = mapped_column(String(200), nullable=True)
    raw_csv_text: Mapped[str] = mapped_column(Text, nullable=False)

    total_rows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    imported_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    skipped_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    errors: Mapped[list[dict] | None] = mapped_column(JSONB, nullable=True)

