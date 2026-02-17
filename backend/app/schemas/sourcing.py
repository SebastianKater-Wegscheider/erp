from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.core.enums import SourcingPlatform, SourcingStatus


class SourcingScrapeTriggerIn(BaseModel):
    force: bool = False
    search_terms: list[str] | None = None


class SourcingScrapeTriggerOut(BaseModel):
    run_id: UUID
    status: str
    started_at: datetime
    finished_at: datetime | None = None
    items_scraped: int = 0
    items_new: int = 0
    items_ready: int = 0


class SourcingHealthOut(BaseModel):
    status: str
    last_scrape_at: datetime | None
    scraper_status: str
    items_pending_analysis: int = 0
    last_error_type: str | None = None
    last_error_message: str | None = None


class SourcingStatsOut(BaseModel):
    total_items_scraped: int = 0
    items_by_status: dict[str, int] = Field(default_factory=dict)
    avg_profit_cents: int = 0
    conversion_rate_bp: int = 0


class SourcingItemListOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    platform: SourcingPlatform
    title: str
    price_cents: int
    location_city: str | None
    primary_image_url: str | None
    estimated_profit_cents: int | None
    estimated_roi_bp: int | None
    status: SourcingStatus
    scraped_at: datetime
    url: str
    match_count: int = 0


class SourcingItemListResponse(BaseModel):
    items: list[SourcingItemListOut]
    total: int
    limit: int
    offset: int


class SourcingMatchMasterProductOut(BaseModel):
    id: UUID
    title: str
    platform: str
    asin: str | None


class SourcingMatchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    master_product: SourcingMatchMasterProductOut
    confidence_score: int
    match_method: str
    matched_substring: str | None
    snapshot_bsr: int | None
    snapshot_new_price_cents: int | None
    snapshot_used_price_cents: int | None
    snapshot_fba_payout_cents: int | None
    user_confirmed: bool
    user_rejected: bool
    user_adjusted_condition: str | None


class SourcingItemDetailOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    platform: SourcingPlatform
    title: str
    description: str | None
    price_cents: int
    image_urls: list[str] = Field(default_factory=list)
    location_zip: str | None
    location_city: str | None
    status: SourcingStatus
    status_reason: str | None
    estimated_revenue_cents: int | None
    estimated_profit_cents: int | None
    estimated_roi_bp: int | None
    scraped_at: datetime
    analyzed_at: datetime | None
    url: str
    matches: list[SourcingMatchOut] = Field(default_factory=list)


class SourcingMatchPatchIn(BaseModel):
    user_confirmed: bool | None = None
    user_rejected: bool | None = None
    user_adjusted_condition: str | None = None


class SourcingMatchPatchOut(BaseModel):
    item_id: UUID
    match_id: UUID
    status: SourcingStatus
    estimated_revenue_cents: int | None
    estimated_profit_cents: int | None
    estimated_roi_bp: int | None


class SourcingConversionPreviewIn(BaseModel):
    confirmed_match_ids: list[UUID] | None = None


class SourcingConversionLineOut(BaseModel):
    master_product_id: UUID
    condition: str
    purchase_price_cents: int
    estimated_margin_cents: int | None = None


class SourcingConversionPreviewOut(BaseModel):
    purchase_kind: str
    payment_source: str
    total_amount_cents: int
    shipping_cost_cents: int
    lines: list[SourcingConversionLineOut]


class SourcingConvertIn(BaseModel):
    confirmed_match_ids: list[UUID]


class SourcingConvertOut(BaseModel):
    purchase_id: UUID
    purchase_kind: str
    total_amount_cents: int
    shipping_cost_cents: int
    lines: list[SourcingConversionLineOut]


class SourcingDiscardIn(BaseModel):
    reason: str | None = None


class SourcingSettingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    key: str
    value_int: int | None
    value_text: str | None
    value_json: dict[str, Any] | list[Any] | None
    description: str | None
    updated_at: datetime


class SourcingSettingUpdateValue(BaseModel):
    value_int: int | None = None
    value_text: str | None = None
    value_json: dict[str, Any] | list[Any] | None = None


class SourcingSettingsUpdateIn(BaseModel):
    values: dict[str, SourcingSettingUpdateValue]
