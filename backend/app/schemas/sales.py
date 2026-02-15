from __future__ import annotations

from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.core.enums import CashRecognition, OrderChannel, OrderStatus, PaymentSource, PurchaseType


class SalesOrderLineCreate(BaseModel):
    inventory_item_id: UUID
    sale_gross_cents: int = Field(gt=0)


class SalesOrderCreate(BaseModel):
    order_date: date
    channel: OrderChannel
    buyer_name: str = Field(min_length=1, max_length=200)
    buyer_address: str | None = None
    shipping_gross_cents: int = Field(ge=0)
    payment_source: PaymentSource
    lines: list[SalesOrderLineCreate] = Field(min_length=1)


class SalesOrderUpdate(SalesOrderCreate):
    pass


class SalesOrderLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    inventory_item_id: UUID
    purchase_type: PurchaseType
    sale_gross_cents: int
    sale_net_cents: int
    sale_tax_cents: int
    tax_rate_bp: int


class SalesOrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    order_date: date
    channel: OrderChannel
    status: OrderStatus
    cash_recognition: CashRecognition
    external_order_id: str | None
    buyer_name: str
    buyer_address: str | None
    shipping_gross_cents: int
    payment_source: PaymentSource
    invoice_number: str | None
    invoice_pdf_path: str | None
    created_at: datetime
    updated_at: datetime
    lines: list[SalesOrderLineOut]
