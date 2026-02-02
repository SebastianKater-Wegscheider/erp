from __future__ import annotations

from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.core.enums import PaymentSource, PurchaseType, ReturnAction


class SalesCorrectionLineCreate(BaseModel):
    inventory_item_id: UUID
    action: ReturnAction
    refund_gross_cents: int | None = Field(default=None, gt=0)


class SalesCorrectionCreate(BaseModel):
    correction_date: date
    payment_source: PaymentSource
    shipping_refund_gross_cents: int = Field(default=0, ge=0)
    lines: list[SalesCorrectionLineCreate] = Field(min_length=1)


class SalesCorrectionLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    inventory_item_id: UUID
    action: ReturnAction
    purchase_type: PurchaseType
    refund_gross_cents: int
    refund_net_cents: int
    refund_tax_cents: int
    tax_rate_bp: int


class SalesCorrectionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    order_id: UUID
    correction_date: date
    correction_number: str
    pdf_path: str | None
    refund_gross_cents: int
    shipping_refund_gross_cents: int
    payment_source: PaymentSource
    created_at: datetime
    updated_at: datetime
    lines: list[SalesCorrectionLineOut]

