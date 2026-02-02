from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field


class DashboardOut(BaseModel):
    inventory_value_cents: int = Field(ge=0)
    cash_balance_cents: dict[str, int]
    gross_profit_month_cents: int


class MonthlyCloseParams(BaseModel):
    year: int = Field(ge=2000, le=2100)
    month: int = Field(ge=1, le=12)


class MonthlyCloseOut(BaseModel):
    filename: str
    generated_date: date

