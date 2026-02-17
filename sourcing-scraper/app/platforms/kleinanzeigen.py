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

_EXTRACTION_SCRIPT_PATH = Path(__file__).resolve().parent.parent / "extraction" / "extract_listings.js"
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

    def _maybe_bool(value: object) -> bool | None:
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

    image_count = None
    if isinstance(entry.get("image_count"), int):
        image_count = int(entry["image_count"])
    elif entry.get("image_count"):
        m = re.search(r"\d+", str(entry["image_count"]))
        image_count = int(m.group(0)) if m else None

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
        "shipping_possible": _maybe_bool(entry.get("shipping_possible")),
        "direct_buy": _maybe_bool(entry.get("direct_buy")),
        "price_negotiable": _maybe_bool(entry.get("price_negotiable")),
        "old_price_cents": old_price_cents,
        "image_count": image_count,
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


@dataclass
class KleinanzeigenScrapeResult:
    blocked: bool
    error_type: str | None
    error_message: str | None
    listings: list[dict]


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
