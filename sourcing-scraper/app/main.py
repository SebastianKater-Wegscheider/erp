from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.config import get_settings
from app.platforms.kleinanzeigen import scrape_kleinanzeigen


class ScrapeRequest(BaseModel):
    platform: str = Field(default="kleinanzeigen")
    search_terms: list[str] = Field(default_factory=list)


class ScrapeResponse(BaseModel):
    platform: str
    blocked: bool
    error_type: str | None
    error_message: str | None
    listings: list[dict]


app = FastAPI(title="sourcing-scraper", version="1.0")


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/scrape", response_model=ScrapeResponse)
async def scrape(req: ScrapeRequest) -> ScrapeResponse:
    settings = get_settings()

    platform = (req.platform or "kleinanzeigen").strip().lower()
    if platform != "kleinanzeigen":
        return ScrapeResponse(
            platform=platform.upper(),
            blocked=False,
            error_type="unsupported_platform",
            error_message=f"Unsupported platform: {platform}",
            listings=[],
        )

    terms = [term.strip() for term in req.search_terms if term.strip()]
    if not terms:
        terms = ["videospiele konvolut"]

    result = await scrape_kleinanzeigen(
        search_terms=terms,
        timeout_seconds=settings.sourcing_scraper_timeout_seconds,
        max_pages_per_term=settings.sourcing_scraper_max_pages_per_term,
        min_delay_seconds=settings.sourcing_scraper_min_delay_seconds,
        max_delay_seconds=settings.sourcing_scraper_max_delay_seconds,
    )

    return ScrapeResponse(
        platform="KLEINANZEIGEN",
        blocked=result.blocked,
        error_type=result.error_type,
        error_message=result.error_message,
        listings=result.listings,
    )
