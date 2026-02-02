from __future__ import annotations

from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.core.enums import InventoryCondition, InventoryStatus, PurchaseType


class InventoryItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    master_product_id: UUID
    purchase_line_id: UUID | None

    condition: InventoryCondition
    purchase_type: PurchaseType
    purchase_price_cents: int
    allocated_costs_cents: int

    storage_location: str | None
    status: InventoryStatus
    acquired_date: date | None

    created_at: datetime
    updated_at: datetime


class InventoryItemUpdate(BaseModel):
    storage_location: str | None = Field(default=None, max_length=100)


class InventoryStatusTransition(BaseModel):
    new_status: InventoryStatus

