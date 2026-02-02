from __future__ import annotations

from sqlalchemy import Integer, PrimaryKeyConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.enums import DocumentType
from app.models.base import Base
from app.models.sql_enums import document_type_enum


class DocumentCounter(Base):
    __tablename__ = "document_counters"
    __table_args__ = (PrimaryKeyConstraint("doc_type", "year", name="pk_document_counters"),)

    doc_type: Mapped[DocumentType] = mapped_column(document_type_enum, nullable=False)
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    next_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

