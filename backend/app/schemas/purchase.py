from __future__ import annotations

from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.enums import InventoryCondition, PaymentSource, PurchaseKind, PurchaseType


class PurchaseLineCreate(BaseModel):
    master_product_id: UUID
    condition: InventoryCondition
    purchase_type: PurchaseType
    purchase_price_cents: int = Field(ge=0)


class PurchaseCreate(BaseModel):
    kind: PurchaseKind
    purchase_date: date

    counterparty_name: str = Field(min_length=1, max_length=200)
    counterparty_address: str | None = None

    total_amount_cents: int = Field(ge=0)
    payment_source: PaymentSource

    # COMMERCIAL_REGULAR only
    external_invoice_number: str | None = Field(default=None, max_length=128)
    receipt_upload_path: str | None = Field(default=None, max_length=500)

    lines: list[PurchaseLineCreate] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_kind_fields(self) -> "PurchaseCreate":
        if self.kind == PurchaseKind.COMMERCIAL_REGULAR:
            if not self.external_invoice_number:
                raise ValueError("external_invoice_number is required for COMMERCIAL_REGULAR purchases")
            if not self.receipt_upload_path:
                raise ValueError("receipt_upload_path is required for COMMERCIAL_REGULAR purchases")
        return self


class PurchaseLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    master_product_id: UUID
    condition: InventoryCondition
    purchase_type: PurchaseType
    purchase_price_cents: int


class PurchaseOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    kind: PurchaseKind
    purchase_date: date

    counterparty_name: str
    counterparty_address: str | None

    total_amount_cents: int
    payment_source: PaymentSource

    document_number: str | None
    pdf_path: str | None
    external_invoice_number: str | None
    receipt_upload_path: str | None

    created_at: datetime
    updated_at: datetime
    lines: list[PurchaseLineOut]

