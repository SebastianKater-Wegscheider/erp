from __future__ import annotations

from datetime import date
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


DEFAULT_COMPANY_NAME = "Sebastian Kater-Wegscheider"
DEFAULT_COMPANY_ADDRESS = "Im Gütle 8\n6921 Kennelbach\nÖsterreich"
DEFAULT_COMPANY_EMAIL = "business@kater.cloud"
DEFAULT_SMALL_BUSINESS_NOTICE = "Steuerfrei gemäß § 6 Abs. 1 Z 27 UStG (Kleinunternehmerregelung)."

_PLACEHOLDER_COMPANY_NAME = "Your Company Name"
_PLACEHOLDER_COMPANY_ADDRESS = "Street 1\n1010 Wien\nAustria"
_PLACEHOLDER_COMPANY_EMAIL = "you@example.com"


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

    # Defaults are hard-coded to the real business data (per repo requirements).
    company_name: str = Field(DEFAULT_COMPANY_NAME, alias="COMPANY_NAME")
    company_address: str = Field(DEFAULT_COMPANY_ADDRESS, alias="COMPANY_ADDRESS")
    company_email: str | None = Field(DEFAULT_COMPANY_EMAIL, alias="COMPANY_EMAIL")
    company_vat_id: str | None = Field(None, alias="COMPANY_VAT_ID")
    company_logo_path: str | None = Field(None, alias="COMPANY_LOGO_PATH")
    company_small_business_notice: str | None = Field(
        DEFAULT_SMALL_BUSINESS_NOTICE,
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

    @field_validator("company_name", mode="before")
    @classmethod
    def _normalize_company_name(cls, v: object) -> object:
        if isinstance(v, str):
            name = v.strip()
            if name == _PLACEHOLDER_COMPANY_NAME:
                return DEFAULT_COMPANY_NAME
            return name
        return v

    @field_validator("company_address", mode="before")
    @classmethod
    def _normalize_company_address(cls, v: object) -> object:
        # `.env.example` uses "\n" escapes; convert them to real newlines so PDFs render nicely.
        if isinstance(v, str):
            normalized = v.replace("\\n", "\n").replace("\r\n", "\n").strip()
            if normalized == _PLACEHOLDER_COMPANY_ADDRESS:
                return DEFAULT_COMPANY_ADDRESS
            return normalized
        return v

    @field_validator("company_email", mode="before")
    @classmethod
    def _normalize_company_email(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            email = v.strip()
            if not email:
                return None
            if email == _PLACEHOLDER_COMPANY_EMAIL:
                return DEFAULT_COMPANY_EMAIL
            return email
        return v

    @field_validator("company_vat_id", mode="before")
    @classmethod
    def _normalize_company_vat_id(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            vat = v.strip()
            return vat or None
        return v

    @field_validator("company_logo_path", mode="before")
    @classmethod
    def _normalize_company_logo_path(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            path = v.strip()
            if not path:
                return None
            # WeasyPrint expects URLs; for absolute filesystem paths, prefix `file://`.
            if path.startswith("/") and "://" not in path:
                return f"file://{path}"
            return path
        return v

    @field_validator("company_small_business_notice", mode="before")
    @classmethod
    def _normalize_company_small_business_notice(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            notice = v.strip()
            return notice or None
        return v

    @model_validator(mode="after")
    def _ensure_legal_defaults(self) -> "Settings":
        # If VAT ID is not set, assume Kleinunternehmer unless explicitly overridden.
        if not self.company_vat_id and not self.company_small_business_notice:
            self.company_small_business_notice = DEFAULT_SMALL_BUSINESS_NOTICE
        return self

    @property
    def pdf_dir(self) -> Path:
        return self.app_storage_dir / "pdfs"

    @property
    def upload_dir(self) -> Path:
        return self.app_storage_dir / "uploads"

    @property
    def vat_enabled(self) -> bool:
        """
        Feature flag for full VAT handling (regular + margin scheme).

        If the Kleinunternehmerregelung notice is set, VAT is treated as disabled across the app.
        """
        return self.company_small_business_notice is None


@lru_cache
def get_settings() -> Settings:
    return Settings()
