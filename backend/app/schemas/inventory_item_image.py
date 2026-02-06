from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class InventoryItemImageCreate(BaseModel):
    upload_path: str = Field(min_length=1, max_length=500)


class InventoryItemImageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    inventory_item_id: UUID
    upload_path: str
    created_at: datetime
    updated_at: datetime

