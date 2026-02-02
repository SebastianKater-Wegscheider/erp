from __future__ import annotations

from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.core.enums import OpexCategory, PaymentSource


class OpexCreate(BaseModel):
    expense_date: date
    recipient: str = Field(min_length=1, max_length=200)
    category: OpexCategory
    amount_cents: int = Field(ge=0)
    payment_source: PaymentSource
    receipt_upload_path: str | None = Field(default=None, max_length=500)


class OpexOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    expense_date: date
    recipient: str
    category: OpexCategory
    amount_cents: int
    payment_source: PaymentSource
    receipt_upload_path: str | None
    created_at: datetime
    updated_at: datetime

