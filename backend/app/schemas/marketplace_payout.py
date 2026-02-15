from __future__ import annotations

from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.core.enums import OrderChannel


class MarketplacePayoutImportIn(BaseModel):
    csv_text: str = Field(min_length=1)
    delimiter: str | None = None
    source_label: str | None = None


class MarketplacePayoutImportRowError(BaseModel):
    row_number: int
    message: str
    external_payout_id: str | None = None


class MarketplacePayoutImportOut(BaseModel):
    total_rows: int
    imported_count: int
    skipped_count: int
    failed_count: int
    errors: list[MarketplacePayoutImportRowError] = Field(default_factory=list)


class MarketplacePayoutOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    channel: OrderChannel
    external_payout_id: str
    payout_date: date
    net_amount_cents: int
    ledger_entry_id: UUID | None
    created_at: datetime
    updated_at: datetime

