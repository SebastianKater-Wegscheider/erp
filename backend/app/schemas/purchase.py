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


class PurchaseLineUpsert(BaseModel):
    id: UUID | None = None
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
    tax_rate_bp: int | None = Field(default=None, ge=0, le=10000)
    payment_source: PaymentSource

    # COMMERCIAL_REGULAR only
    external_invoice_number: str | None = Field(default=None, max_length=128)
    receipt_upload_path: str | None = Field(default=None, max_length=500)

    lines: list[PurchaseLineCreate] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_kind_fields(self) -> "PurchaseCreate":
        if self.kind == PurchaseKind.COMMERCIAL_REGULAR:
            if self.tax_rate_bp is None:
                self.tax_rate_bp = 2000
            if self.tax_rate_bp <= 0:
                raise ValueError("tax_rate_bp must be > 0 for COMMERCIAL_REGULAR purchases")
            if not self.external_invoice_number:
                raise ValueError("external_invoice_number is required for COMMERCIAL_REGULAR purchases")
            if not self.receipt_upload_path:
                raise ValueError("receipt_upload_path is required for COMMERCIAL_REGULAR purchases")
        else:
            if self.tax_rate_bp is None:
                self.tax_rate_bp = 0
            if self.tax_rate_bp != 0:
                raise ValueError("tax_rate_bp must be 0 for PRIVATE_DIFF purchases")
        return self


class PurchaseUpdate(BaseModel):
    kind: PurchaseKind
    purchase_date: date

    counterparty_name: str = Field(min_length=1, max_length=200)
    counterparty_address: str | None = None

    total_amount_cents: int = Field(ge=0)
    tax_rate_bp: int | None = Field(default=None, ge=0, le=10000)
    payment_source: PaymentSource

    # COMMERCIAL_REGULAR only
    external_invoice_number: str | None = Field(default=None, max_length=128)
    receipt_upload_path: str | None = Field(default=None, max_length=500)

    lines: list[PurchaseLineUpsert] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_kind_fields(self) -> "PurchaseUpdate":
        if self.kind == PurchaseKind.COMMERCIAL_REGULAR:
            if self.tax_rate_bp is None:
                self.tax_rate_bp = 2000
            if self.tax_rate_bp <= 0:
                raise ValueError("tax_rate_bp must be > 0 for COMMERCIAL_REGULAR purchases")
            if not self.external_invoice_number:
                raise ValueError("external_invoice_number is required for COMMERCIAL_REGULAR purchases")
            if not self.receipt_upload_path:
                raise ValueError("receipt_upload_path is required for COMMERCIAL_REGULAR purchases")
        else:
            if self.tax_rate_bp is None:
                self.tax_rate_bp = 0
            if self.tax_rate_bp != 0:
                raise ValueError("tax_rate_bp must be 0 for PRIVATE_DIFF purchases")
        return self


class PurchaseLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    master_product_id: UUID
    condition: InventoryCondition
    purchase_type: PurchaseType
    purchase_price_cents: int
    purchase_price_net_cents: int
    purchase_price_tax_cents: int
    tax_rate_bp: int


class PurchaseOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    kind: PurchaseKind
    purchase_date: date

    counterparty_name: str
    counterparty_address: str | None

    total_amount_cents: int
    total_net_cents: int
    total_tax_cents: int
    tax_rate_bp: int
    payment_source: PaymentSource

    document_number: str | None
    pdf_path: str | None
    external_invoice_number: str | None
    receipt_upload_path: str | None

    created_at: datetime
    updated_at: datetime
    lines: list[PurchaseLineOut]


class PurchaseRefOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    purchase_date: date
    counterparty_name: str
    total_amount_cents: int
    document_number: str | None
