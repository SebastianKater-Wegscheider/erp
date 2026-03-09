from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.core.enums import MasterProductKind, SourcingEvaluationStatus, SourcingPlatform, SourcingStatus


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
    items_queued: int = 0


class SourcingCleanseIn(BaseModel):
    older_than_days: int = Field(default=14, ge=0, le=3650)
    limit: int = Field(default=25, ge=1, le=200)
    platform: SourcingPlatform | None = None


class SourcingCleanseOut(BaseModel):
    checked: int = 0
    discarded: int = 0
    kept: int = 0
    errors: int = 0
    blocked: bool = False
    blocked_reason: str | None = None


class SourcingHealthOut(BaseModel):
    status: str
    last_scrape_at: datetime | None
    scraper_status: str
    items_pending_evaluation: int = 0
    items_failed_evaluation: int = 0
    last_error_type: str | None = None
    last_error_message: str | None = None


class SourcingStatsOut(BaseModel):
    total_items_scraped: int = 0
    items_by_status: dict[str, int] = Field(default_factory=dict)
    items_by_evaluation_status: dict[str, int] = Field(default_factory=dict)
    items_by_recommendation: dict[str, int] = Field(default_factory=dict)


class SourcingEvaluationMatchedProductOut(BaseModel):
    master_product_id: UUID | None = None
    sku: str | None = None
    title: str | None = None
    asin: str | None = None
    confidence: int | None = None
    basis: str | None = None


class SourcingEvaluationResultOut(BaseModel):
    recommendation: str | None = None
    summary: str | None = None
    expected_profit_cents: int | None = None
    expected_roi_bp: int | None = None
    max_buy_price_cents: int | None = None
    confidence: int | None = None
    amazon_source_used: str | None = None
    matched_products: list[SourcingEvaluationMatchedProductOut] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    reasoning_notes: list[str] = Field(default_factory=list)


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
    status: SourcingStatus
    evaluation_status: SourcingEvaluationStatus
    recommendation: str | None
    evaluation_summary: str | None
    expected_profit_cents: int | None
    expected_roi_bp: int | None
    max_buy_price_cents: int | None
    evaluation_finished_at: datetime | None
    evaluation_last_error: str | None
    scraped_at: datetime
    posted_at: datetime | None
    url: str


class SourcingItemListResponse(BaseModel):
    items: list[SourcingItemListOut]
    total: int
    limit: int
    offset: int


class SourcingItemDetailOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    platform: SourcingPlatform
    external_id: str
    agent_id: UUID | None
    agent_query_id: UUID | None
    title: str
    description: str | None
    price_cents: int
    image_urls: list[str] = Field(default_factory=list)
    primary_image_url: str | None = None
    location_zip: str | None
    location_city: str | None
    seller_type: str | None
    auction_end_at: datetime | None = None
    auction_current_price_cents: int | None = None
    auction_bid_count: int | None = None
    status: SourcingStatus
    status_reason: str | None
    evaluation_status: SourcingEvaluationStatus
    evaluation_queued_at: datetime | None
    evaluation_started_at: datetime | None
    evaluation_finished_at: datetime | None
    evaluation_attempt_count: int
    evaluation_last_error: str | None
    evaluation_summary: str | None
    evaluation_prompt_version: str | None
    recommendation: str | None
    expected_profit_cents: int | None
    expected_roi_bp: int | None
    max_buy_price_cents: int | None
    evaluation_confidence: int | None
    amazon_source_used: str | None
    evaluation: SourcingEvaluationResultOut | None = None
    raw_data: dict[str, Any] | None = None
    scraped_at: datetime
    posted_at: datetime | None
    url: str


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


class SourcingConvertOut(BaseModel):
    purchase_id: UUID
    purchase_kind: str
    total_amount_cents: int
    shipping_cost_cents: int
    lines: list[SourcingConversionLineOut]


class SourcingBidbagHandoffOut(BaseModel):
    item_id: UUID
    deep_link_url: str | None
    payload: dict[str, Any]
    sent_at: datetime


class SourcingEvaluateOut(BaseModel):
    item_id: UUID
    evaluation_status: SourcingEvaluationStatus
    evaluation_queued_at: datetime


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
    items_queued: int


class SourcingAgentRunOut(BaseModel):
    agent_id: UUID
    run_started_at: datetime
    results: list[SourcingAgentRunQueryOut] = Field(default_factory=list)


class SourcingReviewCatalogAmazonOut(BaseModel):
    last_success_at: datetime | None = None
    rank_overall: int | None = None
    rank_specific: int | None = None
    price_new_cents: int | None = None
    price_used_like_new_cents: int | None = None
    price_used_very_good_cents: int | None = None
    price_used_good_cents: int | None = None
    price_used_acceptable_cents: int | None = None
    buybox_total_cents: int | None = None
    offers_count_total: int | None = None
    offers_count_used_priced_total: int | None = None


class SourcingReviewCatalogEntryOut(BaseModel):
    id: UUID
    sku: str
    kind: MasterProductKind
    title: str
    platform: str
    region: str
    variant: str
    asin: str | None = None
    ean: str | None = None
    in_stock_count: int = 0
    amazon_cached: SourcingReviewCatalogAmazonOut


class SourcingReviewRunOut(BaseModel):
    id: UUID
    platform: SourcingPlatform
    started_at: datetime
    finished_at: datetime | None = None
    ok: bool
    blocked: bool
    error_type: str | None = None
    error_message: str | None = None
    items_scraped: int = 0
    items_new: int = 0


class SourcingReviewPacketOut(BaseModel):
    generated_at: datetime
    platform: SourcingPlatform
    latest_run: SourcingReviewRunOut | None = None
    items: list[SourcingItemDetailOut] = Field(default_factory=list)
    catalog: list[SourcingReviewCatalogEntryOut] = Field(default_factory=list)
