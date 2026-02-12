from __future__ import annotations

from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.enums import InventoryCondition, PaymentSource, PurchaseKind, PurchaseType


class PurchaseLineCreate(BaseModel):
    master_product_id: UUID
    condition: InventoryCondition
    purchase_type: PurchaseType
    purchase_price_cents: int | None = Field(default=None, ge=0)
    market_value_cents: int | None = Field(default=None, ge=0)
    held_privately_over_12_months: bool | None = None
    valuation_reason: str | None = Field(default=None, max_length=2000)


class PurchaseLineUpsert(BaseModel):
    id: UUID | None = None
    master_product_id: UUID
    condition: InventoryCondition
    purchase_type: PurchaseType
    purchase_price_cents: int | None = Field(default=None, ge=0)
    market_value_cents: int | None = Field(default=None, ge=0)
    held_privately_over_12_months: bool | None = None
    valuation_reason: str | None = Field(default=None, max_length=2000)


class PurchaseCreate(BaseModel):
    kind: PurchaseKind
    purchase_date: date

    counterparty_name: str = Field(min_length=1, max_length=200)
    counterparty_address: str | None = None
    counterparty_birthdate: date | None = None
    counterparty_id_number: str | None = Field(default=None, max_length=80)
    source_platform: str | None = Field(default=None, max_length=120)
    listing_url: str | None = Field(default=None, max_length=1000)
    notes: str | None = Field(default=None, max_length=4000)

    total_amount_cents: int = Field(ge=0)
    shipping_cost_cents: int = Field(default=0, ge=0)
    buyer_protection_fee_cents: int = Field(default=0, ge=0)
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
            if self.shipping_cost_cents != 0 or self.buyer_protection_fee_cents != 0:
                raise ValueError(
                    "shipping_cost_cents and buyer_protection_fee_cents must be 0 for COMMERCIAL_REGULAR purchases"
                )
            if not self.external_invoice_number:
                raise ValueError("external_invoice_number is required for COMMERCIAL_REGULAR purchases")
            if not self.receipt_upload_path:
                raise ValueError("receipt_upload_path is required for COMMERCIAL_REGULAR purchases")
            for line in self.lines:
                if line.purchase_price_cents is None:
                    raise ValueError("purchase_price_cents is required for COMMERCIAL_REGULAR purchase lines")
        elif self.kind == PurchaseKind.PRIVATE_EQUITY:
            self.tax_rate_bp = 0
            if self.shipping_cost_cents != 0 or self.buyer_protection_fee_cents != 0:
                raise ValueError(
                    "shipping_cost_cents and buyer_protection_fee_cents must be 0 for PRIVATE_EQUITY purchases"
                )
            for line in self.lines:
                if line.market_value_cents is None:
                    raise ValueError("market_value_cents is required for PRIVATE_EQUITY purchase lines")
        else:
            if self.tax_rate_bp is None:
                self.tax_rate_bp = 0
            if self.tax_rate_bp != 0:
                raise ValueError("tax_rate_bp must be 0 for PRIVATE_DIFF purchases")
            for line in self.lines:
                if line.purchase_price_cents is None:
                    raise ValueError("purchase_price_cents is required for PRIVATE_DIFF purchase lines")
        return self


class PurchaseUpdate(BaseModel):
    kind: PurchaseKind
    purchase_date: date

    counterparty_name: str = Field(min_length=1, max_length=200)
    counterparty_address: str | None = None
    counterparty_birthdate: date | None = None
    counterparty_id_number: str | None = Field(default=None, max_length=80)
    source_platform: str | None = Field(default=None, max_length=120)
    listing_url: str | None = Field(default=None, max_length=1000)
    notes: str | None = Field(default=None, max_length=4000)

    total_amount_cents: int = Field(ge=0)
    shipping_cost_cents: int = Field(default=0, ge=0)
    buyer_protection_fee_cents: int = Field(default=0, ge=0)
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
            if self.shipping_cost_cents != 0 or self.buyer_protection_fee_cents != 0:
                raise ValueError(
                    "shipping_cost_cents and buyer_protection_fee_cents must be 0 for COMMERCIAL_REGULAR purchases"
                )
            if not self.external_invoice_number:
                raise ValueError("external_invoice_number is required for COMMERCIAL_REGULAR purchases")
            if not self.receipt_upload_path:
                raise ValueError("receipt_upload_path is required for COMMERCIAL_REGULAR purchases")
            for line in self.lines:
                if line.purchase_price_cents is None:
                    raise ValueError("purchase_price_cents is required for COMMERCIAL_REGULAR purchase lines")
        elif self.kind == PurchaseKind.PRIVATE_EQUITY:
            self.tax_rate_bp = 0
            if self.shipping_cost_cents != 0 or self.buyer_protection_fee_cents != 0:
                raise ValueError(
                    "shipping_cost_cents and buyer_protection_fee_cents must be 0 for PRIVATE_EQUITY purchases"
                )
            for line in self.lines:
                if line.market_value_cents is None:
                    raise ValueError("market_value_cents is required for PRIVATE_EQUITY purchase lines")
        else:
            if self.tax_rate_bp is None:
                self.tax_rate_bp = 0
            if self.tax_rate_bp != 0:
                raise ValueError("tax_rate_bp must be 0 for PRIVATE_DIFF purchases")
            for line in self.lines:
                if line.purchase_price_cents is None:
                    raise ValueError("purchase_price_cents is required for PRIVATE_DIFF purchase lines")
        return self


class PurchaseLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    master_product_id: UUID
    condition: InventoryCondition
    purchase_type: PurchaseType
    purchase_price_cents: int
    shipping_allocated_cents: int
    buyer_protection_fee_allocated_cents: int
    purchase_price_net_cents: int
    purchase_price_tax_cents: int
    tax_rate_bp: int
    market_value_cents: int | None
    held_privately_over_12_months: bool | None
    valuation_reason: str | None


class PurchaseOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    kind: PurchaseKind
    purchase_date: date

    counterparty_name: str
    counterparty_address: str | None
    counterparty_birthdate: date | None
    counterparty_id_number: str | None
    source_platform: str | None
    listing_url: str | None
    notes: str | None

    total_amount_cents: int
    shipping_cost_cents: int
    buyer_protection_fee_cents: int
    total_net_cents: int
    total_tax_cents: int
    tax_rate_bp: int
    payment_source: PaymentSource

    document_number: str | None
    pdf_path: str | None
    external_invoice_number: str | None
    receipt_upload_path: str | None
    primary_mileage_log_id: UUID | None

    created_at: datetime
    updated_at: datetime
    lines: list[PurchaseLineOut]


class PurchaseRefOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    purchase_date: date
    counterparty_name: str
    total_amount_cents: int
    shipping_cost_cents: int
    buyer_protection_fee_cents: int
    source_platform: str | None
    document_number: str | None
