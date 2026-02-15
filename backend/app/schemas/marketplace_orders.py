from __future__ import annotations

from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.core.enums import MarketplaceMatchStrategy, MarketplaceStagedOrderStatus, OrderChannel


class MarketplaceOrdersImportIn(BaseModel):
    csv_text: str = Field(min_length=1)
    delimiter: str | None = None
    source_label: str | None = None


class MarketplaceOrdersImportRowError(BaseModel):
    row_number: int
    message: str
    external_order_id: str | None = None
    sku: str | None = None


class MarketplaceOrdersImportOut(BaseModel):
    batch_id: UUID
    total_rows: int
    staged_orders_count: int
    staged_lines_count: int
    ready_orders_count: int
    needs_attention_orders_count: int
    skipped_orders_count: int
    failed_count: int
    errors: list[MarketplaceOrdersImportRowError] = Field(default_factory=list)


class MarketplaceStagedOrderLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    sku: str
    title: str | None
    sale_gross_cents: int
    shipping_gross_cents: int
    matched_inventory_item_id: UUID | None
    match_strategy: MarketplaceMatchStrategy
    match_error: str | None
    created_at: datetime
    updated_at: datetime


class MarketplaceStagedOrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    batch_id: UUID | None
    channel: OrderChannel
    external_order_id: str
    order_date: date
    buyer_name: str
    buyer_address: str | None
    shipping_gross_cents: int
    status: MarketplaceStagedOrderStatus
    sales_order_id: UUID | None
    created_at: datetime
    updated_at: datetime
    lines: list[MarketplaceStagedOrderLineOut] = Field(default_factory=list)


class MarketplaceStagedOrderApplyIn(BaseModel):
    staged_order_ids: list[UUID] | None = None
    batch_id: UUID | None = None


class MarketplaceStagedOrderApplyResultOut(BaseModel):
    staged_order_id: UUID
    sales_order_id: UUID | None
    ok: bool
    error: str | None = None


class MarketplaceStagedOrderApplyOut(BaseModel):
    results: list[MarketplaceStagedOrderApplyResultOut] = Field(default_factory=list)

