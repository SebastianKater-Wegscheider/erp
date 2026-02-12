from __future__ import annotations

from datetime import datetime
from pathlib import Path
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class PurchaseAttachmentCreate(BaseModel):
    upload_path: str = Field(min_length=1, max_length=500)
    purchase_line_id: UUID | None = None
    original_filename: str | None = Field(default=None, max_length=300)
    kind: str = Field(default="OTHER", min_length=1, max_length=40)
    note: str | None = Field(default=None, max_length=1000)

    @field_validator("upload_path", mode="before")
    @classmethod
    def normalize_upload_path(cls, value: str) -> str:
        rel = str(value or "").strip().lstrip("/")
        if not rel.startswith("uploads/"):
            raise ValueError("upload_path must start with uploads/")
        return rel

    @field_validator("kind", mode="before")
    @classmethod
    def normalize_kind(cls, value: str) -> str:
        raw = str(value or "").strip().upper()
        return raw or "OTHER"

    @field_validator("original_filename", mode="before")
    @classmethod
    def fill_original_filename(cls, value: str | None, info) -> str | None:
        if value is not None and str(value).strip():
            return str(value).strip()
        upload_path = str((info.data or {}).get("upload_path") or "").strip()
        if not upload_path:
            return value
        return Path(upload_path).name

    @field_validator("note", mode="before")
    @classmethod
    def normalize_note(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = str(value).strip()
        return normalized or None


class PurchaseAttachmentBatchCreate(BaseModel):
    attachments: list[PurchaseAttachmentCreate] = Field(min_length=1, max_length=30)


class PurchaseAttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    purchase_id: UUID
    purchase_line_id: UUID | None
    upload_path: str
    original_filename: str
    kind: str
    note: str | None
    created_at: datetime
    updated_at: datetime
