from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.enums import MileagePurpose


class MileageCreate(BaseModel):
    log_date: date
    start_location: str = Field(min_length=1, max_length=200)
    destination: str = Field(min_length=1, max_length=200)
    purpose: MileagePurpose

    km: Decimal = Field(gt=Decimal("0"), description="Distance in kilometers (can be fractional)")
    # New: link one or more purchases (optional).
    purchase_ids: list[UUID] = Field(default_factory=list)
    # Legacy single-link (optional).
    purchase_id: UUID | None = None
    # Free-text purpose (optional; useful when no purchase is linked).
    purpose_text: str | None = Field(default=None, max_length=300)

    @field_validator("km")
    @classmethod
    def validate_km_precision(cls, v: Decimal) -> Decimal:
        if v.as_tuple().exponent < -3:
            raise ValueError("km supports up to 3 decimal places")
        return v

    @model_validator(mode="after")
    def normalize_purchase_links(self) -> "MileageCreate":
        # Backwards compatibility: allow sending purchase_id only.
        if self.purchase_id and not self.purchase_ids:
            self.purchase_ids = [self.purchase_id]

        # Ensure deterministic order and no duplicates.
        if self.purchase_ids:
            seen: set[UUID] = set()
            uniq: list[UUID] = []
            for pid in self.purchase_ids:
                if pid in seen:
                    continue
                seen.add(pid)
                uniq.append(pid)
            self.purchase_ids = uniq
        return self


class MileageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    log_date: date
    start_location: str
    destination: str
    purpose: MileagePurpose
    purpose_text: str | None
    distance_meters: int
    rate_cents_per_km: int
    amount_cents: int
    purchase_ids: list[UUID]
    purchase_id: UUID | None
    created_at: datetime
    updated_at: datetime
