from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.enums import MileagePurpose


class MileageCreate(BaseModel):
    log_date: date
    start_location: str = Field(min_length=1, max_length=200)
    destination: str = Field(min_length=1, max_length=200)
    purpose: MileagePurpose

    km: Decimal = Field(gt=Decimal("0"), description="Distance in kilometers (can be fractional)")
    purchase_id: UUID | None = None

    @field_validator("km")
    @classmethod
    def validate_km_precision(cls, v: Decimal) -> Decimal:
        if v.as_tuple().exponent < -3:
            raise ValueError("km supports up to 3 decimal places")
        return v


class MileageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    log_date: date
    start_location: str
    destination: str
    purpose: MileagePurpose
    distance_meters: int
    rate_cents_per_km: int
    amount_cents: int
    purchase_id: UUID | None
    created_at: datetime
    updated_at: datetime

