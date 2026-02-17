from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", "../.env"), env_file_encoding="utf-8", extra="ignore")

    agent_browser_url: str = Field("http://agent-browser:3000", alias="AGENT_BROWSER_URL")
    sourcing_scraper_use_agent_browser: bool = Field(True, alias="SOURCING_SCRAPER_USE_AGENT_BROWSER")
    sourcing_scraper_agent_browser_profile_path: str = Field(
        "/app/.agent-browser/profiles/kleinanzeigen",
        alias="SOURCING_SCRAPER_AGENT_BROWSER_PROFILE_PATH",
    )
    sourcing_scraper_agent_browser_session_name: str = Field(
        "sourcing-kleinanzeigen",
        alias="SOURCING_SCRAPER_AGENT_BROWSER_SESSION_NAME",
    )
    sourcing_scraper_timeout_seconds: int = Field(60, alias="SOURCING_SCRAPER_TIMEOUT_SECONDS")
    sourcing_scraper_max_pages_per_term: int = Field(3, alias="SOURCING_SCRAPER_MAX_PAGES_PER_TERM")
    sourcing_scraper_min_delay_seconds: float = Field(2.0, alias="SOURCING_SCRAPER_MIN_DELAY_SECONDS")
    sourcing_scraper_max_delay_seconds: float = Field(5.0, alias="SOURCING_SCRAPER_MAX_DELAY_SECONDS")


@lru_cache
def get_settings() -> Settings:
    return Settings()
