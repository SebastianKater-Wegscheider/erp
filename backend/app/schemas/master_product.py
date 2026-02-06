from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.core.enums import MasterProductKind


class MasterProductCreate(BaseModel):
    kind: MasterProductKind = Field(default=MasterProductKind.GAME)
    title: str = Field(min_length=1, max_length=200)
    platform: str = Field(min_length=1, max_length=50)
    region: str = Field(min_length=1, max_length=20)
    variant: str = Field(default="", max_length=80)

    ean: str | None = Field(default=None, max_length=32)
    asin: str | None = Field(default=None, max_length=32)
    genre: str | None = Field(default=None, max_length=80)
    release_year: int | None = Field(default=None, ge=1970, le=2100)
    reference_image_url: str | None = Field(default=None, max_length=500)


class MasterProductUpdate(BaseModel):
    kind: MasterProductKind | None = Field(default=None)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    platform: str | None = Field(default=None, min_length=1, max_length=50)
    region: str | None = Field(default=None, min_length=1, max_length=20)
    variant: str | None = Field(default=None, max_length=80)

    ean: str | None = Field(default=None, max_length=32)
    asin: str | None = Field(default=None, max_length=32)
    genre: str | None = Field(default=None, max_length=80)
    release_year: int | None = Field(default=None, ge=1970, le=2100)
    reference_image_url: str | None = Field(default=None, max_length=500)


class MasterProductOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    kind: MasterProductKind
    title: str
    platform: str
    region: str
    variant: str
    ean: str | None
    asin: str | None
    genre: str | None
    release_year: int | None
    reference_image_url: str | None
    created_at: datetime
    updated_at: datetime
