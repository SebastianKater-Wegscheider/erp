from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.core.enums import SourcingPlatform, SourcingStatus


class SourcingScrapeTriggerIn(BaseModel):
    force: bool = False
    search_terms: list[str] | None = None
    platform: SourcingPlatform | None = None
    options: dict[str, Any] | None = None
    agent_id: UUID | None = None
    agent_query_id: UUID | None = None


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
    agent_id: UUID | None
    agent_query_id: UUID | None
    title: str
    price_cents: int
    location_city: str | None
    primary_image_url: str | None
    estimated_profit_cents: int | None
    estimated_roi_bp: int | None
    auction_end_at: datetime | None
    auction_current_price_cents: int | None
    auction_bid_count: int | None
    max_purchase_price_cents: int | None
    bidbag_sent_at: datetime | None
    status: SourcingStatus
    scraped_at: datetime
    posted_at: datetime | None
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
    agent_id: UUID | None
    agent_query_id: UUID | None
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
    auction_end_at: datetime | None
    auction_current_price_cents: int | None
    auction_bid_count: int | None
    max_purchase_price_cents: int | None
    bidbag_sent_at: datetime | None
    bidbag_last_payload: dict[str, Any] | None
    scraped_at: datetime
    posted_at: datetime | None
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


class SourcingBidbagHandoffOut(BaseModel):
    item_id: UUID
    deep_link_url: str | None
    payload: dict[str, Any]
    sent_at: datetime


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


class SourcingAgentQueryIn(BaseModel):
    platform: SourcingPlatform
    keyword: str = Field(min_length=1, max_length=200)
    enabled: bool = True
    max_pages: int = Field(default=3, ge=1, le=20)
    detail_enrichment_enabled: bool = True
    options_json: dict[str, Any] | list[Any] | None = None


class SourcingAgentCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    enabled: bool = True
    interval_seconds: int = Field(default=21600, ge=3600)
    queries: list[SourcingAgentQueryIn] = Field(default_factory=list)


class SourcingAgentPatchIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    enabled: bool | None = None
    interval_seconds: int | None = Field(default=None, ge=3600)
    queries: list[SourcingAgentQueryIn] | None = None


class SourcingAgentQueryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    platform: SourcingPlatform
    keyword: str
    enabled: bool
    max_pages: int
    detail_enrichment_enabled: bool
    options_json: dict[str, Any] | list[Any] | None
    created_at: datetime
    updated_at: datetime


class SourcingAgentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    enabled: bool
    interval_seconds: int
    last_run_at: datetime | None
    next_run_at: datetime | None
    last_error_type: str | None
    last_error_message: str | None
    created_at: datetime
    updated_at: datetime
    queries: list[SourcingAgentQueryOut] = Field(default_factory=list)


class SourcingAgentRunQueryOut(BaseModel):
    agent_query_id: UUID
    run_id: UUID
    status: str
    items_scraped: int
    items_new: int
    items_ready: int


class SourcingAgentRunOut(BaseModel):
    agent_id: UUID
    run_started_at: datetime
    results: list[SourcingAgentRunQueryOut] = Field(default_factory=list)
