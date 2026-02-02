from __future__ import annotations

from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.enums import PaymentSource


class CostAllocationLineCreate(BaseModel):
    inventory_item_id: UUID
    amount_cents: int = Field(gt=0)


class CostAllocationCreate(BaseModel):
    allocation_date: date
    description: str = Field(min_length=1)
    amount_cents: int = Field(gt=0)
    tax_rate_bp: int = Field(default=2000, ge=0, le=10000)
    input_tax_deductible: bool = True
    payment_source: PaymentSource
    receipt_upload_path: str | None = Field(default=None, max_length=500)
    lines: list[CostAllocationLineCreate] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_sum(self) -> "CostAllocationCreate":
        if sum(line.amount_cents for line in self.lines) != self.amount_cents:
            raise ValueError("Sum(lines.amount_cents) must equal amount_cents")
        return self


class CostAllocationLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    inventory_item_id: UUID
    amount_cents: int
    amount_net_cents: int
    amount_tax_cents: int


class CostAllocationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    allocation_date: date
    description: str
    amount_cents: int
    amount_net_cents: int
    amount_tax_cents: int
    tax_rate_bp: int
    input_tax_deductible: bool
    payment_source: PaymentSource
    receipt_upload_path: str | None
    created_at: datetime
    updated_at: datetime
    lines: list[CostAllocationLineOut]
