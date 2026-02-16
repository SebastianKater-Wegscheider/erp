from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.enums import EffectiveTargetPriceSource, InventoryCondition, InventoryStatus, PurchaseType, TargetPriceMode


class TargetPriceRecommendationOut(BaseModel):
    strategy: str
    recommended_target_sell_price_cents: int
    anchor_price_cents: int | None = None
    anchor_source: str
    rank: int | None = None
    offers_count: int | None = None
    adjustment_bp: int
    margin_floor_net_cents: int
    margin_floor_price_cents: int
    summary: str


class InventoryItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    item_code: str
    master_product_id: UUID
    purchase_line_id: UUID | None

    condition: InventoryCondition
    purchase_type: PurchaseType
    purchase_price_cents: int
    allocated_costs_cents: int

    storage_location: str | None
    serial_number: str | None
    status: InventoryStatus
    acquired_date: date | None

    created_at: datetime
    updated_at: datetime

    # --- Target pricing (enriched by endpoint, not from ORM) ---
    target_price_mode: TargetPriceMode = TargetPriceMode.AUTO
    manual_target_sell_price_cents: int | None = None
    recommended_target_sell_price_cents: int | None = None
    effective_target_sell_price_cents: int | None = None
    effective_target_price_source: EffectiveTargetPriceSource = EffectiveTargetPriceSource.UNPRICED
    target_price_recommendation: TargetPriceRecommendationOut | None = None


class InventoryItemUpdate(BaseModel):
    storage_location: str | None = Field(default=None, max_length=100)
    serial_number: str | None = Field(default=None, max_length=120)
    target_price_mode: TargetPriceMode | None = None
    manual_target_sell_price_cents: int | None = None

    @model_validator(mode="after")
    def _validate_manual_price(self) -> "InventoryItemUpdate":
        if self.target_price_mode == TargetPriceMode.MANUAL:
            if self.manual_target_sell_price_cents is None:
                raise ValueError("manual_target_sell_price_cents is required when target_price_mode is MANUAL")
            if self.manual_target_sell_price_cents < 0:
                raise ValueError("manual_target_sell_price_cents must be >= 0")
        return self


class InventoryStatusTransition(BaseModel):
    new_status: InventoryStatus


# ---------------------------------------------------------------------------
# Bulk target pricing
# ---------------------------------------------------------------------------

class BulkTargetPricingFilters(BaseModel):
    match_status: list[InventoryStatus] | None = None
    match_target_price_mode: list[TargetPriceMode] | None = None
    match_search_query: str | None = None
    match_asin_state: list[str] | None = None  # "MISSING", "FRESH", "STALE", "BLOCKED"


class BulkTargetPricingRequest(BaseModel):
    filters: BulkTargetPricingFilters = Field(default_factory=BulkTargetPricingFilters)
    set_target_price_mode: TargetPriceMode
    set_manual_target_sell_price_cents: int | None = None


class BulkTargetPricingPreviewRow(BaseModel):
    item_id: UUID
    item_code: str
    title: str
    current_mode: TargetPriceMode
    current_effective_cents: int | None
    new_mode: TargetPriceMode
    new_manual_cents: int | None
    new_effective_cents: int | None
    new_effective_source: str
    diff_cents: int | None


class BulkTargetPricingPreviewResponse(BaseModel):
    total_items_matched: int = Field(ge=0)
    total_items_changed: int = Field(ge=0)
    preview_rows: list[BulkTargetPricingPreviewRow]


class BulkTargetPricingApplyResponse(BaseModel):
    updated_count: int = Field(ge=0)

