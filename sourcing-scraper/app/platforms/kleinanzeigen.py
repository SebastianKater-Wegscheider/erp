from __future__ import annotations

import asyncio
import html
import random
import re
from dataclasses import dataclass
from urllib.parse import quote

import httpx


_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
]


def _slugify_search_term(term: str) -> str:
    text = term.strip().lower()
    text = text.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    text = re.sub(r"\s+", "-", text)
    text = re.sub(r"[^a-z0-9-]", "", text)
    text = re.sub(r"-+", "-", text)
    return text.strip("-") or quote(term.strip())


def _strip_tags(value: str) -> str:
    without_tags = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", html.unescape(without_tags)).strip()


def _parse_price_cents(raw: str) -> int | None:
    text = _strip_tags(raw).lower()
    if "vb" in text:
        text = text.replace("vb", "")
    m = re.search(r"(\d{1,4})(?:[\.,](\d{1,2}))?", text)
    if not m:
        return None
    euros = int(m.group(1))
    cents = int((m.group(2) or "0").ljust(2, "0")[:2])
    return euros * 100 + cents


def _absolute_url(url: str) -> str:
    if url.startswith("http://") or url.startswith("https://"):
        return url
    if url.startswith("/"):
        return f"https://www.kleinanzeigen.de{url}"
    return f"https://www.kleinanzeigen.de/{url}"


@dataclass
class KleinanzeigenScrapeResult:
    blocked: bool
    error_type: str | None
    error_message: str | None
    listings: list[dict]


def _extract_from_html(doc: str) -> list[dict]:
    entries: list[dict] = []

    # Primary pattern based on listing cards.
    pattern = re.compile(
        r"<article[^>]*class=\"[^\"]*aditem[^\"]*\"[^>]*data-adid=\"(?P<adid>\d+)\"[^>]*>(?P<body>.*?)</article>",
        flags=re.IGNORECASE | re.DOTALL,
    )

    for match in pattern.finditer(doc):
        body = match.group("body")

        title_match = re.search(r"<h2[^>]*>(?P<title>.*?)</h2>", body, flags=re.IGNORECASE | re.DOTALL)
        price_match = re.search(
            r"<(?:p|div)[^>]*class=\"[^\"]*(?:price|aditem-main--top--price)[^\"]*\"[^>]*>(?P<price>.*?)</(?:p|div)>",
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )
        link_match = re.search(r"<a[^>]*href=\"(?P<href>[^\"]+)\"", body, flags=re.IGNORECASE)
        img_match = re.search(r"<img[^>]*src=\"(?P<src>[^\"]+)\"", body, flags=re.IGNORECASE)
        city_match = re.search(
            r"<div[^>]*class=\"[^\"]*aditem-main--top--left[^\"]*\"[^>]*>(?P<city>.*?)</div>",
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )
        seller_match = re.search(r"(Privat|Gewerblich)", _strip_tags(body), flags=re.IGNORECASE)

        title = _strip_tags(title_match.group("title")) if title_match else ""
        href = link_match.group("href") if link_match else ""
        price_cents = _parse_price_cents(price_match.group("price") if price_match else "")
        city = _strip_tags(city_match.group("city")) if city_match else None
        seller_type = seller_match.group(1).lower() if seller_match else None

        if not title or not href or price_cents is None:
            continue

        primary_image_url = img_match.group("src") if img_match else None

        entry = {
            "external_id": match.group("adid"),
            "title": title,
            "description": None,
            "price_cents": int(price_cents),
            "url": _absolute_url(href),
            "image_urls": [primary_image_url] if primary_image_url else [],
            "primary_image_url": primary_image_url,
            "location_zip": None,
            "location_city": city,
            "seller_type": seller_type,
        }
        entries.append(entry)

    dedup: dict[str, dict] = {}
    for entry in entries:
        dedup[str(entry["external_id"])] = entry
    return list(dedup.values())


async def scrape_kleinanzeigen(
    *,
    search_terms: list[str],
    timeout_seconds: int,
    max_pages_per_term: int,
    min_delay_seconds: float,
    max_delay_seconds: float,
) -> KleinanzeigenScrapeResult:
    listings: list[dict] = []

    timeout = httpx.Timeout(timeout=timeout_seconds)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        for term in search_terms:
            slug = _slugify_search_term(term)
            for page_idx in range(max(1, int(max_pages_per_term))):
                page_part = f"seite:{page_idx + 1}/" if page_idx > 0 else ""
                url = f"https://www.kleinanzeigen.de/s-videospiele/{page_part}{slug}/k0c278"
                headers = {
                    "User-Agent": random.choice(_USER_AGENTS),
                    "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
                }
                try:
                    resp = await client.get(url, headers=headers)
                    resp.raise_for_status()
                    body = resp.text
                except Exception as exc:
                    return KleinanzeigenScrapeResult(
                        blocked=False,
                        error_type="network",
                        error_message=str(exc),
                        listings=listings,
                    )

                lowered = body.lower()
                if "g-recaptcha" in lowered or "sicherheitsabfrage" in lowered:
                    return KleinanzeigenScrapeResult(
                        blocked=True,
                        error_type="captcha",
                        error_message="Captcha detected",
                        listings=listings,
                    )

                extracted = _extract_from_html(body)
                listings.extend(extracted)

                await asyncio.sleep(random.uniform(min_delay_seconds, max_delay_seconds))

    return KleinanzeigenScrapeResult(
        blocked=False,
        error_type=None,
        error_message=None,
        listings=listings,
    )
