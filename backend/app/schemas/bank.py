from __future__ import annotations

from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class BankAccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    provider: str
    external_id: str
    iban: str | None
    name: str | None
    currency: str | None
    last_synced_at: datetime | None
    created_at: datetime
    updated_at: datetime


class BankTransactionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    bank_account_id: UUID
    external_id: str
    booked_date: date
    value_date: date | None
    amount_cents: int
    currency: str
    counterparty_name: str | None
    remittance_information: str | None
    is_pending: bool
    purchase_ids: list[UUID] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class BankTransactionLink(BaseModel):
    purchase_ids: list[UUID] = Field(default_factory=list)


class BankSyncOut(BaseModel):
    accounts_seen: int
    accounts_created: int
    transactions_seen: int
    transactions_created: int
    transactions_updated: int

