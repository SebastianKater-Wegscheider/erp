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
    manufacturer: str | None = Field(default=None, max_length=80)
    model: str | None = Field(default=None, max_length=80)
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
    manufacturer: str | None = Field(default=None, max_length=80)
    model: str | None = Field(default=None, max_length=80)
    genre: str | None = Field(default=None, max_length=80)
    release_year: int | None = Field(default=None, ge=1970, le=2100)
    reference_image_url: str | None = Field(default=None, max_length=500)


class MasterProductOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    sku: str
    kind: MasterProductKind
    title: str
    platform: str
    region: str
    variant: str
    ean: str | None
    asin: str | None
    manufacturer: str | None
    model: str | None
    genre: str | None
    release_year: int | None
    reference_image_url: str | None
    created_at: datetime
    updated_at: datetime


class MasterProductOutWithAmazon(MasterProductOut):
    amazon_last_attempt_at: datetime | None = None
    amazon_last_success_at: datetime | None = None
    amazon_last_run_id: UUID | None = None

    amazon_blocked_last: bool | None = None
    amazon_block_reason_last: str | None = None
    amazon_last_error: str | None = None

    amazon_rank_overall: int | None = None
    amazon_rank_overall_category: str | None = None
    amazon_rank_specific: int | None = None
    amazon_rank_specific_category: str | None = None

    amazon_price_new_cents: int | None = None
    amazon_price_used_like_new_cents: int | None = None
    amazon_price_used_very_good_cents: int | None = None
    amazon_price_used_good_cents: int | None = None
    amazon_price_used_acceptable_cents: int | None = None
    amazon_price_collectible_cents: int | None = None

    amazon_next_retry_at: datetime | None = None
    amazon_consecutive_failures: int | None = None
