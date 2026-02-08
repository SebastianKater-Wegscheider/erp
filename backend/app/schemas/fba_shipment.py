from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.enums import FBACostDistributionMethod, FBAShipmentStatus, InventoryStatus


class FBAShipmentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    item_ids: list[UUID] = Field(default_factory=list)
    shipping_cost_cents: int = Field(default=0, ge=0)
    cost_distribution_method: FBACostDistributionMethod = FBACostDistributionMethod.EQUAL
    carrier: str | None = Field(default=None, max_length=80)
    tracking_number: str | None = Field(default=None, max_length=120)

    @field_validator("item_ids")
    @classmethod
    def unique_item_ids(cls, value: list[UUID]) -> list[UUID]:
        if len(set(value)) != len(value):
            raise ValueError("item_ids must be unique")
        return value


class FBAShipmentUpdateDraft(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=180)
    item_ids: list[UUID] | None = None
    shipping_cost_cents: int | None = Field(default=None, ge=0)
    cost_distribution_method: FBACostDistributionMethod | None = None
    carrier: str | None = Field(default=None, max_length=80)
    tracking_number: str | None = Field(default=None, max_length=120)

    @field_validator("item_ids")
    @classmethod
    def unique_item_ids(cls, value: list[UUID] | None) -> list[UUID] | None:
        if value is None:
            return value
        if len(set(value)) != len(value):
            raise ValueError("item_ids must be unique")
        return value


class FBAShipmentReceiveDiscrepancy(BaseModel):
    inventory_item_id: UUID
    status: InventoryStatus
    note: str | None = Field(default=None, max_length=1000)

    @field_validator("status")
    @classmethod
    def validate_status(cls, value: InventoryStatus) -> InventoryStatus:
        if value not in (InventoryStatus.LOST, InventoryStatus.DISCREPANCY):
            raise ValueError("status must be LOST or DISCREPANCY")
        return value


class FBAShipmentReceive(BaseModel):
    discrepancies: list[FBAShipmentReceiveDiscrepancy] = Field(default_factory=list)

    @model_validator(mode="after")
    def unique_discrepancy_items(self) -> "FBAShipmentReceive":
        ids = [d.inventory_item_id for d in self.discrepancies]
        if len(set(ids)) != len(ids):
            raise ValueError("discrepancies must not contain duplicate inventory_item_id")
        return self


class FBAShipmentItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    inventory_item_id: UUID
    allocated_shipping_cost_cents: int
    received_status: InventoryStatus | None
    discrepancy_note: str | None


class FBAShipmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    status: FBAShipmentStatus
    carrier: str | None
    tracking_number: str | None
    shipping_cost_cents: int
    cost_distribution_method: FBACostDistributionMethod
    shipped_at: datetime | None
    received_at: datetime | None
    created_at: datetime
    updated_at: datetime
    items: list[FBAShipmentItemOut]
