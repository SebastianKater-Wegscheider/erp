from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator


class PurchaseMileageUpsert(BaseModel):
    log_date: date
    start_location: str = Field(min_length=1, max_length=200)
    destination: str = Field(min_length=1, max_length=200)
    km: Decimal = Field(gt=Decimal("0"), description="Distance in kilometers (can be fractional)")
    purpose_text: str | None = Field(default=None, max_length=300)

    @field_validator("km")
    @classmethod
    def validate_km_precision(cls, value: Decimal) -> Decimal:
        if value.as_tuple().exponent < -3:
            raise ValueError("km supports up to 3 decimal places")
        return value
