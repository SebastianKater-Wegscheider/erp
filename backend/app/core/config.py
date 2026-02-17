from __future__ import annotations

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

    # --- Amazon (ASIN) scrape metrics ---
    amazon_scraper_enabled: bool = Field(False, alias="AMAZON_SCRAPER_ENABLED")
    amazon_scraper_base_url: str = Field("http://192.168.178.72:4236", alias="AMAZON_SCRAPER_BASE_URL")
    amazon_scraper_timeout_seconds: int = Field(120, alias="AMAZON_SCRAPER_TIMEOUT_SECONDS")
    amazon_scraper_loop_tick_seconds: int = Field(180, alias="AMAZON_SCRAPER_LOOP_TICK_SECONDS")
    amazon_scraper_min_success_interval_seconds: int = Field(172800, alias="AMAZON_SCRAPER_MIN_SUCCESS_INTERVAL_SECONDS")
    amazon_scraper_max_backoff_seconds: int = Field(43200, alias="AMAZON_SCRAPER_MAX_BACKOFF_SECONDS")
    amazon_scraper_lock_ttl_seconds: int = Field(300, alias="AMAZON_SCRAPER_LOCK_TTL_SECONDS")
    amazon_scraper_busy_retry_min_seconds: int = Field(90, alias="AMAZON_SCRAPER_BUSY_RETRY_MIN_SECONDS")
    amazon_scraper_busy_retry_max_seconds: int = Field(240, alias="AMAZON_SCRAPER_BUSY_RETRY_MAX_SECONDS")
    amazon_scraper_busy_global_cooldown_seconds: int = Field(45, alias="AMAZON_SCRAPER_BUSY_GLOBAL_COOLDOWN_SECONDS")
    amazon_scraper_fetch_max_attempts: int = Field(2, alias="AMAZON_SCRAPER_FETCH_MAX_ATTEMPTS")

    # --- Sourcing radar ---
    sourcing_enabled: bool = Field(False, alias="SOURCING_ENABLED")
    sourcing_kleinanzeigen_enabled: bool = Field(True, alias="SOURCING_KLEINANZEIGEN_ENABLED")
    sourcing_conversion_enabled: bool = Field(False, alias="SOURCING_CONVERSION_ENABLED")
    sourcing_scraper_base_url: str = Field("http://sourcing-scraper:8000", alias="SOURCING_SCRAPER_BASE_URL")
    sourcing_scraper_timeout_seconds: int = Field(60, alias="SOURCING_SCRAPER_TIMEOUT_SECONDS")
    sourcing_loop_tick_seconds: int = Field(60, alias="SOURCING_LOOP_TICK_SECONDS")
    sourcing_lock_ttl_seconds: int = Field(300, alias="SOURCING_LOCK_TTL_SECONDS")
    sourcing_default_interval_seconds: int = Field(1800, alias="SOURCING_DEFAULT_INTERVAL_SECONDS")
    sourcing_error_backoff_seconds: int = Field(300, alias="SOURCING_ERROR_BACKOFF_SECONDS")
    sourcing_match_confidence_min_score: int = Field(80, alias="SOURCING_MATCH_CONFIDENCE_MIN_SCORE")

    # Amazon fee estimates (global defaults; for margin heuristics, not accounting).
    amazon_fba_referral_fee_bp: int = Field(1500, alias="AMAZON_FBA_REFERRAL_FEE_BP")
    amazon_fba_fulfillment_fee_cents: int = Field(350, alias="AMAZON_FBA_FULFILLMENT_FEE_CENTS")
    amazon_fba_inbound_shipping_cents: int = Field(0, alias="AMAZON_FBA_INBOUND_SHIPPING_CENTS")

    # --- Target pricing engine ---
    target_pricing_margin_floor_bp: int = Field(2000, alias="TARGET_PRICING_MARGIN_FLOOR_BP")
    target_pricing_margin_floor_min_cents: int = Field(500, alias="TARGET_PRICING_MARGIN_FLOOR_MIN_CENTS")
    target_pricing_bsr_strong_max: int = Field(10000, alias="TARGET_PRICING_BSR_STRONG_MAX")
    target_pricing_bsr_weak_min: int = Field(80000, alias="TARGET_PRICING_BSR_WEAK_MIN")
    target_pricing_offers_low_max: int = Field(2, alias="TARGET_PRICING_OFFERS_LOW_MAX")
    target_pricing_offers_high_min: int = Field(12, alias="TARGET_PRICING_OFFERS_HIGH_MIN")

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
