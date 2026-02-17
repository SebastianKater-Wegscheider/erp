from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", "../.env"), env_file_encoding="utf-8", extra="ignore")

    agent_browser_url: str = Field("http://agent-browser:3000", alias="AGENT_BROWSER_URL")
    sourcing_scraper_timeout_seconds: int = Field(60, alias="SOURCING_SCRAPER_TIMEOUT_SECONDS")
    sourcing_scraper_max_pages_per_term: int = Field(1, alias="SOURCING_SCRAPER_MAX_PAGES_PER_TERM")
    sourcing_scraper_min_delay_seconds: float = Field(2.0, alias="SOURCING_SCRAPER_MIN_DELAY_SECONDS")
    sourcing_scraper_max_delay_seconds: float = Field(5.0, alias="SOURCING_SCRAPER_MAX_DELAY_SECONDS")


@lru_cache
def get_settings() -> Settings:
    return Settings()
