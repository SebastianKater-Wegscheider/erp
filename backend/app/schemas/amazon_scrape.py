from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class AmazonScrapeStatusOut(BaseModel):
    enabled: bool
    total_with_asin: int = Field(ge=0)
    stale: int = Field(ge=0)
    blocked_last: int = Field(ge=0)


class AmazonScrapeTriggerIn(BaseModel):
    master_product_id: UUID


class AmazonScrapeTriggerOut(BaseModel):
    run_id: UUID
    ok: bool
    blocked: bool
    error: str | None


class AmazonScrapeSalesRankOut(BaseModel):
    idx: int
    rank: int
    category: str
    raw: str | None


class AmazonScrapeBestPriceOut(BaseModel):
    condition_bucket: str
    price_total_cents: int
    currency: str

    source_offer_page: int | None
    source_offer_position: int | None
    source_seller_name: str | None


class AmazonScrapeRunOut(BaseModel):
    id: UUID
    master_product_id: UUID
    asin: str
    marketplace: str
    started_at: datetime
    finished_at: datetime | None

    ok: bool
    blocked: bool
    block_reason: str | None
    offers_truncated: bool
    error: str | None

    title: str | None
    dp_url: str | None
    offer_listing_url: str | None
    delivery_zip: str | None

    sales_ranks: list[AmazonScrapeSalesRankOut]
    best_prices: list[AmazonScrapeBestPriceOut]

