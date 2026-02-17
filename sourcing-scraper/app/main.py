from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.config import get_settings
from app.platforms.ebay_de import scrape_ebay_de, scrape_ebay_de_listing_detail
from app.platforms.kleinanzeigen import scrape_kleinanzeigen, scrape_kleinanzeigen_listing_detail


class ScrapeRequest(BaseModel):
    platform: str = Field(default="kleinanzeigen")
    search_terms: list[str] = Field(default_factory=list)
    options: dict = Field(default_factory=dict)


class ScrapeResponse(BaseModel):
    platform: str
    blocked: bool
    error_type: str | None
    error_message: str | None
    listings: list[dict]


class ListingDetailRequest(BaseModel):
    platform: str = Field(default="kleinanzeigen")
    url: str


class ListingDetailResponse(BaseModel):
    platform: str
    blocked: bool
    error_type: str | None
    error_message: str | None
    listing: dict


app = FastAPI(title="sourcing-scraper", version="1.0")


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/scrape", response_model=ScrapeResponse)
async def scrape(req: ScrapeRequest) -> ScrapeResponse:
    settings = get_settings()

    platform = (req.platform or "kleinanzeigen").strip().lower()
    terms = [term.strip() for term in req.search_terms if term.strip()]
    if not terms:
        terms = ["videospiele konvolut"]

    if platform == "kleinanzeigen":
        result = await scrape_kleinanzeigen(
            search_terms=terms,
            timeout_seconds=settings.sourcing_scraper_timeout_seconds,
            max_pages_per_term=int(req.options.get("max_pages", settings.sourcing_scraper_max_pages_per_term)),
            min_delay_seconds=settings.sourcing_scraper_min_delay_seconds,
            max_delay_seconds=settings.sourcing_scraper_max_delay_seconds,
            use_agent_browser=settings.sourcing_scraper_use_agent_browser,
            agent_browser_profile_path=settings.sourcing_scraper_agent_browser_profile_path,
            agent_browser_session_name=settings.sourcing_scraper_agent_browser_session_name,
        )
        return ScrapeResponse(
            platform="KLEINANZEIGEN",
            blocked=result.blocked,
            error_type=result.error_type,
            error_message=result.error_message,
            listings=result.listings,
        )

    if platform == "ebay_de":
        result = await scrape_ebay_de(
            search_terms=terms,
            timeout_seconds=settings.sourcing_scraper_timeout_seconds,
            max_pages_per_term=int(req.options.get("max_pages", settings.sourcing_scraper_max_pages_per_term)),
            min_delay_seconds=settings.sourcing_scraper_min_delay_seconds,
            max_delay_seconds=settings.sourcing_scraper_max_delay_seconds,
            use_agent_browser=settings.sourcing_scraper_use_agent_browser,
            agent_browser_profile_path=settings.sourcing_scraper_agent_browser_profile_path,
            agent_browser_session_name=settings.sourcing_scraper_agent_browser_session_name,
            options=req.options,
        )
        return ScrapeResponse(
            platform="EBAY_DE",
            blocked=result.blocked,
            error_type=result.error_type,
            error_message=result.error_message,
            listings=result.listings,
        )

    return ScrapeResponse(
        platform=platform.upper(),
        blocked=False,
        error_type="unsupported_platform",
        error_message=f"Unsupported platform: {platform}",
        listings=[],
    )


@app.post("/listing-detail", response_model=ListingDetailResponse)
async def listing_detail(req: ListingDetailRequest) -> ListingDetailResponse:
    settings = get_settings()

    platform = (req.platform or "kleinanzeigen").strip().lower()
    if platform == "kleinanzeigen":
        result = await scrape_kleinanzeigen_listing_detail(
            url=req.url,
            timeout_seconds=settings.sourcing_scraper_timeout_seconds,
            use_agent_browser=settings.sourcing_scraper_use_agent_browser,
            agent_browser_profile_path=settings.sourcing_scraper_agent_browser_profile_path,
            agent_browser_session_name=settings.sourcing_scraper_agent_browser_session_name,
        )
        return ListingDetailResponse(
            platform="KLEINANZEIGEN",
            blocked=result.blocked,
            error_type=result.error_type,
            error_message=result.error_message,
            listing=result.listing,
        )

    if platform == "ebay_de":
        result = await scrape_ebay_de_listing_detail(
            url=req.url,
            timeout_seconds=settings.sourcing_scraper_timeout_seconds,
            use_agent_browser=settings.sourcing_scraper_use_agent_browser,
            agent_browser_profile_path=settings.sourcing_scraper_agent_browser_profile_path,
            agent_browser_session_name=settings.sourcing_scraper_agent_browser_session_name,
        )
        return ListingDetailResponse(
            platform="EBAY_DE",
            blocked=result.blocked,
            error_type=result.error_type,
            error_message=result.error_message,
            listing=result.listing,
        )

    return ListingDetailResponse(
        platform=platform.upper(),
        blocked=False,
        error_type="unsupported_platform",
        error_message=f"Unsupported platform: {platform}",
        listing={},
    )
