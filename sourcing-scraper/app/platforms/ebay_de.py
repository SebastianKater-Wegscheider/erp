from __future__ import annotations

import asyncio
import html
import json
import random
import re
import shutil
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import httpx


_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
]

_CAPTCHA_EVAL_SCRIPT = """(() => {
  const t = (document.body && document.body.innerText ? document.body.innerText : "").toLowerCase();
  return t.includes("captcha") || t.includes("sicherheitsabfrage") || Boolean(document.querySelector("iframe[src*='captcha']"));
})()"""

_EXTRACTION_SCRIPT_PATH = Path(__file__).resolve().parent.parent / "extraction" / "extract_ebay_listings.js"
_DETAIL_EXTRACTION_SCRIPT_PATH = Path(__file__).resolve().parent.parent / "extraction" / "extract_ebay_listing_detail.js"
_AGENT_BROWSER_BINARY = "agent-browser"
_EBAY_TZ = ZoneInfo("Europe/Berlin")


@dataclass
class EbayScrapeResult:
    blocked: bool
    error_type: str | None
    error_message: str | None
    listings: list[dict]


@dataclass
class EbayListingDetailResult:
    blocked: bool
    error_type: str | None
    error_message: str | None
    listing: dict


def _strip_tags(value: str) -> str:
    without_tags = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", html.unescape(without_tags)).strip()


def _clean_listing_title(value: str) -> str:
    text = _strip_tags(value)
    text = re.sub(r"\s*Wird in neuem Fenster oder Tab geoffnet\s*$", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*Opens in a new window or tab\s*$", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^\s*Neues Angebot\s*[:\-–]?\s*", "", text, flags=re.IGNORECASE)
    return text.strip()


def _is_generic_listing_title(value: str) -> bool:
    text = re.sub(r"\s+", " ", str(value or "")).strip().lower()
    return text in {"neues angebot", "new listing"}


def _parse_price_cents(raw: str) -> int | None:
    text = _strip_tags(raw).lower().replace("eur", "").replace("€", "").replace("ca.", "")
    text = re.sub(r"[^0-9,\.]", "", text)
    if not text:
        return None
    match = re.search(r"(\d{1,7})(?:[\.,](\d{1,2}))?", text)
    if not match:
        return None
    euros = int(match.group(1))
    cents = int((match.group(2) or "0").ljust(2, "0")[:2])
    return euros * 100 + cents


def _extract_first_int(raw: str | None) -> int | None:
    if not raw:
        return None
    m = re.search(r"\d+", str(raw))
    return int(m.group(0)) if m else None


def _absolute_url(url: str) -> str:
    if url.startswith("http://") or url.startswith("https://"):
        return url
    if url.startswith("//"):
        return f"https:{url}"
    if url.startswith("/"):
        return f"https://www.ebay.de{url}"
    return f"https://www.ebay.de/{url}"


def _extract_external_id(url: str) -> str | None:
    text = url.strip()
    m = re.search(r"/itm/(?:[^/?]+/)?(\d{8,20})", text)
    if m:
        return m.group(1)
    m = re.search(r"item=(\d{8,20})", text)
    if m:
        return m.group(1)
    return None


def _normalize_image_url(url: str) -> str | None:
    text = str(url or "").strip()
    if not text:
        return None
    if text.startswith("data:"):
        return None
    lowered = text.lower()
    if lowered.endswith("/s_1x2.gif") or lowered.endswith("/empty.gif"):
        return None
    return _absolute_url(text)


def _parse_auction_end_at(raw: str | None, *, now: datetime | None = None) -> datetime | None:
    text = re.sub(r"\s+", " ", str(raw or "")).strip().lower()
    if not text:
        return None

    now_utc = now or datetime.now(UTC)
    local_now = now_utc.astimezone(_EBAY_TZ)

    time_match = re.search(r"\b(\d{1,2}):(\d{2})\b", text)
    hour = int(time_match.group(1)) if time_match else 0
    minute = int(time_match.group(2)) if time_match else 0
    if hour > 23 or minute > 59:
        return None

    try:
        if "heute" in text:
            base = local_now.date()
        elif "morgen" in text:
            base = (local_now + timedelta(days=1)).date()
        elif "gestern" in text:
            base = (local_now - timedelta(days=1)).date()
        else:
            date_match = re.search(r"\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b", text)
            if date_match:
                day = int(date_match.group(1))
                month = int(date_match.group(2))
                year = int(date_match.group(3))
                base = datetime(year=year, month=month, day=day, tzinfo=_EBAY_TZ).date()
            else:
                date_match_short = re.search(r"\b(\d{1,2})\.(\d{1,2})\.\b", text)
                if not date_match_short:
                    return None
                day = int(date_match_short.group(1))
                month = int(date_match_short.group(2))
                year = local_now.year
                parsed = datetime(year=year, month=month, day=day, tzinfo=_EBAY_TZ).date()
                if parsed < local_now.date() - timedelta(days=30):
                    parsed = datetime(year=year + 1, month=month, day=day, tzinfo=_EBAY_TZ).date()
                base = parsed

        dt = datetime(
            year=base.year,
            month=base.month,
            day=base.day,
            hour=hour,
            minute=minute,
            tzinfo=_EBAY_TZ,
        )
    except ValueError:
        return None

    return dt.astimezone(UTC)


def _normalize_listing(entry: dict) -> dict | None:
    raw_url = str(entry.get("url") or "").strip()
    url = _absolute_url(raw_url)
    external_id = str(entry.get("external_id") or "").strip() or (_extract_external_id(url) or "")
    title = _clean_listing_title(str(entry.get("title") or ""))
    if not external_id or not title or _is_generic_listing_title(title):
        return None

    price_cents = entry.get("price_cents") if isinstance(entry.get("price_cents"), int) else _parse_price_cents(str(entry.get("price_raw") or ""))
    if price_cents is None:
        return None

    shipping_cents = entry.get("shipping_cents") if isinstance(entry.get("shipping_cents"), int) else _parse_price_cents(str(entry.get("shipping_raw") or ""))
    bid_count = _extract_first_int(str(entry.get("auction_bid_count") or entry.get("bids_raw") or ""))

    auction_end_at_text = str(entry.get("auction_end_at_text") or entry.get("time_left_raw") or "").strip() or None
    auction_end_at = str(entry.get("auction_end_at") or "").strip() or None
    if not auction_end_at and auction_end_at_text:
        parsed = _parse_auction_end_at(auction_end_at_text)
        auction_end_at = parsed.isoformat() if parsed else None

    image_urls = entry.get("image_urls") if isinstance(entry.get("image_urls"), list) else []
    normalized_images = [
        cleaned
        for cleaned in (_normalize_image_url(str(v)) for v in image_urls)
        if cleaned
    ]
    primary_image_url = _normalize_image_url(str(entry.get("primary_image_url") or ""))
    if primary_image_url and primary_image_url not in normalized_images:
        normalized_images.insert(0, primary_image_url)
    if not primary_image_url and normalized_images:
        primary_image_url = normalized_images[0]

    return {
        "external_id": external_id,
        "title": title,
        "description": str(entry.get("description") or "").strip() or None,
        "price_cents": int(price_cents),
        "url": url,
        "image_urls": normalized_images,
        "primary_image_url": primary_image_url,
        "location_zip": str(entry.get("location_zip") or "").strip() or None,
        "location_city": str(entry.get("location_city") or "").strip() or None,
        "seller_type": str(entry.get("seller_type") or "").strip().lower() or None,
        "shipping_cents": int(shipping_cents) if isinstance(shipping_cents, int) else None,
        "auction_current_price_cents": int(price_cents),
        "auction_bid_count": bid_count,
        "auction_end_at_text": auction_end_at_text,
        "auction_end_at": auction_end_at,
    }


def _normalize_detail(entry: dict) -> dict:
    price_cents = entry.get("price_cents") if isinstance(entry.get("price_cents"), int) else _parse_price_cents(str(entry.get("price_raw") or ""))
    shipping_cents = entry.get("shipping_cents") if isinstance(entry.get("shipping_cents"), int) else _parse_price_cents(str(entry.get("shipping_raw") or ""))

    auction_end_at_text = str(entry.get("auction_end_at_text") or "").strip() or None
    auction_end_at = str(entry.get("auction_end_at") or "").strip() or None
    if not auction_end_at and auction_end_at_text:
        parsed = _parse_auction_end_at(auction_end_at_text)
        auction_end_at = parsed.isoformat() if parsed else None

    bid_count = _extract_first_int(str(entry.get("auction_bid_count") or ""))

    image_urls: list[str] = []
    if isinstance(entry.get("image_urls"), list):
        image_urls = [
            cleaned
            for cleaned in (_normalize_image_url(str(v)) for v in entry.get("image_urls", []))
            if cleaned
        ]

    return {
        "title": str(entry.get("title") or "").strip() or None,
        "description_full": str(entry.get("description_full") or "").strip() or None,
        "price_cents": int(price_cents) if isinstance(price_cents, int) else None,
        "shipping_cents": int(shipping_cents) if isinstance(shipping_cents, int) else None,
        "auction_current_price_cents": int(price_cents) if isinstance(price_cents, int) else None,
        "auction_bid_count": bid_count,
        "auction_end_at_text": auction_end_at_text,
        "auction_end_at": auction_end_at,
        "seller_type": str(entry.get("seller_type") or "").strip().lower() or None,
        "seller_name": str(entry.get("seller_name") or "").strip() or None,
        "image_urls": list(dict.fromkeys(image_urls)),
        "image_count": len(image_urls) if image_urls else None,
    }


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
    payload = json.loads(proc.stdout)
    if payload.get("success") is not True:
        raise RuntimeError(str(payload.get("error") or "agent-browser returned non-success"))
    return payload


def _build_search_url(keyword: str, page_idx: int, options: dict | None = None) -> str:
    opts = options or {}
    params: dict[str, str] = {
        "_nkw": keyword,
        "_sacat": str(opts.get("_sacat", "0")),
        "_from": str(opts.get("_from", "R40")),
        "LH_Auction": str(opts.get("LH_Auction", "1")),
        "_sop": str(opts.get("_sop", "44")),
        "rt": str(opts.get("rt", "nc")),
        "LH_PrefLoc": str(opts.get("LH_PrefLoc", "1")),
    }
    if page_idx > 0:
        params["_pgn"] = str(page_idx + 1)
    return f"https://www.ebay.de/sch/i.html?{urlencode(params)}"


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

    extraction_payload = _run_agent_browser(args=[*base_args, "eval", _load_extraction_script()], timeout_seconds=timeout_seconds)
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


def _extract_detail_via_agent_browser(
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
    return False, _normalize_detail(result)


def _extract_from_html(doc: str) -> list[dict]:
    entries: list[dict] = []
    pattern = re.compile(
        r"<li[^>]*class=\"[^\"]*(?:s-item|s-card)[^\"]*\"[^>]*>(?P<body>.*?)</li>",
        flags=re.IGNORECASE | re.DOTALL,
    )

    for match in pattern.finditer(doc):
        body = match.group("body")
        link_match = re.search(
            r"<a[^>]*(?:s-item__link|s-card__link)[^>]*href=(?P<q>[\"']?)(?P<href>[^\"'\s>]+)(?P=q)",
            body,
            flags=re.IGNORECASE,
        )
        title_match = re.search(
            r"<[^>]*(?:s-item__title|s-card__title)[^>]*>(?P<title>.*?)</[^>]+>",
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )
        price_match = re.search(
            r"<[^>]*(?:s-item__price|s-card__price)[^>]*>(?P<price>.*?)</[^>]+>",
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )
        bids_match = re.search(
            r"<[^>]*(?:s-item__bids|s-item__bidCount|s-card__bidCount)[^>]*>(?P<bids>.*?)</[^>]+>",
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )
        time_match = re.search(
            r"<[^>]*(?:s-item__time-left|s-item__time-end|s-card__time-left|s-card__time-end)[^>]*>(?P<time>.*?)</[^>]+>",
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if not bids_match:
            bids_match = re.search(r"(\d+\s+Gebote)", body, flags=re.IGNORECASE)
        if not time_match:
            time_match = re.search(r"\b(Noch[^<]{0,24}|Heute[^<]{0,24}|Morgen[^<]{0,24})\b", body, flags=re.IGNORECASE)
        image_match = re.search(r"https://i\.ebayimg\.com/images/[^\s\"']+", body, flags=re.IGNORECASE)
        shipping_match = re.search(
            r"<[^>]*(?:s-item__shipping|s-item__logisticsCost|s-card__shipping)[^>]*>(?P<shipping>.*?)</[^>]+>",
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )

        raw_title = _clean_listing_title(title_match.group("title")) if title_match else ""
        if not raw_title or raw_title.lower().startswith(("shop on ebay", "shop auf ebay")):
            continue

        entry = {
            "url": _strip_tags(link_match.group("href")) if link_match else "",
            "title": raw_title,
            "price_raw": price_match.group("price") if price_match else "",
            "shipping_raw": shipping_match.group("shipping") if shipping_match else "",
            "bids_raw": _strip_tags(bids_match.group("bids")) if bids_match and "bids" in bids_match.groupdict() else _strip_tags(bids_match.group(1)) if bids_match else "",
            "time_left_raw": _strip_tags(time_match.group("time")) if time_match and "time" in time_match.groupdict() else _strip_tags(time_match.group(1)) if time_match else "",
            "image_urls": [image_match.group(0)] if image_match else [],
            "primary_image_url": image_match.group(0) if image_match else None,
        }
        normalized = _normalize_listing(entry)
        if normalized is not None:
            entries.append(normalized)

    dedup: dict[str, dict] = {}
    for entry in entries:
        dedup[entry["external_id"]] = entry
    return list(dedup.values())


def _extract_detail_from_html(doc: str) -> dict:
    title_match = re.search(r"<h1[^>]*>(?P<title>.*?)</h1>", doc, flags=re.IGNORECASE | re.DOTALL)
    price_match = re.search(r"<[^>]*class=\"[^\"]*(x-price-primary|notranslate)[^\"]*\"[^>]*>(?P<price>.*?)</[^>]+>", doc, flags=re.IGNORECASE | re.DOTALL)
    bid_match = re.search(r"(\d+)\s+Gebote", doc, flags=re.IGNORECASE)
    shipping_match = re.search(r"(Versand[^<]{0,60}|Kostenloser Versand)", doc, flags=re.IGNORECASE)

    all_text = _strip_tags(doc)
    end_match = re.search(r"(Heute,?\s*\d{1,2}:\d{2}|Morgen,?\s*\d{1,2}:\d{2}|\d{1,2}\.\d{1,2}\.\d{4}[^\n]{0,20})", all_text)

    image_urls = re.findall(r"https://i\.ebayimg\.com/images/[^\n\"']+", doc, flags=re.IGNORECASE)

    return _normalize_detail(
        {
            "title": _strip_tags(title_match.group("title")) if title_match else None,
            "price_raw": price_match.group("price") if price_match else None,
            "auction_bid_count": bid_match.group(1) if bid_match else None,
            "shipping_raw": shipping_match.group(1) if shipping_match else None,
            "auction_end_at_text": end_match.group(1) if end_match else None,
            "image_urls": list(dict.fromkeys(image_urls)),
        }
    )


async def scrape_ebay_de(
    *,
    search_terms: list[str],
    timeout_seconds: int,
    max_pages_per_term: int,
    min_delay_seconds: float,
    max_delay_seconds: float,
    use_agent_browser: bool,
    agent_browser_profile_path: str,
    agent_browser_session_name: str,
    options: dict | None = None,
) -> EbayScrapeResult:
    listings: list[dict] = []

    timeout = httpx.Timeout(timeout=timeout_seconds)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        for term in search_terms:
            for page_idx in range(max(1, int(max_pages_per_term))):
                url = _build_search_url(term, page_idx, options)

                if use_agent_browser and _agent_browser_available():
                    try:
                        blocked, extracted = _extract_via_agent_browser(
                            url=url,
                            timeout_seconds=timeout_seconds,
                            profile_path=agent_browser_profile_path,
                            session_name=f"{agent_browser_session_name}-ebay",
                        )
                        if blocked:
                            return EbayScrapeResult(
                                blocked=True,
                                error_type="captcha",
                                error_message="Captcha detected",
                                listings=listings,
                            )
                        listings.extend(extracted)
                        await asyncio.sleep(random.uniform(min_delay_seconds, max_delay_seconds))
                        continue
                    except Exception:
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
                    return EbayScrapeResult(
                        blocked=False,
                        error_type="network",
                        error_message=str(exc),
                        listings=listings,
                    )

                lowered = body.lower()
                if "captcha" in lowered and "ebay" in lowered:
                    return EbayScrapeResult(
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

    return EbayScrapeResult(
        blocked=False,
        error_type=None,
        error_message=None,
        listings=list(dedup.values()),
    )


async def scrape_ebay_de_listing_detail(
    *,
    url: str,
    timeout_seconds: int,
    use_agent_browser: bool,
    agent_browser_profile_path: str,
    agent_browser_session_name: str,
) -> EbayListingDetailResult:
    listing_url = str(url or "").strip()
    if not listing_url:
        return EbayListingDetailResult(
            blocked=False,
            error_type="invalid_input",
            error_message="Missing listing URL",
            listing={},
        )

    if use_agent_browser and _agent_browser_available():
        try:
            blocked, detail = _extract_detail_via_agent_browser(
                url=listing_url,
                timeout_seconds=timeout_seconds,
                profile_path=agent_browser_profile_path,
                session_name=f"{agent_browser_session_name}-ebay",
            )
            if blocked:
                return EbayListingDetailResult(
                    blocked=True,
                    error_type="captcha",
                    error_message="Captcha detected",
                    listing={},
                )
            return EbayListingDetailResult(
                blocked=False,
                error_type=None,
                error_message=None,
                listing=detail,
            )
        except Exception:
            pass

    timeout = httpx.Timeout(timeout=timeout_seconds)
    headers = {
        "User-Agent": random.choice(_USER_AGENTS),
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
    }
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        try:
            resp = await client.get(listing_url, headers=headers)
            resp.raise_for_status()
            body = resp.text
        except Exception as exc:
            return EbayListingDetailResult(
                blocked=False,
                error_type="network",
                error_message=str(exc),
                listing={},
            )

    lowered = body.lower()
    if "captcha" in lowered and "ebay" in lowered:
        return EbayListingDetailResult(
            blocked=True,
            error_type="captcha",
            error_message="Captcha detected",
            listing={},
        )

    return EbayListingDetailResult(
        blocked=False,
        error_type=None,
        error_message=None,
        listing=_extract_detail_from_html(body),
    )
