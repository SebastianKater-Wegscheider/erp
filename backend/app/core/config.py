from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
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

    company_name: str = Field("Reseller ERP", alias="COMPANY_NAME")
    company_address: str = Field("", alias="COMPANY_ADDRESS")
    company_email: str | None = Field(None, alias="COMPANY_EMAIL")
    company_vat_id: str | None = Field(None, alias="COMPANY_VAT_ID")

    cors_origins: str | None = Field(None, alias="CORS_ORIGINS")

    @property
    def pdf_dir(self) -> Path:
        return self.app_storage_dir / "pdfs"

    @property
    def upload_dir(self) -> Path:
        return self.app_storage_dir / "uploads"


@lru_cache
def get_settings() -> Settings:
    return Settings()
