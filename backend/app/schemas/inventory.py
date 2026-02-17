from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.enums import EffectiveTargetPriceSource, InventoryCondition, InventoryStatus, PurchaseType, TargetPriceMode


class TargetPriceRecommendationStrategy(StrEnum):
    MARGIN_FIRST = "MARGIN_FIRST"


class TargetPriceAnchorSource(StrEnum):
    AMAZON_CONDITION = "AMAZON_CONDITION"
    AMAZON_BUYBOX = "AMAZON_BUYBOX"
    NONE = "NONE"


class TargetPriceRecommendationOut(BaseModel):
    strategy: TargetPriceRecommendationStrategy
    recommended_target_sell_price_cents: int
    anchor_price_cents: int | None = None
    anchor_source: TargetPriceAnchorSource
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
        if self.manual_target_sell_price_cents is not None and self.manual_target_sell_price_cents < 0:
            raise ValueError("manual_target_sell_price_cents must be >= 0")
        if self.target_price_mode == TargetPriceMode.MANUAL:
            if self.manual_target_sell_price_cents is None:
                raise ValueError("manual_target_sell_price_cents is required when target_price_mode is MANUAL")
        return self


class InventoryStatusTransition(BaseModel):
    new_status: InventoryStatus


# ---------------------------------------------------------------------------
# Bulk target pricing
# ---------------------------------------------------------------------------

class TargetPricingAsinState(StrEnum):
    ANY = "ANY"
    WITH_ASIN = "WITH_ASIN"
    WITHOUT_ASIN = "WITHOUT_ASIN"


class TargetPricingBulkOperation(StrEnum):
    APPLY_RECOMMENDED_MANUAL = "APPLY_RECOMMENDED_MANUAL"
    CLEAR_MANUAL_USE_AUTO = "CLEAR_MANUAL_USE_AUTO"


class TargetPricingBulkFilters(BaseModel):
    conditions: list[InventoryCondition] | None = None
    asin_state: TargetPricingAsinState = TargetPricingAsinState.ANY
    bsr_min: int | None = Field(default=None, ge=0)
    bsr_max: int | None = Field(default=None, ge=0)
    offers_min: int | None = Field(default=None, ge=0)
    offers_max: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _validate_ranges(self) -> "TargetPricingBulkFilters":
        if self.bsr_min is not None and self.bsr_max is not None and self.bsr_min > self.bsr_max:
            raise ValueError("bsr_min must be <= bsr_max")
        if self.offers_min is not None and self.offers_max is not None and self.offers_min > self.offers_max:
            raise ValueError("offers_min must be <= offers_max")
        return self


class TargetPricingBulkRequest(BaseModel):
    filters: TargetPricingBulkFilters = Field(default_factory=TargetPricingBulkFilters)
    operation: TargetPricingBulkOperation


class TargetPricingBulkPreviewRowOut(BaseModel):
    item_id: UUID
    item_code: str
    title: str
    condition: InventoryCondition
    asin: str | None = None
    rank: int | None = None
    offers_count: int | None = None
    before_target_price_mode: TargetPriceMode
    before_effective_target_sell_price_cents: int | None = None
    before_effective_target_price_source: EffectiveTargetPriceSource
    after_target_price_mode: TargetPriceMode
    after_effective_target_sell_price_cents: int | None = None
    after_effective_target_price_source: EffectiveTargetPriceSource
    delta_cents: int | None = None


class TargetPricingBulkPreviewOut(BaseModel):
    matched_count: int = Field(ge=0)
    applicable_count: int = Field(ge=0)
    truncated: bool
    rows: list[TargetPricingBulkPreviewRowOut]


class TargetPricingBulkApplyOut(BaseModel):
    matched_count: int = Field(ge=0)
    updated_count: int = Field(ge=0)
    skipped_count: int = Field(ge=0)
    sample_updated_item_ids: list[UUID]
