from __future__ import annotations

import asyncio
import random
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models.amazon_scrape import (
    AmazonProductMetricsLatest,
    AmazonScrapeBestPrice,
    AmazonScrapeRun,
    AmazonScrapeSalesRank,
)
from app.models.master_product import MasterProduct


class ScraperBusyError(RuntimeError):
    pass


ConditionBucket = str

BUCKET_NEW: ConditionBucket = "NEW"
BUCKET_USED_LIKE_NEW: ConditionBucket = "USED_LIKE_NEW"
BUCKET_USED_VERY_GOOD: ConditionBucket = "USED_VERY_GOOD"
BUCKET_USED_GOOD: ConditionBucket = "USED_GOOD"
BUCKET_USED_ACCEPTABLE: ConditionBucket = "USED_ACCEPTABLE"
BUCKET_COLLECTIBLE: ConditionBucket = "COLLECTIBLE"

ALL_BUCKETS: tuple[ConditionBucket, ...] = (
    BUCKET_NEW,
    BUCKET_USED_LIKE_NEW,
    BUCKET_USED_VERY_GOOD,
    BUCKET_USED_GOOD,
    BUCKET_USED_ACCEPTABLE,
    BUCKET_COLLECTIBLE,
)

USED_BUCKETS: tuple[ConditionBucket, ...] = (
    BUCKET_USED_LIKE_NEW,
    BUCKET_USED_VERY_GOOD,
    BUCKET_USED_GOOD,
    BUCKET_USED_ACCEPTABLE,
)


def utcnow() -> datetime:
    return datetime.now(UTC)


def _parse_ts_utc(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    # Accept "Z" suffix.
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def parse_money_to_cents(value: Any) -> int | None:
    if value is None:
        return None
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    try:
        d = Decimal(s)
    except InvalidOperation:
        return None
    cents = (d * Decimal("100")).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return int(cents)


def bucket_from_offer(*, condition_group: Any, condition_raw: Any) -> ConditionBucket | None:
    cg = str(condition_group or "").strip().lower()
    cr = str(condition_raw or "").strip().lower()

    if cg == "collectible" or "sammlerst" in cr:
        return BUCKET_COLLECTIBLE

    # Amazon.de condition strings are typically German.
    if "wie neu" in cr:
        return BUCKET_USED_LIKE_NEW
    if "sehr gut" in cr:
        return BUCKET_USED_VERY_GOOD
    if "akzeptabel" in cr:
        return BUCKET_USED_ACCEPTABLE
    if "gut" in cr:
        return BUCKET_USED_GOOD
    if cg == "new" or ("neu" in cr and "wie neu" not in cr):
        return BUCKET_NEW

    if cg == "used":
        # Used without a specific grade is too ambiguous to bucket.
        return None
    return None


def _best_total_cents_for_offer(offer: dict[str, Any]) -> int | None:
    total = parse_money_to_cents(offer.get("price_total"))
    if total is not None:
        return total
    item = parse_money_to_cents(offer.get("price_item"))
    shipping = parse_money_to_cents(offer.get("price_shipping"))
    if item is None or shipping is None:
        return None
    return item + shipping


def _best_total_cents_for_buybox(buybox: Any) -> int | None:
    if not isinstance(buybox, dict):
        return None
    total = parse_money_to_cents(buybox.get("total"))
    if total is not None:
        return total
    item = parse_money_to_cents(buybox.get("price_item"))
    shipping = parse_money_to_cents(buybox.get("shipping"))
    if item is None or shipping is None:
        return None
    return item + shipping


def _offer_counts(offers: Any) -> tuple[int | None, int | None, int | None]:
    if not isinstance(offers, list):
        return None, None, None
    total = len(offers)
    priced_total = 0
    used_priced_total = 0
    for o in offers:
        if not isinstance(o, dict):
            continue
        total_cents = _best_total_cents_for_offer(o)
        if total_cents is None:
            continue
        priced_total += 1
        bucket = bucket_from_offer(condition_group=o.get("condition_group"), condition_raw=o.get("condition_raw"))
        if bucket in USED_BUCKETS:
            used_priced_total += 1
    return total, priced_total, used_priced_total


@dataclass(frozen=True)
class BestPrice:
    bucket: ConditionBucket
    total_cents: int
    currency: str
    page: int | None
    position: int | None
    seller_name: str | None


async def fetch_scraper_json(*, settings: Settings, asin: str) -> dict[str, Any]:
    timeout = httpx.Timeout(timeout=settings.amazon_scraper_timeout_seconds)
    async with httpx.AsyncClient(timeout=timeout) as client:
        url = f"{settings.amazon_scraper_base_url.rstrip('/')}/api/scrape"
        r = await client.get(url, params={"asin": asin})
        if r.status_code == 429:
            raise ScraperBusyError("Scraper busy (429)")
        r.raise_for_status()
        data = r.json()
        if not isinstance(data, dict):
            raise RuntimeError("Unexpected scraper response shape")
        return data


def compute_best_prices(offers: Any) -> dict[ConditionBucket, BestPrice]:
    if not isinstance(offers, list):
        return {}

    best: dict[ConditionBucket, BestPrice] = {}
    for o in offers:
        if not isinstance(o, dict):
            continue
        bucket = bucket_from_offer(condition_group=o.get("condition_group"), condition_raw=o.get("condition_raw"))
        if bucket is None:
            continue
        total_cents = _best_total_cents_for_offer(o)
        if total_cents is None:
            continue
        currency = str(o.get("currency") or "EUR")
        candidate = BestPrice(
            bucket=bucket,
            total_cents=total_cents,
            currency=currency,
            page=int(o["page"]) if isinstance(o.get("page"), int) else None,
            position=int(o["position"]) if isinstance(o.get("position"), int) else None,
            seller_name=str(o.get("seller_name")) if o.get("seller_name") is not None else None,
        )
        prev = best.get(bucket)
        if prev is None or candidate.total_cents < prev.total_cents:
            best[bucket] = candidate
    return best


def _extract_rank_obj(value: Any) -> tuple[int | None, str | None]:
    if not isinstance(value, dict):
        return None, None
    rank = value.get("rank")
    cat = value.get("category")
    if not isinstance(rank, int):
        rank = None
    if cat is not None and not isinstance(cat, str):
        cat = str(cat)
    return rank, cat


def _derived_ranks(data: dict[str, Any]) -> tuple[int | None, str | None, int | None, str | None]:
    overall_rank, overall_cat = _extract_rank_obj(data.get("sales_rank_overall"))
    specific_rank, specific_cat = _extract_rank_obj(data.get("sales_rank_specific"))

    ranks = data.get("sales_ranks")
    if isinstance(ranks, list) and ranks:
        first = ranks[0] if isinstance(ranks[0], dict) else None
        last = ranks[-1] if isinstance(ranks[-1], dict) else None
        if overall_rank is None and isinstance(first, dict):
            if isinstance(first.get("rank"), int):
                overall_rank = first["rank"]
            if isinstance(first.get("category"), str):
                overall_cat = first["category"]
        if specific_rank is None and isinstance(last, dict):
            if isinstance(last.get("rank"), int):
                specific_rank = last["rank"]
            if isinstance(last.get("category"), str):
                specific_cat = last["category"]
    return overall_rank, overall_cat, specific_rank, specific_cat


def _normalize_image_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw:
        return None
    lowered = raw.lower()
    if lowered.startswith("http://") or lowered.startswith("https://"):
        return raw
    return None


def _extract_image_url(data: dict[str, Any]) -> str | None:
    direct_keys = (
        "image_url",
        "image",
        "image_src",
        "main_image_url",
        "main_image",
        "primary_image_url",
    )
    for key in direct_keys:
        url = _normalize_image_url(data.get(key))
        if url is not None:
            return url

    product = data.get("product")
    if isinstance(product, dict):
        for key in ("image_url", "image", "image_src", "main_image_url", "primary_image_url"):
            url = _normalize_image_url(product.get(key))
            if url is not None:
                return url

    images = data.get("images")
    if isinstance(images, list):
        for entry in images:
            if isinstance(entry, dict):
                for key in ("url", "src", "image_url", "image"):
                    url = _normalize_image_url(entry.get(key))
                    if url is not None:
                        return url
            else:
                url = _normalize_image_url(entry)
                if url is not None:
                    return url
    return None


def _asin_image_fallback_url(asin: str | None) -> str | None:
    value = (asin or "").strip().upper()
    if len(value) != 10:
        return None
    return f"https://images-eu.ssl-images-amazon.com/images/P/{value}.01.LZZZZZZZ.jpg"


def _guess_image_extension(*, image_url: str, content_type: str | None) -> str:
    path = urlparse(image_url).path
    suffix = Path(path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"}:
        return suffix

    ct = (content_type or "").split(";", 1)[0].strip().lower()
    if ct in {"image/jpeg", "image/jpg"}:
        return ".jpg"
    if ct == "image/png":
        return ".png"
    if ct == "image/webp":
        return ".webp"
    if ct == "image/gif":
        return ".gif"
    if ct == "image/avif":
        return ".avif"
    if ct == "image/bmp":
        return ".bmp"
    return ".jpg"


async def _store_reference_image_locally(
    *,
    settings: Settings,
    master_product_id: uuid.UUID,
    image_url: str,
) -> str | None:
    timeout = httpx.Timeout(timeout=min(30, int(settings.amazon_scraper_timeout_seconds)))
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.get(image_url)
        response.raise_for_status()
    except Exception:
        return None

    content_type = response.headers.get("content-type")
    if content_type and not content_type.lower().startswith("image/"):
        return None
    image_bytes = response.content
    if not image_bytes:
        return None

    ext = _guess_image_extension(image_url=image_url, content_type=content_type)
    rel_dir = Path("uploads") / "master-product-reference"
    abs_dir = settings.app_storage_dir / rel_dir
    await asyncio.to_thread(abs_dir.mkdir, parents=True, exist_ok=True)

    stem = str(master_product_id)
    for old_ext in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"):
        if old_ext == ext:
            continue
        old_path = abs_dir / f"{stem}{old_ext}"
        if old_path.exists():
            await asyncio.to_thread(old_path.unlink)

    filename = f"{stem}{ext}"
    abs_path = abs_dir / filename
    await asyncio.to_thread(abs_path.write_bytes, image_bytes)
    return (rel_dir / filename).as_posix()


async def persist_scrape_result(
    *,
    session: AsyncSession,
    settings: Settings | None,
    master_product_id: uuid.UUID,
    asin: str,
    data: dict[str, Any] | None,
    error: str | None,
    finished_at: datetime,
) -> uuid.UUID:
    started_at = _parse_ts_utc((data or {}).get("ts_utc")) or finished_at
    blocked = bool((data or {}).get("blocked")) if data is not None else False
    ok = bool(data is not None and not blocked and error is None)

    run_id = uuid.uuid4()
    run = AmazonScrapeRun(
        id=run_id,
        master_product_id=master_product_id,
        asin=asin,
        marketplace=str((data or {}).get("marketplace") or "amazon.de"),
        started_at=started_at,
        finished_at=finished_at,
        ok=ok,
        blocked=blocked,
        block_reason=str((data or {}).get("block_reason")) if (data or {}).get("block_reason") is not None else None,
        offers_truncated=bool((data or {}).get("offers_truncated")) if data is not None else False,
        error=error,
        title=str((data or {}).get("title")) if (data or {}).get("title") is not None else None,
        dp_url=str((data or {}).get("dp_url")) if (data or {}).get("dp_url") is not None else None,
        offer_listing_url=str((data or {}).get("offer_listing_url")) if (data or {}).get("offer_listing_url") is not None else None,
        delivery_zip=str((data or {}).get("delivery_zip")) if (data or {}).get("delivery_zip") is not None else None,
    )
    session.add(run)

    # Child rows (ranks + best prices).
    if data is not None:
        if isinstance(data.get("sales_ranks"), list):
            for i, entry in enumerate(data["sales_ranks"]):
                if not isinstance(entry, dict):
                    continue
                rank = entry.get("rank")
                category = entry.get("category")
                if not isinstance(rank, int) or not isinstance(category, str):
                    continue
                session.add(
                    AmazonScrapeSalesRank(
                        run_id=run_id,
                        idx=i,
                        rank=rank,
                        category=category,
                        raw=str(entry.get("raw")) if entry.get("raw") is not None else None,
                    )
                )

        best = compute_best_prices(data.get("offers"))
        for bucket, best_price in best.items():
            session.add(
                AmazonScrapeBestPrice(
                    run_id=run_id,
                    condition_bucket=bucket,
                    price_total_cents=best_price.total_cents,
                    currency=best_price.currency,
                    source_offer_page=best_price.page,
                    source_offer_position=best_price.position,
                    source_seller_name=best_price.seller_name,
                )
            )

    # Snapshot upsert (simple get + update/insert).
    latest = await session.get(AmazonProductMetricsLatest, master_product_id)
    if latest is None:
        latest = AmazonProductMetricsLatest(
            master_product_id=master_product_id,
            last_attempt_at=finished_at,
            last_success_at=None,
            last_run_id=None,
            blocked_last=False,
            consecutive_failures=0,
        )
        session.add(latest)

    latest.last_attempt_at = finished_at
    latest.last_run_id = run_id
    latest.blocked_last = blocked
    latest.block_reason_last = run.block_reason
    latest.last_error = error

    if ok and data is not None:
        overall_rank, overall_cat, specific_rank, specific_cat = _derived_ranks(data)
        latest.rank_overall = overall_rank
        latest.rank_overall_category = overall_cat
        latest.rank_specific = specific_rank
        latest.rank_specific_category = specific_cat

        best = compute_best_prices(data.get("offers"))
        latest.price_new_cents = best.get(BUCKET_NEW).total_cents if BUCKET_NEW in best else None
        latest.price_used_like_new_cents = (
            best.get(BUCKET_USED_LIKE_NEW).total_cents if BUCKET_USED_LIKE_NEW in best else None
        )
        latest.price_used_very_good_cents = (
            best.get(BUCKET_USED_VERY_GOOD).total_cents if BUCKET_USED_VERY_GOOD in best else None
        )
        latest.price_used_good_cents = best.get(BUCKET_USED_GOOD).total_cents if BUCKET_USED_GOOD in best else None
        latest.price_used_acceptable_cents = (
            best.get(BUCKET_USED_ACCEPTABLE).total_cents if BUCKET_USED_ACCEPTABLE in best else None
        )
        latest.price_collectible_cents = (
            best.get(BUCKET_COLLECTIBLE).total_cents if BUCKET_COLLECTIBLE in best else None
        )

        latest.buybox_total_cents = _best_total_cents_for_buybox(data.get("buybox"))
        offers_count_total, offers_count_priced_total, offers_count_used_priced_total = _offer_counts(data.get("offers"))
        latest.offers_count_total = offers_count_total
        latest.offers_count_priced_total = offers_count_priced_total
        latest.offers_count_used_priced_total = offers_count_used_priced_total

        latest.last_success_at = finished_at
        latest.next_retry_at = None
        latest.consecutive_failures = 0

        mp = await session.get(MasterProduct, master_product_id)
        if mp is not None:
            image_url = _extract_image_url(data) or _asin_image_fallback_url(mp.asin)
            if image_url is not None:
                if settings is None:
                    mp.reference_image_url = image_url
                else:
                    local_image_path = await _store_reference_image_locally(
                        settings=settings,
                        master_product_id=master_product_id,
                        image_url=image_url,
                    )
                    if local_image_path is not None:
                        mp.reference_image_url = local_image_path
    else:
        # failure or blocked: keep last_success_at intact, schedule retry externally
        latest.consecutive_failures = max(0, int(latest.consecutive_failures or 0)) + 1

    return run_id


async def scrape_master_product_once(
    *,
    session: AsyncSession,
    settings: Settings,
    master_product_id: uuid.UUID,
    asin: str,
) -> uuid.UUID:
    finished_at = utcnow()
    data: dict[str, Any] | None = None
    error: str | None = None

    try:
        data = await fetch_scraper_json(settings=settings, asin=asin)
    except ScraperBusyError as e:
        raise
    except Exception as e:
        error = f"{type(e).__name__}: {e}"
    finally:
        finished_at = utcnow()

    run_id = await persist_scrape_result(
        session=session,
        settings=settings,
        master_product_id=master_product_id,
        asin=asin,
        data=data,
        error=error,
        finished_at=finished_at,
    )
    return run_id


async def select_due_master_product_ids(
    *,
    session: AsyncSession,
    min_success_interval_seconds: int,
    now: datetime,
) -> list[tuple[uuid.UUID, str]]:
    """
    Returns at most one (master_product_id, asin) to process next.
    """
    cutoff = now - timedelta(seconds=max(0, min_success_interval_seconds))

    latest = AmazonProductMetricsLatest
    mp = MasterProduct

    stmt = (
        select(mp.id, mp.asin)
        .outerjoin(latest, latest.master_product_id == mp.id)
        .where(mp.asin.is_not(None))
        .where(mp.asin != "")
        .where((latest.next_retry_at.is_(None)) | (latest.next_retry_at <= now))
        .where((latest.last_success_at.is_(None)) | (latest.last_success_at < cutoff))
        .order_by(latest.last_success_at.asc().nullsfirst())
        .limit(1)
    )
    rows = (await session.execute(stmt)).all()
    out: list[tuple[uuid.UUID, str]] = []
    for master_product_id, asin in rows:
        if isinstance(master_product_id, uuid.UUID) and isinstance(asin, str) and asin.strip():
            out.append((master_product_id, asin.strip()))
    return out


def next_backoff_seconds(*, consecutive_failures: int, max_backoff_seconds: int) -> int:
    # 15m, 30m, 60m, 2h, 4h, ... capped
    base = 15 * 60
    exp = min(10, max(0, consecutive_failures - 1))
    backoff = base * (2**exp)
    backoff = min(backoff, max(60, max_backoff_seconds))
    jitter = int(backoff * random.uniform(0.05, 0.15))
    return min(max_backoff_seconds, backoff + jitter)


async def set_next_retry_at(
    *,
    session: AsyncSession,
    master_product_id: uuid.UUID,
    next_retry_at: datetime | None,
) -> None:
    latest = await session.get(AmazonProductMetricsLatest, master_product_id)
    if latest is None:
        # Create a minimal row so the scheduler can pick it up.
        latest = AmazonProductMetricsLatest(
            master_product_id=master_product_id,
            last_attempt_at=utcnow(),
            last_success_at=None,
            last_run_id=None,
            blocked_last=False,
            consecutive_failures=0,
            next_retry_at=next_retry_at,
        )
        session.add(latest)
        return
    latest.next_retry_at = next_retry_at


async def delay(seconds: float) -> None:
    if seconds <= 0:
        return
    await asyncio.sleep(seconds)
