from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field


class DashboardOut(BaseModel):
    inventory_value_cents: int = Field(ge=0)
    cash_balance_cents: dict[str, int]
    gross_profit_month_cents: int


class ResellerDashboardTimeseriesPoint(BaseModel):
    date: str
    revenue_cents: int
    profit_cents: int
    orders_count: int = Field(ge=0)


class ResellerDashboardAgingBucket(BaseModel):
    label: str
    count: int = Field(ge=0)
    value_cents: int = Field(ge=0)


class ResellerDashboardProductAgg(BaseModel):
    master_product_id: str
    sku: str
    title: str
    platform: str
    region: str
    variant: str
    units_sold: int = Field(ge=0)
    revenue_cents: int
    profit_cents: int


class ResellerDashboardOut(BaseModel):
    inventory_value_cents: int = Field(ge=0)
    cash_balance_cents: dict[str, int]
    gross_profit_month_cents: int

    sales_revenue_30d_cents: int
    gross_profit_30d_cents: int
    sales_timeseries: list[ResellerDashboardTimeseriesPoint]
    revenue_by_channel_30d_cents: dict[str, int]

    inventory_status_counts: dict[str, int]
    inventory_aging: list[ResellerDashboardAgingBucket]

    sales_orders_draft_count: int = Field(ge=0)
    finalized_orders_missing_invoice_pdf_count: int = Field(ge=0)
    inventory_draft_count: int = Field(ge=0)
    inventory_reserved_count: int = Field(ge=0)
    inventory_returned_count: int = Field(ge=0)
    negative_profit_orders_30d_count: int = Field(ge=0)
    master_products_missing_asin_count: int = Field(ge=0)

    top_products_30d: list[ResellerDashboardProductAgg]
    worst_products_30d: list[ResellerDashboardProductAgg]


class MonthlyCloseParams(BaseModel):
    year: int = Field(ge=2000, le=2100)
    month: int = Field(ge=1, le=12)


class MonthlyCloseOut(BaseModel):
    filename: str
    generated_date: date


class VatReportParams(BaseModel):
    year: int = Field(ge=2000, le=2100)
    month: int = Field(ge=1, le=12)


class VatReportOut(BaseModel):
    period_start: str
    period_end: str
    output_vat_regular_cents: int
    output_vat_margin_cents: int
    output_vat_adjustments_regular_cents: int
    output_vat_adjustments_margin_cents: int
    input_vat_cents: int
    vat_payable_cents: int


class TaxProfileOut(BaseModel):
    vat_enabled: bool
    small_business_notice: str | None
