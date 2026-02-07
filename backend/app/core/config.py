from __future__ import annotations

from datetime import date
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = Field(..., alias="DATABASE_URL")
    app_storage_dir: Path = Field(Path("/data"), alias="APP_STORAGE_DIR")

    basic_auth_username: str = Field(..., alias="BASIC_AUTH_USERNAME")
    basic_auth_password: str = Field(..., alias="BASIC_AUTH_PASSWORD")

    mileage_rate_cents_per_km: int = Field(42, alias="MILEAGE_RATE_CENTS_PER_KM")

    company_name: str = Field("Sebastian Kater-Wegscheider", alias="COMPANY_NAME")
    company_address: str = Field("Im Gütle 8\n6921 Kennelbach\nÖsterreich", alias="COMPANY_ADDRESS")
    company_email: str | None = Field("business@kater.cloud", alias="COMPANY_EMAIL")
    company_vat_id: str | None = Field(None, alias="COMPANY_VAT_ID")
    company_small_business_notice: str | None = Field(
        "Gemäß § 6 Abs. 1 Z 27 UStG wird keine Umsatzsteuer berechnet.",
        alias="COMPANY_SMALL_BUSINESS_NOTICE",
    )

    cors_origins: str | None = Field(None, alias="CORS_ORIGINS")

    # --- Bank transaction sync ---
    bank_sync_enabled: bool = Field(True, alias="BANK_SYNC_ENABLED")
    bank_sync_interval_seconds: int = Field(900, alias="BANK_SYNC_INTERVAL_SECONDS")
    bank_sync_start_date: date | None = Field(None, alias="BANK_SYNC_START_DATE")
    bank_sync_overlap_days: int = Field(14, alias="BANK_SYNC_OVERLAP_DAYS")
    bank_sync_initial_lookback_days: int = Field(365 * 5, alias="BANK_SYNC_INITIAL_LOOKBACK_DAYS")

    # --- GoCardless ---
    # GoCardless Pro (Direct Debit) access token.
    gocardless_token: str | None = Field(None, alias="GOCARDLESS_TOKEN")

    # GoCardless Bank Account Data (Open Banking, formerly Nordigen).
    gocardless_bank_data_base_url: str = Field(
        "https://bankaccountdata.gocardless.com/api/v2",
        alias="GOCARDLESS_BANK_DATA_BASE_URL",
    )
    gocardless_bank_data_secret_id: str | None = Field(None, alias="GOCARDLESS_BANK_DATA_SECRET_ID")
    gocardless_bank_data_secret_key: str | None = Field(None, alias="GOCARDLESS_BANK_DATA_SECRET_KEY")
    gocardless_bank_data_access_token: str | None = Field(None, alias="GOCARDLESS_BANK_DATA_ACCESS_TOKEN")
    gocardless_bank_data_requisition_ids: str | None = Field(None, alias="GOCARDLESS_BANK_DATA_REQUISITION_IDS")

    @field_validator("company_address", mode="before")
    @classmethod
    def _normalize_company_address(cls, v: object) -> object:
        # `.env.example` uses "\n" escapes; convert them to real newlines so PDFs render nicely.
        if isinstance(v, str):
            return v.replace("\\n", "\n").replace("\r\n", "\n")
        return v

    @property
    def pdf_dir(self) -> Path:
        return self.app_storage_dir / "pdfs"

    @property
    def upload_dir(self) -> Path:
        return self.app_storage_dir / "uploads"


@lru_cache
def get_settings() -> Settings:
    return Settings()
