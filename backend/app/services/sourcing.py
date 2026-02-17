from __future__ import annotations

import asyncio
import logging
import math
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import Settings, get_settings
from app.core.enums import InventoryCondition, PaymentSource, PurchaseKind, PurchaseType, SourcingPlatform, SourcingStatus
from app.models.amazon_scrape import AmazonProductMetricsLatest
from app.models.master_product import MasterProduct
from app.models.sourcing import SourcingItem, SourcingMatch, SourcingRun, SourcingSetting
from app.schemas.purchase import PurchaseCreate, PurchaseLineCreate
from app.schemas.sourcing import SourcingConversionLineOut, SourcingConversionPreviewOut, SourcingConvertOut
from app.services.audit import audit_log
from app.services.purchases import create_purchase, normalize_source_platform_label
from app.services.target_pricing import fba_payout_cents


logger = logging.getLogger(__name__)

SessionLocal = None


try:
    from rapidfuzz import fuzz, process
except Exception:  # pragma: no cover
    fuzz = None
    process = None


@dataclass
class SourcingRunResult:
    run_id: uuid.UUID
    status: str
    started_at: datetime
    finished_at: datetime | None
    items_scraped: int
    items_new: int
    items_ready: int


@dataclass
class _ResolvedSettings:
    bsr_max_threshold: int
    price_min_cents: int
    price_max_cents: int
    confidence_min_score: int
    profit_min_cents: int
    roi_min_bp: int
    scrape_interval_seconds: int
    handling_cost_per_item_cents: int
    shipping_cost_cents: int
    search_terms: list[str]


_IMMEDIATE_DISCARD_TERMS = (
    "suche",
    "defekt",
    "kaputt",
    "repro",
    "reproduction",
    "hulle ohne spiel",
    "leerverpackung",
    "nur verpackung",
)

_POST_FILTER_BLACKLIST = (
    "fifa",
    "pes",
    "efootball",
    "nhl 20",
    "madden",
)

_KLEINANZEIGEN_TZ = ZoneInfo("Europe/Berlin")
_DETAIL_ENRICHMENT_MAX_ITEMS_PER_RUN = 12
_DETAIL_ENRICHMENT_THRESHOLD_FACTOR_BP = 8000


def utcnow() -> datetime:
    return datetime.now(UTC)


def _fold(value: str) -> str:
    return (
        value.replace("Ä", "Ae")
        .replace("Ö", "Oe")
        .replace("Ü", "Ue")
        .replace("ä", "ae")
        .replace("ö", "oe")
        .replace("ü", "ue")
        .replace("ß", "ss")
        .lower()
    )


def _to_int(raw: Any, default: int) -> int:
    if isinstance(raw, int):
        return raw
    try:
        return int(raw)
    except Exception:
        return default


def _to_str_list(raw: Any, fallback: list[str]) -> list[str]:
    if isinstance(raw, list):
        out = [str(v).strip() for v in raw if str(v).strip()]
        return out or fallback
    return fallback


def _platform_label(platform: SourcingPlatform) -> str:
    if platform == SourcingPlatform.KLEINANZEIGEN:
        return "Kleinanzeigen"
    if platform == SourcingPlatform.WILLHABEN:
        return "willhaben.at"
    return "Kleinanzeigen"


async def _load_resolved_settings(session: AsyncSession, app_settings: Settings) -> _ResolvedSettings:
    rows = (await session.execute(select(SourcingSetting))).scalars().all()
    by_key = {row.key: row for row in rows}

    def int_setting(key: str, default: int) -> int:
        row = by_key.get(key)
        if row is None:
            return default
        return _to_int(row.value_int, default)

    def json_setting(key: str, fallback: list[str]) -> list[str]:
        row = by_key.get(key)
        if row is None:
            return fallback
        return _to_str_list(row.value_json, fallback)

    return _ResolvedSettings(
        bsr_max_threshold=int_setting("bsr_max_threshold", 50_000),
        price_min_cents=int_setting("price_min_cents", 500),
        price_max_cents=int_setting("price_max_cents", 30_000),
        confidence_min_score=int_setting("confidence_min_score", app_settings.sourcing_match_confidence_min_score),
        profit_min_cents=int_setting("profit_min_cents", 3_000),
        roi_min_bp=int_setting("roi_min_bp", 5_000),
        scrape_interval_seconds=int_setting("scrape_interval_seconds", app_settings.sourcing_default_interval_seconds),
        handling_cost_per_item_cents=int_setting("handling_cost_per_item_cents", 150),
        shipping_cost_cents=int_setting("shipping_cost_cents", 690),
        search_terms=json_setting(
            "search_terms",
            ["videospiele konvolut", "retro spiele sammlung", "nintendo spiele paket"],
        ),
    )


def _pre_discard_reason(*, title: str, seller_type: str | None) -> str | None:
    if seller_type and _fold(seller_type).strip() in {"gewerblich", "commercial"}:
        return "Commercial seller"
    folded = _fold(title)
    for term in _IMMEDIATE_DISCARD_TERMS:
        if term in folded:
            return f"Immediate blacklist term: {term}"
    return None


def _post_filter_reason(*, item: SourcingItem, cfg: _ResolvedSettings) -> str | None:
    if item.price_cents < cfg.price_min_cents or item.price_cents > cfg.price_max_cents:
        return f"Price outside range ({item.price_cents / 100:.2f} EUR)"

    folded = _fold(item.title)
    for term in _POST_FILTER_BLACKLIST:
        if term in folded:
            return f"Blacklisted title term: {term}"
    return None


def _parse_kleinanzeigen_posted_at(raw: str | None, *, now: datetime | None = None) -> datetime | None:
    text = re.sub(r"\s+", " ", str(raw or "").replace("\u200b", " ")).strip()
    if not text:
        return None

    now_utc = now or utcnow()
    if now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=UTC)
    local_now = now_utc.astimezone(_KLEINANZEIGEN_TZ)

    lowered = text.lower()
    time_match = re.search(r"\b(\d{1,2}):(\d{2})\b", lowered)
    hour = int(time_match.group(1)) if time_match else 0
    minute = int(time_match.group(2)) if time_match else 0
    if hour > 23 or minute > 59:
        return None

    try:
        if "heute" in lowered:
            base = local_now.date()
        elif "gestern" in lowered:
            base = (local_now - timedelta(days=1)).date()
        else:
            date_match = re.search(r"\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b", lowered)
            if not date_match:
                return None
            day = int(date_match.group(1))
            month = int(date_match.group(2))
            year = int(date_match.group(3))
            base = datetime(year=year, month=month, day=day, tzinfo=_KLEINANZEIGEN_TZ).date()
        localized = datetime(
            year=base.year,
            month=base.month,
            day=base.day,
            hour=hour,
            minute=minute,
            tzinfo=_KLEINANZEIGEN_TZ,
        )
    except ValueError:
        return None

    return localized.astimezone(UTC)


async def _scraper_fetch(*, app_settings: Settings, search_terms: list[str]) -> dict[str, Any]:
    timeout = httpx.Timeout(timeout=app_settings.sourcing_scraper_timeout_seconds)
    url = f"{app_settings.sourcing_scraper_base_url.rstrip('/')}/scrape"
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, json={"platform": "kleinanzeigen", "search_terms": search_terms})
    resp.raise_for_status()
    payload = resp.json()
    if not isinstance(payload, dict):
        raise RuntimeError("Invalid sourcing scraper payload")
    return payload


async def _scraper_fetch_listing_detail(*, app_settings: Settings, url: str) -> dict[str, Any]:
    timeout = httpx.Timeout(timeout=app_settings.sourcing_scraper_timeout_seconds)
    endpoint = f"{app_settings.sourcing_scraper_base_url.rstrip('/')}/listing-detail"
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(endpoint, json={"platform": "kleinanzeigen", "url": url})
    resp.raise_for_status()
    payload = resp.json()
    if not isinstance(payload, dict):
        raise RuntimeError("Invalid sourcing detail payload")
    return payload


def _is_detail_enrichment_candidate(*, item: SourcingItem, cfg: _ResolvedSettings) -> bool:
    if not str(item.url or "").strip():
        return False
    if item.status == SourcingStatus.READY:
        return True
    profit = int(item.estimated_profit_cents or 0)
    roi_bp = int(item.estimated_roi_bp or 0)
    profit_threshold = int(cfg.profit_min_cents * _DETAIL_ENRICHMENT_THRESHOLD_FACTOR_BP / 10_000)
    roi_threshold = int(cfg.roi_min_bp * _DETAIL_ENRICHMENT_THRESHOLD_FACTOR_BP / 10_000)
    return profit >= profit_threshold and roi_bp >= roi_threshold


def _merge_detail_payload_into_item(*, item: SourcingItem, detail: dict[str, Any]) -> None:
    if not detail:
        return

    description_full = str(detail.get("description_full") or "").strip()
    if description_full and (not item.description or len(description_full) > len(item.description)):
        item.description = description_full

    detail_price = detail.get("price_cents")
    if isinstance(detail_price, int) and detail_price >= 0:
        item.price_cents = int(detail_price)

    detail_images_raw = detail.get("image_urls")
    detail_images: list[str] = []
    if isinstance(detail_images_raw, list):
        detail_images = [str(v).strip() for v in detail_images_raw if str(v).strip()]
    if detail_images:
        deduped = list(dict.fromkeys(detail_images))
        item.image_urls = deduped
        if not item.primary_image_url or item.primary_image_url not in deduped:
            item.primary_image_url = deduped[0]

    detail_seller_type = str(detail.get("seller_type") or "").strip().lower()
    if detail_seller_type in {"private", "commercial"}:
        item.seller_type = detail_seller_type

    posted_at_text = str(detail.get("posted_at_text") or "").strip()
    if posted_at_text:
        parsed_posted_at = _parse_kleinanzeigen_posted_at(posted_at_text)
        if parsed_posted_at is not None:
            item.posted_at = parsed_posted_at

    merged_raw = dict(item.raw_data or {})
    for key, value in detail.items():
        if value is None:
            continue
        if isinstance(value, list) and len(value) == 0:
            continue
        merged_raw[key] = value
    merged_raw["detail_enriched_at"] = utcnow().isoformat()
    item.raw_data = merged_raw


def _used_market_price_cents(metrics: AmazonProductMetricsLatest | None) -> int | None:
    if metrics is None:
        return None
    vals = [
        metrics.price_used_like_new_cents,
        metrics.price_used_very_good_cents,
        metrics.price_used_good_cents,
        metrics.price_used_acceptable_cents,
    ]
    ints = [int(v) for v in vals if isinstance(v, int)]
    return min(ints) if ints else None


def _rf_match(title: str, candidates: list[str], score_cutoff: int, limit: int = 10) -> list[tuple[str, int, int]]:
    if process is not None and fuzz is not None:
        return [
            (str(matched), int(score), int(idx))
            for matched, score, idx in process.extract(
                title,
                candidates,
                scorer=fuzz.token_sort_ratio,
                limit=limit,
                score_cutoff=score_cutoff,
            )
        ]

    # Fallback for environments where rapidfuzz is unavailable.
    from difflib import SequenceMatcher

    out: list[tuple[str, int, int]] = []
    base = _fold(title)
    for idx, candidate in enumerate(candidates):
        score = int(SequenceMatcher(a=base, b=_fold(candidate)).ratio() * 100)
        if score >= score_cutoff:
            out.append((candidate, score, idx))
    out.sort(key=lambda x: x[1], reverse=True)
    return out[:limit]


async def _recalculate_item(
    *,
    item: SourcingItem,
    matches: list[SourcingMatch],
    cfg: _ResolvedSettings,
    confirmed_only: bool,
    app_settings: Settings,
) -> None:
    usable = [m for m in matches if not m.user_rejected]
    if confirmed_only:
        usable = [m for m in usable if m.user_confirmed]

    total_revenue_cents = 0
    sellable_count = 0

    for match in usable:
        if match.snapshot_bsr is not None and match.snapshot_bsr > cfg.bsr_max_threshold:
            continue

        if isinstance(match.snapshot_used_price_cents, int):
            market_price = int(match.snapshot_used_price_cents)
        elif isinstance(match.snapshot_new_price_cents, int):
            market_price = int(match.snapshot_new_price_cents * 0.7)
        else:
            continue

        payout = (
            int(match.snapshot_fba_payout_cents)
            if isinstance(match.snapshot_fba_payout_cents, int)
            else fba_payout_cents(
                market_price_cents=market_price,
                referral_fee_bp=app_settings.amazon_fba_referral_fee_bp,
                fulfillment_fee_cents=app_settings.amazon_fba_fulfillment_fee_cents,
                inbound_shipping_cents=app_settings.amazon_fba_inbound_shipping_cents,
            )
        )

        total_revenue_cents += int(payout * 0.8)
        sellable_count += 1

    if sellable_count == 0:
        item.estimated_revenue_cents = 0
        item.estimated_profit_cents = 0
        item.estimated_roi_bp = 0
        item.status = SourcingStatus.LOW_VALUE
        item.status_reason = "No sellable items"
        item.analyzed_at = utcnow()
        return

    acquisition_cost = int(item.price_cents)
    shipping_cost = int(cfg.shipping_cost_cents)
    handling_cost = sellable_count * int(cfg.handling_cost_per_item_cents)
    total_cost = acquisition_cost + shipping_cost + handling_cost

    profit = total_revenue_cents - total_cost
    roi_bp = int((profit / total_cost) * 10_000) if total_cost > 0 else 0

    item.estimated_revenue_cents = total_revenue_cents
    item.estimated_profit_cents = profit
    item.estimated_roi_bp = roi_bp
    item.analyzed_at = utcnow()

    if profit >= cfg.profit_min_cents and roi_bp >= cfg.roi_min_bp:
        item.status = SourcingStatus.READY
        item.status_reason = f"{sellable_count} sellable item(s)"
    else:
        item.status = SourcingStatus.LOW_VALUE
        item.status_reason = f"Profit too low: {profit / 100:.2f} EUR ({roi_bp / 100:.2f}% ROI)"


async def _analyze_item(
    *,
    session: AsyncSession,
    item: SourcingItem,
    cfg: _ResolvedSettings,
    app_settings: Settings,
    candidates: list[tuple[MasterProduct, AmazonProductMetricsLatest | None]],
    candidate_titles: list[str],
) -> None:
    post_reason = _post_filter_reason(item=item, cfg=cfg)
    if post_reason is not None:
        item.status = SourcingStatus.LOW_VALUE
        item.status_reason = post_reason
        item.analyzed_at = utcnow()
        return

    item.status = SourcingStatus.ANALYZING

    rows = _rf_match(item.title, candidate_titles, cfg.confidence_min_score)

    matches: list[SourcingMatch] = []
    now = utcnow()
    for matched_title, score, idx in rows:
        mp, metrics = candidates[idx]
        if metrics is None or metrics.last_success_at is None:
            continue

        last_success = metrics.last_success_at
        if last_success.tzinfo is None:
            last_success = last_success.replace(tzinfo=UTC)
        if now - last_success > timedelta(hours=24):
            continue

        used_price = _used_market_price_cents(metrics)
        new_price = metrics.price_new_cents
        market_price = used_price if isinstance(used_price, int) else (
            int(new_price * 0.7) if isinstance(new_price, int) else None
        )
        payout = (
            fba_payout_cents(
                market_price_cents=market_price,
                referral_fee_bp=app_settings.amazon_fba_referral_fee_bp,
                fulfillment_fee_cents=app_settings.amazon_fba_fulfillment_fee_cents,
                inbound_shipping_cents=app_settings.amazon_fba_inbound_shipping_cents,
            )
            if isinstance(market_price, int)
            else None
        )

        match = SourcingMatch(
            sourcing_item_id=item.id,
            master_product_id=mp.id,
            confidence_score=int(score),
            match_method="title_fuzzy",
            matched_substring=matched_title,
            snapshot_bsr=metrics.rank_overall,
            snapshot_new_price_cents=new_price,
            snapshot_used_price_cents=used_price,
            snapshot_fba_payout_cents=payout,
        )
        session.add(match)
        matches.append(match)

    await session.flush()

    if not matches:
        item.status = SourcingStatus.LOW_VALUE
        item.status_reason = "No confident matches"
        item.analyzed_at = utcnow()
        item.estimated_revenue_cents = 0
        item.estimated_profit_cents = 0
        item.estimated_roi_bp = 0
        return

    await _recalculate_item(
        item=item,
        matches=matches,
        cfg=cfg,
        confirmed_only=False,
        app_settings=app_settings,
    )


async def _allocate_proportional(total: int, weights: list[int]) -> list[int]:
    if not weights:
        return []
    safe_weights = [max(1, int(w)) for w in weights]
    weight_sum = sum(safe_weights)

    raw = [(total * w) / weight_sum for w in safe_weights]
    base = [int(math.floor(v)) for v in raw]
    remainder = total - sum(base)
    order = sorted(range(len(raw)), key=lambda i: (raw[i] - base[i]), reverse=True)
    for idx in order[:remainder]:
        base[idx] += 1
    return base


def _condition_from_match(match: SourcingMatch) -> InventoryCondition:
    raw = (match.user_adjusted_condition or "").strip().upper()
    try:
        return InventoryCondition(raw)
    except Exception:
        return InventoryCondition.GOOD


async def build_conversion_preview(
    *,
    session: AsyncSession,
    item: SourcingItem,
    cfg: _ResolvedSettings,
    confirmed_match_ids: list[uuid.UUID] | None,
) -> SourcingConversionPreviewOut:
    selected: list[SourcingMatch] = []
    by_id = {m.id: m for m in item.matches}

    if confirmed_match_ids:
        for match_id in confirmed_match_ids:
            match = by_id.get(match_id)
            if match is not None and not match.user_rejected:
                selected.append(match)
    else:
        selected = [m for m in item.matches if m.user_confirmed and not m.user_rejected]

    if not selected:
        selected = [m for m in item.matches if not m.user_rejected]

    if not selected:
        raise ValueError("No usable matches selected")

    weights = [int(m.snapshot_fba_payout_cents or 1) for m in selected]
    allocations = await _allocate_proportional(int(item.price_cents), weights)

    lines: list[SourcingConversionLineOut] = []
    for match, alloc in zip(selected, allocations, strict=True):
        est_margin = None
        if isinstance(match.snapshot_fba_payout_cents, int):
            est_margin = int(match.snapshot_fba_payout_cents) - int(alloc)
        lines.append(
            SourcingConversionLineOut(
                master_product_id=match.master_product_id,
                condition=_condition_from_match(match).value,
                purchase_price_cents=int(alloc),
                estimated_margin_cents=est_margin,
            )
        )

    return SourcingConversionPreviewOut(
        purchase_kind=PurchaseKind.PRIVATE_DIFF.value,
        payment_source=PaymentSource.BANK.value,
        total_amount_cents=int(item.price_cents),
        shipping_cost_cents=int(cfg.shipping_cost_cents),
        lines=lines,
    )


async def convert_item_to_purchase(
    *,
    session: AsyncSession,
    actor: str,
    item: SourcingItem,
    cfg: _ResolvedSettings,
    confirmed_match_ids: list[uuid.UUID],
) -> SourcingConvertOut:
    if item.status == SourcingStatus.CONVERTED and item.converted_purchase_id is not None:
        raise ValueError("Item already converted")
    if item.status == SourcingStatus.DISCARDED:
        raise ValueError("Discarded item cannot be converted")

    preview = await build_conversion_preview(
        session=session,
        item=item,
        cfg=cfg,
        confirmed_match_ids=confirmed_match_ids,
    )

    line_inputs = [
        PurchaseLineCreate(
            master_product_id=line.master_product_id,
            condition=InventoryCondition(line.condition),
            purchase_type=PurchaseType.DIFF,
            purchase_price_cents=line.purchase_price_cents,
        )
        for line in preview.lines
    ]

    platform_label = normalize_source_platform_label(_platform_label(item.platform))
    purchase = await create_purchase(
        session,
        actor=actor,
        data=PurchaseCreate(
            kind=PurchaseKind.PRIVATE_DIFF,
            purchase_date=utcnow().date(),
            counterparty_name=f"Sourcing {platform_label or 'Listing'}",
            counterparty_address=None,
            counterparty_birthdate=None,
            counterparty_id_number=None,
            source_platform=platform_label,
            listing_url=item.url,
            notes=f"Sourcing item {item.id}",
            total_amount_cents=preview.total_amount_cents,
            shipping_cost_cents=preview.shipping_cost_cents,
            buyer_protection_fee_cents=0,
            tax_rate_bp=0,
            payment_source=PaymentSource.BANK,
            lines=line_inputs,
        ),
    )

    item.status = SourcingStatus.CONVERTED
    item.status_reason = f"Converted to purchase {purchase.id}"
    item.converted_purchase_id = purchase.id

    await audit_log(
        session,
        actor=actor,
        entity_type="sourcing_item",
        entity_id=item.id,
        action="convert",
        before={"status": SourcingStatus.READY.value},
        after={"status": SourcingStatus.CONVERTED.value, "purchase_id": str(purchase.id)},
    )

    return SourcingConvertOut(
        purchase_id=purchase.id,
        purchase_kind=PurchaseKind.PRIVATE_DIFF.value,
        total_amount_cents=preview.total_amount_cents,
        shipping_cost_cents=preview.shipping_cost_cents,
        lines=preview.lines,
    )


async def execute_sourcing_run(
    *,
    force: bool,
    search_terms: list[str] | None,
    trigger: str,
    app_settings: Settings | None = None,
) -> SourcingRunResult:
    app_settings = app_settings or get_settings()
    started_at = utcnow()

    async with _get_session_local()() as session:
        cfg = await _load_resolved_settings(session, app_settings)
        if not force:
            last_run = (
                await session.execute(select(SourcingRun).order_by(SourcingRun.started_at.desc()).limit(1))
            ).scalar_one_or_none()
            if last_run is not None:
                since = started_at - (last_run.started_at if last_run.started_at.tzinfo else last_run.started_at.replace(tzinfo=UTC))
                if since.total_seconds() < cfg.scrape_interval_seconds:
                    return SourcingRunResult(
                        run_id=last_run.id,
                        status="skipped",
                        started_at=started_at,
                        finished_at=started_at,
                        items_scraped=0,
                        items_new=0,
                        items_ready=0,
                    )

    terms = [t for t in (search_terms or []) if t.strip()]
    if not terms:
        async with _get_session_local()() as session:
            cfg = await _load_resolved_settings(session, app_settings)
            terms = cfg.search_terms

    async with _get_session_local()() as session:
        async with session.begin():
            run = SourcingRun(
                trigger=trigger,
                platform=SourcingPlatform.KLEINANZEIGEN,
                started_at=started_at,
                ok=False,
                search_terms=terms,
            )
            session.add(run)
            await session.flush()
            run_id = run.id

    payload: dict[str, Any]
    blocked = False
    err_type: str | None = None
    err_msg: str | None = None
    listings: list[dict[str, Any]] = []

    try:
        payload = await _scraper_fetch(app_settings=app_settings, search_terms=terms)
        blocked = bool(payload.get("blocked") is True)
        err_type = str(payload.get("error_type") or "").strip() or None
        err_msg = str(payload.get("error_message") or "").strip() or None
        raw_listings = payload.get("listings")
        if isinstance(raw_listings, list):
            listings = [entry for entry in raw_listings if isinstance(entry, dict)]
    except Exception as exc:
        err_type = "network"
        err_msg = str(exc)

    items_new = 0
    items_ready = 0
    detail_candidates: list[tuple[uuid.UUID, str]] = []

    async with _get_session_local()() as session:
        async with session.begin():
            run = await session.get(SourcingRun, run_id)
            if run is None:
                raise RuntimeError("Sourcing run not found")

            cfg = await _load_resolved_settings(session, app_settings)

            candidate_rows = (
                await session.execute(
                    select(MasterProduct, AmazonProductMetricsLatest)
                    .outerjoin(AmazonProductMetricsLatest, AmazonProductMetricsLatest.master_product_id == MasterProduct.id)
                    .where(MasterProduct.asin.is_not(None), func.trim(MasterProduct.asin) != "")
                )
            ).all()
            candidates = [(row[0], row[1]) for row in candidate_rows]
            candidate_titles = [row[0].title for row in candidate_rows]

            for listing in listings:
                title = str(listing.get("title") or "").strip()
                external_id = str(listing.get("external_id") or "").strip()
                if not title or not external_id:
                    continue

                pre_reason = _pre_discard_reason(title=title, seller_type=str(listing.get("seller_type") or "").strip() or None)
                if pre_reason is not None:
                    continue

                existing = (
                    await session.execute(
                        select(SourcingItem.id).where(
                            SourcingItem.platform == SourcingPlatform.KLEINANZEIGEN,
                            SourcingItem.external_id == external_id,
                        )
                    )
                ).scalar_one_or_none()
                if existing is not None:
                    continue

                item = SourcingItem(
                    platform=SourcingPlatform.KLEINANZEIGEN,
                    external_id=external_id,
                    url=str(listing.get("url") or "").strip(),
                    title=title,
                    description=str(listing.get("description") or "").strip() or None,
                    price_cents=_to_int(listing.get("price_cents"), 0),
                    location_zip=str(listing.get("location_zip") or "").strip() or None,
                    location_city=str(listing.get("location_city") or "").strip() or None,
                    seller_type=str(listing.get("seller_type") or "").strip() or None,
                    image_urls=[str(u) for u in listing.get("image_urls", []) if str(u).strip()]
                    if isinstance(listing.get("image_urls"), list)
                    else None,
                    primary_image_url=str(listing.get("primary_image_url") or "").strip() or None,
                    raw_data=listing,
                    posted_at=_parse_kleinanzeigen_posted_at(str(listing.get("posted_at_text") or "").strip() or None),
                    last_run_id=run.id,
                )
                session.add(item)
                await session.flush()
                items_new += 1

                await _analyze_item(
                    session=session,
                    item=item,
                    cfg=cfg,
                    app_settings=app_settings,
                    candidates=candidates,
                    candidate_titles=candidate_titles,
                )
                if item.status == SourcingStatus.READY:
                    items_ready += 1
                if _is_detail_enrichment_candidate(item=item, cfg=cfg):
                    detail_candidates.append((item.id, item.url))

            run.items_scraped = len(listings)
            run.items_new = items_new
            run.items_ready = items_ready
            run.finished_at = utcnow()
            run.blocked = blocked

            if err_type or err_msg:
                run.ok = False
                run.error_type = err_type
                run.error_message = err_msg
            else:
                run.ok = True
                run.error_type = None
                run.error_message = None

    detail_payloads: dict[uuid.UUID, dict[str, Any]] = {}
    for item_id, item_url in detail_candidates[:_DETAIL_ENRICHMENT_MAX_ITEMS_PER_RUN]:
        try:
            detail_payload = await _scraper_fetch_listing_detail(app_settings=app_settings, url=item_url)
        except Exception:
            continue
        if detail_payload.get("blocked") is True:
            continue
        listing_detail = detail_payload.get("listing")
        if isinstance(listing_detail, dict) and listing_detail:
            detail_payloads[item_id] = listing_detail

    if detail_payloads:
        async with _get_session_local()() as session:
            async with session.begin():
                rows = (
                    await session.execute(
                        select(SourcingItem).where(SourcingItem.id.in_(list(detail_payloads.keys())))
                    )
                ).scalars().all()
                by_id = {row.id: row for row in rows}
                for item_id, detail in detail_payloads.items():
                    item = by_id.get(item_id)
                    if item is None:
                        continue
                    _merge_detail_payload_into_item(item=item, detail=detail)

    status = "completed"
    if err_type:
        status = "error"
    elif blocked:
        status = "blocked"

    return SourcingRunResult(
        run_id=run_id,
        status=status,
        started_at=started_at,
        finished_at=utcnow(),
        items_scraped=len(listings),
        items_new=items_new,
        items_ready=items_ready,
    )


async def recalculate_item_from_matches(
    *,
    session: AsyncSession,
    item: SourcingItem,
    confirmed_only: bool,
    app_settings: Settings | None = None,
) -> None:
    app_settings = app_settings or get_settings()
    cfg = await _load_resolved_settings(session, app_settings)
    matches = (
        await session.execute(select(SourcingMatch).where(SourcingMatch.sourcing_item_id == item.id))
    ).scalars().all()
    await _recalculate_item(
        item=item,
        matches=list(matches),
        cfg=cfg,
        confirmed_only=confirmed_only,
        app_settings=app_settings,
    )


async def discard_item(*, session: AsyncSession, actor: str, item: SourcingItem, reason: str | None) -> None:
    before_status = item.status.value
    item.status = SourcingStatus.DISCARDED
    item.status_reason = (reason or "Discarded by user").strip()
    await audit_log(
        session,
        actor=actor,
        entity_type="sourcing_item",
        entity_id=item.id,
        action="discard",
        before={"status": before_status},
        after={"status": item.status.value, "reason": item.status_reason},
    )


async def get_settings_map(session: AsyncSession) -> dict[str, SourcingSetting]:
    rows = (await session.execute(select(SourcingSetting))).scalars().all()
    return {row.key: row for row in rows}


async def load_resolved_settings(
    session: AsyncSession,
    app_settings: Settings | None = None,
) -> _ResolvedSettings:
    return await _load_resolved_settings(session, app_settings or get_settings())


async def update_settings_values(
    *,
    session: AsyncSession,
    values: dict[str, dict[str, Any]],
) -> list[SourcingSetting]:
    existing = await get_settings_map(session)
    now = utcnow()
    updated: list[SourcingSetting] = []

    for key, payload in values.items():
        row = existing.get(key)
        if row is None:
            row = SourcingSetting(key=key)
            session.add(row)
        if "value_int" in payload:
            row.value_int = payload.get("value_int")
        if "value_text" in payload:
            row.value_text = payload.get("value_text")
        if "value_json" in payload:
            row.value_json = payload.get("value_json")
        row.updated_at = now
        updated.append(row)

    await session.flush()
    return updated


async def sleep_with_jitter(base_seconds: float) -> None:
    await asyncio.sleep(base_seconds)


def _get_session_local():
    global SessionLocal
    if SessionLocal is None:
        from app.core.db import SessionLocal as _SessionLocal

        SessionLocal = _SessionLocal
    return SessionLocal
