from __future__ import annotations

import asyncio
import html
import json
import random
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import httpx


_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
]

_CAPTCHA_EVAL_SCRIPT = """(() => {
  const t = (document.body && document.body.innerText ? document.body.innerText : "").toLowerCase();
  const hasCaptchaNode = Boolean(document.querySelector(".g-recaptcha, iframe[src*='captcha'], form[action*='captcha'], #sec-cpt"));
  return hasCaptchaNode || t.includes("sicherheitsabfrage") || t.includes("captcha");
})()"""

_UNAVAILABLE_EVAL_SCRIPT = """(() => {
  const t = (document.body && document.body.innerText ? document.body.innerText : "").toLowerCase();
  const title = (document.title || "").toLowerCase();
  const hints = [
    "anzeige ist nicht mehr verf",
    "leider ist diese anzeige nicht mehr verf",
    "diese anzeige ist nicht mehr verf",
    "anzeige wurde gel",
    "anzeige wurde deaktiv",
    "angebot ist nicht mehr verf",
    "nicht mehr online",
  ];
  return hints.some((h) => t.includes(h)) || title.includes("404");
})()"""

_EXTRACTION_SCRIPT_PATH = Path(__file__).resolve().parent.parent / "extraction" / "extract_listings.js"
_DETAIL_EXTRACTION_SCRIPT_PATH = Path(__file__).resolve().parent.parent / "extraction" / "extract_listing_detail.js"
_AGENT_BROWSER_BINARY = "agent-browser"


def _slugify_search_term(term: str) -> str:
    text = term.strip().lower()
    text = text.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    text = re.sub(r"\s+", "-", text)
    text = re.sub(r"[^a-z0-9-]", "", text)
    text = re.sub(r"-+", "-", text)
    return text.strip("-") or quote(term.strip())


def _search_url(term: str, page_idx: int) -> str:
    slug = _slugify_search_term(term)
    if page_idx <= 0:
        return f"https://www.kleinanzeigen.de/s-anbieter:privat/anzeige:angebote/{slug}/k0"
    return f"https://www.kleinanzeigen.de/s-anbieter:privat/anzeige:angebote/seite:{page_idx + 1}/{slug}/k0"


def _strip_tags(value: str) -> str:
    without_tags = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", html.unescape(without_tags)).strip()


def _parse_price_cents(raw: str) -> int | None:
    text = _strip_tags(raw).lower()
    if "zu verschenken" in text:
        return 0
    if "vb" in text:
        text = text.replace("vb", "")
    m = re.search(r"(\d{1,5})(?:[\.,](\d{1,2}))?", text)
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


def _parse_location(text: str) -> tuple[str | None, str | None]:
    cleaned = re.sub(r"\s+", " ", text.replace("\u200b", " ")).strip()
    zip_match = re.search(r"\b(\d{5})\b", cleaned)
    if not zip_match:
        return None, cleaned or None
    zip_code = zip_match.group(1)
    city = cleaned.replace(zip_code, "").strip(" ,-")
    return zip_code, city or None


def _normalize_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in {"true", "1", "yes", "ja"}:
        return True
    if text in {"false", "0", "no", "nein"}:
        return False
    return None


def _extract_first_int(value: object) -> int | None:
    if isinstance(value, int):
        return int(value)
    if value is None:
        return None
    m = re.search(r"\d+", str(value))
    return int(m.group(0)) if m else None


def _normalize_listing(entry: dict) -> dict | None:
    external_id = str(entry.get("external_id") or "").strip()
    title = str(entry.get("title") or "").strip()
    url = str(entry.get("url") or "").strip()
    if not external_id or not title or not url:
        return None

    price_raw = entry.get("price_cents")
    if isinstance(price_raw, int):
        price_cents = price_raw
    else:
        price_cents = _parse_price_cents(str(entry.get("price_raw") or ""))
    if price_cents is None:
        return None

    location_zip = str(entry.get("location_zip") or "").strip() or None
    location_city = str(entry.get("location_city") or "").strip() or None
    if (location_zip is None or location_city is None) and entry.get("location_text"):
        parsed_zip, parsed_city = _parse_location(str(entry.get("location_text")))
        location_zip = location_zip or parsed_zip
        location_city = location_city or parsed_city

    image_urls = entry.get("image_urls")
    normalized_images: list[str] = []
    if isinstance(image_urls, list):
        normalized_images = [str(v).strip() for v in image_urls if str(v).strip()]
    primary_image_url = str(entry.get("primary_image_url") or "").strip() or None
    if primary_image_url and primary_image_url not in normalized_images:
        normalized_images.insert(0, primary_image_url)

    old_price_cents = None
    if isinstance(entry.get("old_price_cents"), int):
        old_price_cents = int(entry["old_price_cents"])
    elif entry.get("old_price_raw") is not None:
        old_price_cents = _parse_price_cents(str(entry.get("old_price_raw") or ""))

    image_count = _extract_first_int(entry.get("image_count"))

    return {
        "external_id": external_id,
        "title": title,
        "description": str(entry.get("description") or "").strip() or None,
        "price_cents": int(price_cents),
        "url": _absolute_url(url),
        "image_urls": normalized_images,
        "primary_image_url": primary_image_url,
        "location_zip": location_zip,
        "location_city": location_city,
        "seller_type": str(entry.get("seller_type") or "private").strip().lower() or "private",
        "posted_at_text": str(entry.get("posted_at_text") or "").strip() or None,
        "shipping_possible": _normalize_bool(entry.get("shipping_possible")),
        "direct_buy": _normalize_bool(entry.get("direct_buy")),
        "price_negotiable": _normalize_bool(entry.get("price_negotiable")),
        "old_price_cents": old_price_cents,
        "image_count": image_count,
    }


def _normalize_listing_detail(entry: dict) -> dict:
    normalized_images: list[str] = []
    image_urls = entry.get("image_urls")
    if isinstance(image_urls, list):
        for value in image_urls:
            cleaned = str(value).strip()
            if not cleaned:
                continue
            normalized_images.append(_absolute_url(cleaned))
    deduped_images = list(dict.fromkeys(normalized_images))

    image_count = _extract_first_int(entry.get("image_count"))
    if image_count is None and deduped_images:
        image_count = len(deduped_images)

    price_cents = entry.get("price_cents")
    if not isinstance(price_cents, int):
        price_cents = _parse_price_cents(str(entry.get("price_raw") or ""))

    old_price_cents = entry.get("old_price_cents")
    if not isinstance(old_price_cents, int):
        old_price_cents = _parse_price_cents(str(entry.get("old_price_raw") or ""))

    seller_type = str(entry.get("seller_type") or "").strip().lower() or None
    if seller_type not in {"private", "commercial"}:
        seller_type = None

    return {
        "title": str(entry.get("title") or "").strip() or None,
        "description_full": str(entry.get("description_full") or entry.get("description") or "").strip() or None,
        "posted_at_text": str(entry.get("posted_at_text") or "").strip() or None,
        "price_cents": int(price_cents) if isinstance(price_cents, int) else None,
        "price_negotiable": _normalize_bool(entry.get("price_negotiable")),
        "old_price_cents": int(old_price_cents) if isinstance(old_price_cents, int) else None,
        "image_urls": deduped_images,
        "image_count": image_count,
        "seller_name": str(entry.get("seller_name") or "").strip() or None,
        "seller_member_since_text": str(entry.get("seller_member_since_text") or "").strip() or None,
        "seller_type": seller_type,
        "shipping_possible": _normalize_bool(entry.get("shipping_possible")),
        "direct_buy": _normalize_bool(entry.get("direct_buy")),
        "view_count": _extract_first_int(entry.get("view_count")),
    }


def _extract_from_html(doc: str) -> list[dict]:
    entries: list[dict] = []
    pattern = re.compile(
        r"<article[^>]*class=\"[^\"]*aditem[^\"]*\"[^>]*data-adid=\"(?P<adid>\d+)\"[^>]*>(?P<body>.*?)</article>",
        flags=re.IGNORECASE | re.DOTALL,
    )

    for match in pattern.finditer(doc):
        body = match.group("body")
        title_match = re.search(r"<h2[^>]*>(?P<title>.*?)</h2>", body, flags=re.IGNORECASE | re.DOTALL)
        price_match = re.search(
            r"<p[^>]*class=\"[^\"]*aditem-main--middle--price-shipping--price[^\"]*\"[^>]*>(?P<price>.*?)</p>",
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )
        link_match = re.search(r"<a[^>]*href=\"(?P<href>[^\"]+)\"", body, flags=re.IGNORECASE)
        img_match = re.search(r"<img[^>]*src=\"(?P<src>[^\"]+)\"", body, flags=re.IGNORECASE)
        desc_match = re.search(
            r"<p[^>]*class=\"[^\"]*aditem-main--middle--description[^\"]*\"[^>]*>(?P<desc>.*?)</p>",
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )
        loc_match = re.search(
            r"<div[^>]*class=\"[^\"]*aditem-main--top--left[^\"]*\"[^>]*>(?P<loc>.*?)</div>",
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )

        entry = {
            "external_id": match.group("adid"),
            "title": _strip_tags(title_match.group("title")) if title_match else "",
            "description": _strip_tags(desc_match.group("desc")) if desc_match else None,
            "price_raw": price_match.group("price") if price_match else "",
            "url": link_match.group("href") if link_match else "",
            "image_urls": [img_match.group("src")] if img_match else [],
            "primary_image_url": img_match.group("src") if img_match else None,
            "location_text": _strip_tags(loc_match.group("loc")) if loc_match else "",
            "seller_type": "private",
        }
        normalized = _normalize_listing(entry)
        if normalized is not None:
            entries.append(normalized)

    dedup: dict[str, dict] = {}
    for entry in entries:
        dedup[entry["external_id"]] = entry
    return list(dedup.values())


def _agent_browser_available() -> bool:
    return shutil.which(_AGENT_BROWSER_BINARY) is not None


def _load_extraction_script() -> str:
    return _EXTRACTION_SCRIPT_PATH.read_text(encoding="utf-8")


def _load_detail_extraction_script() -> str:
    return _DETAIL_EXTRACTION_SCRIPT_PATH.read_text(encoding="utf-8")


def _run_agent_browser(*, args: list[str], timeout_seconds: int) -> dict:
    proc = subprocess.run(
        [_AGENT_BROWSER_BINARY, *args, "--json"],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "agent-browser command failed")
    try:
        payload = json.loads(proc.stdout)
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(f"Invalid agent-browser JSON output: {exc}") from exc
    if payload.get("success") is not True:
        raise RuntimeError(str(payload.get("error") or "agent-browser returned non-success"))
    return payload


def _extract_via_agent_browser(
    *,
    url: str,
    timeout_seconds: int,
    profile_path: str,
    session_name: str,
) -> tuple[bool, list[dict]]:
    base_args = [
        "--session",
        session_name,
        "--profile",
        profile_path,
        "--user-agent",
        random.choice(_USER_AGENTS),
    ]

    _run_agent_browser(args=[*base_args, "open", url], timeout_seconds=timeout_seconds)
    captcha_payload = _run_agent_browser(args=[*base_args, "eval", _CAPTCHA_EVAL_SCRIPT], timeout_seconds=timeout_seconds)
    if captcha_payload.get("data", {}).get("result") is True:
        return True, []

    extraction_payload = _run_agent_browser(
        args=[*base_args, "eval", _load_extraction_script()],
        timeout_seconds=timeout_seconds,
    )
    result = extraction_payload.get("data", {}).get("result")
    if not isinstance(result, list):
        return False, []

    normalized: list[dict] = []
    for raw in result:
        if isinstance(raw, dict):
            listing = _normalize_listing(raw)
            if listing is not None:
                normalized.append(listing)
    return False, normalized


def _extract_listing_detail_via_agent_browser(
    *,
    url: str,
    timeout_seconds: int,
    profile_path: str,
    session_name: str,
) -> tuple[bool, dict]:
    base_args = [
        "--session",
        session_name,
        "--profile",
        profile_path,
        "--user-agent",
        random.choice(_USER_AGENTS),
    ]

    _run_agent_browser(args=[*base_args, "open", url], timeout_seconds=timeout_seconds)
    captcha_payload = _run_agent_browser(args=[*base_args, "eval", _CAPTCHA_EVAL_SCRIPT], timeout_seconds=timeout_seconds)
    if captcha_payload.get("data", {}).get("result") is True:
        return True, {}

    extraction_payload = _run_agent_browser(
        args=[*base_args, "eval", _load_detail_extraction_script()],
        timeout_seconds=timeout_seconds,
    )
    result = extraction_payload.get("data", {}).get("result")
    if not isinstance(result, dict):
        return False, {}
    return False, _normalize_listing_detail(result)


def _extract_listing_detail_from_html(doc: str) -> dict:
    lowered = doc.lower()

    title_match = re.search(r"<h1[^>]*>(?P<title>.*?)</h1>", doc, flags=re.IGNORECASE | re.DOTALL)
    description_match = re.search(
        r"<div[^>]*id=\"viewad-description-text\"[^>]*>(?P<description>.*?)</div>",
        doc,
        flags=re.IGNORECASE | re.DOTALL,
    )
    posted_match = re.search(
        r"<div[^>]*id=\"viewad-extra-info\"[^>]*>.*?<span[^>]*>(?P<posted>.*?)</span>",
        doc,
        flags=re.IGNORECASE | re.DOTALL,
    )
    price_match = re.search(
        r"<[^>]*id=\"viewad-price\"[^>]*>(?P<price>.*?)</[^>]+>",
        doc,
        flags=re.IGNORECASE | re.DOTALL,
    )
    old_price_match = re.search(
        r"<[^>]*class=\"[^\"]*old-price[^\"]*\"[^>]*>(?P<old_price>.*?)</[^>]+>",
        doc,
        flags=re.IGNORECASE | re.DOTALL,
    )
    seller_name_match = re.search(
        r"<[^>]*class=\"[^\"]*boxedarticle--details--seller[^\"]*\"[^>]*>(?P<seller>.*?)</[^>]+>",
        doc,
        flags=re.IGNORECASE | re.DOTALL,
    )
    view_count_match = re.search(
        r"<[^>]*id=\"viewad-cntr-num\"[^>]*>(?P<view_count>\d+)</[^>]+>",
        doc,
        flags=re.IGNORECASE | re.DOTALL,
    )

    member_since_match = re.search(r"aktiv seit\s*(\d{2}\.\d{2}\.\d{4})", lowered)

    image_url_matches = re.findall(
        r"https://img\.kleinanzeigen\.de/api/v1/prod-ads/images/[^\s\"']+",
        doc,
        flags=re.IGNORECASE,
    )
    image_urls = list(dict.fromkeys(image_url_matches))

    detail = {
        "title": _strip_tags(title_match.group("title")) if title_match else None,
        "description_full": _strip_tags(description_match.group("description")) if description_match else None,
        "posted_at_text": _strip_tags(posted_match.group("posted")) if posted_match else None,
        "price_raw": price_match.group("price") if price_match else None,
        "price_negotiable": bool(price_match and re.search(r"\bvb\b", price_match.group("price"), flags=re.IGNORECASE)),
        "old_price_raw": old_price_match.group("old_price") if old_price_match else None,
        "image_urls": image_urls,
        "image_count": len(image_urls),
        "seller_name": _strip_tags(seller_name_match.group("seller")) if seller_name_match else None,
        "seller_member_since_text": member_since_match.group(1) if member_since_match else None,
        "seller_type": "commercial" if "gewerblich" in lowered else "private" if "privater nutzer" in lowered else None,
        "shipping_possible": "versand möglich" in lowered,
        "direct_buy": "direkt kaufen" in lowered,
        "view_count": view_count_match.group("view_count") if view_count_match else None,
    }
    return _normalize_listing_detail(detail)


@dataclass
class KleinanzeigenScrapeResult:
    blocked: bool
    error_type: str | None
    error_message: str | None
    listings: list[dict]


@dataclass
class KleinanzeigenListingDetailResult:
    blocked: bool
    error_type: str | None
    error_message: str | None
    listing: dict


async def scrape_kleinanzeigen(
    *,
    search_terms: list[str],
    timeout_seconds: int,
    max_pages_per_term: int,
    min_delay_seconds: float,
    max_delay_seconds: float,
    use_agent_browser: bool,
    agent_browser_profile_path: str,
    agent_browser_session_name: str,
) -> KleinanzeigenScrapeResult:
    listings: list[dict] = []

    timeout = httpx.Timeout(timeout=timeout_seconds)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        for term in search_terms:
            for page_idx in range(max(1, int(max_pages_per_term))):
                url = _search_url(term, page_idx)

                if use_agent_browser and _agent_browser_available():
                    try:
                        blocked, extracted = _extract_via_agent_browser(
                            url=url,
                            timeout_seconds=timeout_seconds,
                            profile_path=agent_browser_profile_path,
                            session_name=agent_browser_session_name,
                        )
                        if blocked:
                            return KleinanzeigenScrapeResult(
                                blocked=True,
                                error_type="captcha",
                                error_message="Captcha detected",
                                listings=listings,
                            )
                        listings.extend(extracted)
                        await asyncio.sleep(random.uniform(min_delay_seconds, max_delay_seconds))
                        continue
                    except Exception:
                        # Fallback to HTTP parsing when agent-browser is unavailable/unhealthy.
                        pass

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

                listings.extend(_extract_from_html(body))
                await asyncio.sleep(random.uniform(min_delay_seconds, max_delay_seconds))

    dedup: dict[str, dict] = {}
    for entry in listings:
        dedup[str(entry["external_id"])] = entry

    return KleinanzeigenScrapeResult(
        blocked=False,
        error_type=None,
        error_message=None,
        listings=list(dedup.values()),
    )


async def scrape_kleinanzeigen_listing_detail(
    *,
    url: str,
    timeout_seconds: int,
    use_agent_browser: bool,
    agent_browser_profile_path: str,
    agent_browser_session_name: str,
) -> KleinanzeigenListingDetailResult:
    listing_url = str(url or "").strip()
    if not listing_url:
        return KleinanzeigenListingDetailResult(
            blocked=False,
            error_type="invalid_input",
            error_message="Missing listing URL",
            listing={},
        )

    if use_agent_browser and _agent_browser_available():
        try:
            blocked, detail = _extract_listing_detail_via_agent_browser(
                url=listing_url,
                timeout_seconds=timeout_seconds,
                profile_path=agent_browser_profile_path,
                session_name=agent_browser_session_name,
            )
            if blocked:
                return KleinanzeigenListingDetailResult(
                    blocked=True,
                    error_type="captcha",
                    error_message="Captcha detected",
                    listing={},
                )
            try:
                unavailable_payload = _run_agent_browser(
                    args=[
                        "--session",
                        agent_browser_session_name,
                        "--profile",
                        agent_browser_profile_path,
                        "eval",
                        _UNAVAILABLE_EVAL_SCRIPT,
                    ],
                    timeout_seconds=timeout_seconds,
                )
                if unavailable_payload.get("data", {}).get("result") is True:
                    return KleinanzeigenListingDetailResult(
                        blocked=False,
                        error_type="not_available",
                        error_message="Listing is not available",
                        listing={},
                    )
            except Exception:
                pass
            return KleinanzeigenListingDetailResult(
                blocked=False,
                error_type=None,
                error_message=None,
                listing=detail,
            )
        except Exception:
            # Fallback to HTTP parsing if agent-browser is unavailable or unhealthy.
            pass

    headers = {
        "User-Agent": random.choice(_USER_AGENTS),
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
    }
    timeout = httpx.Timeout(timeout=timeout_seconds)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        try:
            resp = await client.get(listing_url, headers=headers)
            if resp.status_code == 404:
                return KleinanzeigenListingDetailResult(
                    blocked=False,
                    error_type="not_found",
                    error_message="404 Not Found",
                    listing={},
                )
            resp.raise_for_status()
            body = resp.text
        except Exception as exc:
            return KleinanzeigenListingDetailResult(
                blocked=False,
                error_type="network",
                error_message=str(exc),
                listing={},
            )

    lowered = body.lower()
    if "g-recaptcha" in lowered or "sicherheitsabfrage" in lowered:
        return KleinanzeigenListingDetailResult(
            blocked=True,
            error_type="captcha",
            error_message="Captcha detected",
            listing={},
        )
    if any(
        token in lowered
        for token in (
            "anzeige ist nicht mehr verf",
            "leider ist diese anzeige nicht mehr verf",
            "diese anzeige ist nicht mehr verf",
            "anzeige wurde gel",
            "anzeige wurde deaktiv",
            "angebot ist nicht mehr verf",
            "nicht mehr online",
        )
    ):
        return KleinanzeigenListingDetailResult(
            blocked=False,
            error_type="not_available",
            error_message="Listing is not available",
            listing={},
        )

    return KleinanzeigenListingDetailResult(
        blocked=False,
        error_type=None,
        error_message=None,
        listing=_extract_listing_detail_from_html(body),
    )
