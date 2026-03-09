from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import shutil
import tomllib
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.enums import SourcingEvaluationStatus, SourcingPlatform, SourcingStatus
from app.models.amazon_scrape import AmazonProductMetricsLatest
from app.models.master_product import MasterProduct
from app.models.sourcing import SourcingItem, SourcingSetting


logger = logging.getLogger(__name__)

PROMPT_VERSION = "2026-03-09-v2"
SUPPORTED_SOURCING_PLATFORMS = {
    SourcingPlatform.KLEINANZEIGEN,
    SourcingPlatform.EBAY_DE,
}


class CodexMatchedProduct(BaseModel):
    master_product_id: str | None = None
    sku: str | None = None
    title: str | None = None
    asin: str | None = None
    confidence: int | None = Field(default=None, ge=0, le=100)
    basis: str | None = None


class CodexEvaluationResult(BaseModel):
    recommendation: str | None = Field(default=None, pattern="^(BUY|WATCH|SKIP|NEEDS_REVIEW)$")
    summary: str | None = None
    expected_profit_cents: int | None = None
    expected_roi_bp: int | None = None
    max_buy_price_cents: int | None = None
    confidence: int | None = Field(default=None, ge=0, le=100)
    amazon_source_used: str | None = None
    matched_products: list[CodexMatchedProduct] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    reasoning_notes: list[str] = Field(default_factory=list)


@dataclass
class CodexWorkspace:
    root: Path
    summary_path: Path
    full_path: Path
    prompt_path: Path
    schema_path: Path
    response_path: Path


def utcnow():
    from app.services.sourcing import utcnow as _utcnow

    return _utcnow()


def ensure_supported_platform(platform: SourcingPlatform) -> None:
    if platform not in SUPPORTED_SOURCING_PLATFORMS:
        raise ValueError(f"Unsupported sourcing platform: {platform.value}")


async def _load_sourcing_int_setting(
    session: AsyncSession,
    key: str,
    default: int,
) -> int:
    row = await session.get(SourcingSetting, key)
    if row is None or row.value_int is None:
        return default
    try:
        return int(row.value_int)
    except Exception:
        return default


def _best_used_price_cents(metrics: AmazonProductMetricsLatest | None) -> int | None:
    if metrics is None:
        return None
    for value in (
        metrics.price_used_like_new_cents,
        metrics.price_used_very_good_cents,
        metrics.price_used_good_cents,
        metrics.price_used_acceptable_cents,
    ):
        if isinstance(value, int):
            return value
    return None


async def _catalog_pricing_context(session: AsyncSession) -> list[dict[str, Any]]:
    stmt = select(MasterProduct, AmazonProductMetricsLatest).outerjoin(
        AmazonProductMetricsLatest,
        AmazonProductMetricsLatest.master_product_id == MasterProduct.id,
    )
    stmt = stmt.order_by(MasterProduct.title.asc(), MasterProduct.platform.asc(), MasterProduct.variant.asc())
    rows = (await session.execute(stmt)).all()
    out: list[dict[str, Any]] = []
    for product, metrics in rows:
        out.append(
            {
                "master_product_id": str(product.id),
                "kind": product.kind.value if hasattr(product.kind, "value") else str(product.kind),
                "sku": product.sku,
                "title": product.title,
                "platform": product.platform,
                "region": product.region,
                "variant": product.variant,
                "asin": product.asin,
                "ean": product.ean,
                "manufacturer": product.manufacturer,
                "model": product.model,
                "genre": product.genre,
                "release_year": product.release_year,
                "amazon_cached": {
                    "last_success_at": metrics.last_success_at.isoformat() if metrics and metrics.last_success_at else None,
                    "rank_overall": metrics.rank_overall if metrics else None,
                    "rank_specific": metrics.rank_specific if metrics else None,
                    "price_new_cents": metrics.price_new_cents if metrics else None,
                    "price_used_like_new_cents": metrics.price_used_like_new_cents if metrics else None,
                    "price_used_very_good_cents": metrics.price_used_very_good_cents if metrics else None,
                    "price_used_good_cents": metrics.price_used_good_cents if metrics else None,
                    "price_used_acceptable_cents": metrics.price_used_acceptable_cents if metrics else None,
                    "best_used_price_cents": _best_used_price_cents(metrics),
                    "buybox_total_cents": metrics.buybox_total_cents if metrics else None,
                    "offers_count_total": metrics.offers_count_total if metrics else None,
                    "offers_count_used_priced_total": metrics.offers_count_used_priced_total if metrics else None,
                },
            }
        )
    return out


async def build_evaluation_payload(
    *,
    session: AsyncSession,
    item: SourcingItem,
    settings: Settings,
) -> tuple[dict[str, Any], dict[str, Any]]:
    catalog = await _catalog_pricing_context(session)
    shipping_cost_cents = await _load_sourcing_int_setting(session, "shipping_cost_cents", 690)
    handling_cost_cents = await _load_sourcing_int_setting(session, "handling_cost_per_item_cents", 150)

    image_urls = [str(v) for v in (item.image_urls or []) if str(v).strip()]
    raw = dict(item.raw_data or {})
    summary = {
        "task": {
            "goal": "Evaluate whether this sourcing listing looks attractive for resale.",
            "rules": [
                "Identify the concrete sellable items in the listing yourself from the listing data.",
                "Do not fetch the marketplace listing URL.",
                "Use the staged listing data only.",
                "Use the provided ERP product catalog and cached Amazon data for price comparisons.",
                "Do not use live web search in this first pass.",
                "Return JSON only, following schema.json exactly.",
            ],
        },
        "listing": {
            "id": str(item.id),
            "platform": item.platform.value,
            "external_id": item.external_id,
            "url": item.url,
            "title": item.title,
            "price_cents": item.price_cents,
            "location_zip": item.location_zip,
            "location_city": item.location_city,
            "seller_type": item.seller_type,
            "posted_at": item.posted_at.isoformat() if item.posted_at else None,
            "scraped_at": item.scraped_at.isoformat() if item.scraped_at else None,
            "description_short": (item.description or "")[:1200] or None,
            "image_count": len(image_urls),
            "auction_end_at": item.auction_end_at.isoformat() if item.auction_end_at else None,
            "auction_current_price_cents": item.auction_current_price_cents,
            "auction_bid_count": item.auction_bid_count,
            "shipping_possible": raw.get("shipping_possible"),
            "direct_buy": raw.get("direct_buy"),
            "price_negotiable": raw.get("price_negotiable"),
        },
        "erp_context": {
            "catalog_scope": "Full ERP product catalog with cached Amazon metrics. This data was not prefiltered to the listing.",
            "catalog_total_products": len(catalog),
            "known_product_catalog": catalog,
            "cost_assumptions": {
                "shipping_cost_cents": shipping_cost_cents,
                "handling_cost_per_item_cents": handling_cost_cents,
                "amazon_fba_referral_fee_bp": settings.amazon_fba_referral_fee_bp,
                "amazon_fba_fulfillment_fee_cents": settings.amazon_fba_fulfillment_fee_cents,
                "amazon_fba_inbound_shipping_cents": settings.amazon_fba_inbound_shipping_cents,
            },
        },
    }
    full = {
        "listing": {
            "id": str(item.id),
            "platform": item.platform.value,
            "external_id": item.external_id,
            "url": item.url,
            "title": item.title,
            "description": item.description,
            "price_cents": item.price_cents,
            "location_zip": item.location_zip,
            "location_city": item.location_city,
            "seller_type": item.seller_type,
            "posted_at": item.posted_at.isoformat() if item.posted_at else None,
            "scraped_at": item.scraped_at.isoformat() if item.scraped_at else None,
            "image_urls": image_urls,
            "raw_data": raw,
        },
        "auction": {
            "auction_end_at": item.auction_end_at.isoformat() if item.auction_end_at else None,
            "auction_current_price_cents": item.auction_current_price_cents,
            "auction_bid_count": item.auction_bid_count,
        },
        "erp_context": summary["erp_context"],
    }
    return summary, full


def _schema_json() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "recommendation": {"type": ["string", "null"], "enum": ["BUY", "WATCH", "SKIP", "NEEDS_REVIEW", None]},
            "summary": {"type": ["string", "null"]},
            "expected_profit_cents": {"type": ["integer", "null"]},
            "expected_roi_bp": {"type": ["integer", "null"]},
            "max_buy_price_cents": {"type": ["integer", "null"]},
            "confidence": {"type": ["integer", "null"], "minimum": 0, "maximum": 100},
            "amazon_source_used": {"type": ["string", "null"]},
            "matched_products": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "master_product_id": {"type": ["string", "null"]},
                        "sku": {"type": ["string", "null"]},
                        "title": {"type": ["string", "null"]},
                        "asin": {"type": ["string", "null"]},
                        "confidence": {"type": ["integer", "null"], "minimum": 0, "maximum": 100},
                        "basis": {"type": ["string", "null"]},
                    },
                    "required": ["master_product_id", "sku", "title", "asin", "confidence", "basis"],
                },
            },
            "risks": {"type": "array", "items": {"type": "string"}},
            "reasoning_notes": {"type": "array", "items": {"type": "string"}},
        },
        "required": [
            "recommendation",
            "summary",
            "expected_profit_cents",
            "expected_roi_bp",
            "max_buy_price_cents",
            "confidence",
            "amazon_source_used",
            "matched_products",
            "risks",
            "reasoning_notes",
        ],
    }


def _prompt_text(summary: dict[str, Any], full: dict[str, Any]) -> str:
    return "\n".join(
        [
            "Evaluate this listing for resale using only the provided inline JSON.",
            "Identify any individual games, consoles, accessories, bundles, or variants yourself from the listing data.",
            "Then compare your identified items against the full ERP product catalog and cached Amazon pricing data included below.",
            "Do not fetch the marketplace URL.",
            "Do not use live web search in this first pass.",
            "Do not assume the ERP catalog has already been filtered down to likely matches.",
            "Estimate profit, ROI, and max buy price in cents/basis points.",
            "Set amazon_source_used to a short label such as cached, live, mixed, or none.",
            "Return JSON only matching schema.json.",
            "",
            "summary.json:",
            json.dumps(summary, ensure_ascii=True, separators=(",", ":")),
            "",
            "full.json:",
            json.dumps(full, ensure_ascii=True, separators=(",", ":")),
        ]
    )


def _workspace_for_item(settings: Settings, item_id: str) -> CodexWorkspace:
    root = settings.app_storage_dir / "sourcing-evals" / item_id
    return CodexWorkspace(
        root=root,
        summary_path=root / "summary.json",
        full_path=root / "full.json",
        prompt_path=root / "prompt.txt",
        schema_path=root / "schema.json",
        response_path=root / "response.json",
    )


async def stage_workspace(
    *,
    session: AsyncSession,
    item: SourcingItem,
    settings: Settings,
) -> CodexWorkspace:
    workspace = _workspace_for_item(settings, str(item.id))
    workspace.root.mkdir(parents=True, exist_ok=True)
    summary, full = await build_evaluation_payload(session=session, item=item, settings=settings)
    workspace.summary_path.write_text(json.dumps(summary, ensure_ascii=True, indent=2), encoding="utf-8")
    workspace.full_path.write_text(json.dumps(full, ensure_ascii=True, indent=2), encoding="utf-8")
    workspace.schema_path.write_text(json.dumps(_schema_json(), ensure_ascii=True, indent=2), encoding="utf-8")
    workspace.prompt_path.write_text(_prompt_text(summary, full), encoding="utf-8")
    return workspace


def _build_codex_command(settings: Settings, workspace: CodexWorkspace) -> list[str]:
    cmd = [settings.codex_binary_path, "exec"]
    if settings.codex_model:
        cmd.extend(["-m", settings.codex_model])
    cmd.extend(
        [
            "-c",
            f"features.search_tool={'true' if settings.codex_search_enabled else 'false'}",
        ]
    )
    cmd.extend(
        [
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--cd",
            str(workspace.root),
            "--output-schema",
            str(workspace.schema_path),
            "--output-last-message",
            str(workspace.response_path),
            "-",
        ]
    )
    return cmd


def _load_codex_source_config(settings: Settings) -> dict[str, Any]:
    config_path = settings.codex_auth_source_dir / "config.toml"
    if not config_path.exists():
        return {}
    try:
        return tomllib.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("Could not parse Codex config.toml", extra={"path": str(config_path)}, exc_info=True)
        return {}


def _runtime_codex_model(settings: Settings, source_config: dict[str, Any]) -> str | None:
    if settings.codex_model:
        return settings.codex_model.strip() or None
    value = source_config.get("model")
    return value.strip() if isinstance(value, str) and value.strip() else None


def _runtime_codex_reasoning_effort(settings: Settings, source_config: dict[str, Any]) -> str | None:
    if settings.codex_reasoning_effort:
        return settings.codex_reasoning_effort.strip() or None
    value = source_config.get("model_reasoning_effort")
    return value.strip() if isinstance(value, str) and value.strip() else None


def _prepare_codex_home(*, workspace: CodexWorkspace, settings: Settings) -> Path:
    runtime_home = workspace.root / ".codex-home"
    runtime_codex_dir = runtime_home / ".codex"
    runtime_codex_dir.mkdir(parents=True, exist_ok=True)

    auth_source = settings.codex_auth_source_dir / "auth.json"
    if not auth_source.exists():
        raise RuntimeError(f"Codex auth.json not found at {auth_source}")

    shutil.copyfile(auth_source, runtime_codex_dir / "auth.json")
    source_config = _load_codex_source_config(settings)
    runtime_config_lines: list[str] = []
    model = _runtime_codex_model(settings, source_config)
    reasoning_effort = _runtime_codex_reasoning_effort(settings, source_config)
    if model:
        runtime_config_lines.append(f'model = "{model}"')
    if reasoning_effort:
        runtime_config_lines.append(f'model_reasoning_effort = "{reasoning_effort}"')
    runtime_config_lines.append("[features]")
    runtime_config_lines.append(f"search_tool = {'true' if settings.codex_search_enabled else 'false'}")
    (runtime_codex_dir / "config.toml").write_text("\n".join(runtime_config_lines) + "\n", encoding="utf-8")
    return runtime_home


async def run_codex_evaluation(
    *,
    workspace: CodexWorkspace,
    settings: Settings,
) -> tuple[CodexEvaluationResult, str]:
    if not settings.codex_enabled:
        raise RuntimeError("Codex evaluation is disabled")
    binary_path = shutil.which(settings.codex_binary_path) if not Path(settings.codex_binary_path).is_absolute() else settings.codex_binary_path
    if not binary_path or not Path(binary_path).exists():
        raise RuntimeError(f"Codex binary not found: {settings.codex_binary_path}")

    cmd = _build_codex_command(settings, workspace)
    runtime_home = _prepare_codex_home(workspace=workspace, settings=settings)
    env = os.environ.copy()
    env["HOME"] = str(runtime_home)
    env["CODEX_HOME"] = str(runtime_home / ".codex")
    prompt_text = workspace.prompt_path.read_text(encoding="utf-8")

    def _run() -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            cmd,
            cwd=str(workspace.root),
            env=env,
            input=prompt_text,
            text=True,
            capture_output=True,
            timeout=settings.codex_timeout_seconds,
            check=False,
        )

    try:
        completed = await asyncio.to_thread(_run)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Codex evaluation timed out") from exc

    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(detail or f"Codex exited with status {completed.returncode}")

    raw_response = workspace.response_path.read_text(encoding="utf-8").strip()
    if not raw_response:
        raw_response = completed.stdout.strip()
    try:
        parsed = CodexEvaluationResult.model_validate_json(raw_response)
    except ValidationError as exc:
        raise RuntimeError(f"Invalid Codex response: {exc}") from exc
    return parsed, raw_response


def queue_item_for_evaluation(item: SourcingItem) -> None:
    now = utcnow()
    item.evaluation_status = SourcingEvaluationStatus.PENDING
    item.evaluation_queued_at = now
    item.evaluation_started_at = None
    item.evaluation_finished_at = None
    item.evaluation_last_error = None
    item.evaluation_summary = None
    item.evaluation_result_json = None
    item.evaluation_raw_response = None
    item.evaluation_prompt_version = PROMPT_VERSION
    item.recommendation = None
    item.expected_profit_cents = None
    item.expected_roi_bp = None
    item.max_buy_price_cents = None
    item.evaluation_confidence = None
    item.amazon_source_used = None
    if item.status not in {SourcingStatus.DISCARDED, SourcingStatus.CONVERTED}:
        item.status = SourcingStatus.NEW
        item.status_reason = None


def _apply_evaluation_result(item: SourcingItem, result: CodexEvaluationResult, raw_response: str) -> None:
    finished_at = utcnow()
    item.evaluation_status = SourcingEvaluationStatus.COMPLETED
    item.evaluation_finished_at = finished_at
    item.evaluation_last_error = None
    item.evaluation_summary = result.summary
    item.evaluation_result_json = result.model_dump(mode="json")
    item.evaluation_raw_response = raw_response
    item.evaluation_prompt_version = PROMPT_VERSION
    item.recommendation = result.recommendation
    item.expected_profit_cents = result.expected_profit_cents
    item.expected_roi_bp = result.expected_roi_bp
    item.max_buy_price_cents = result.max_buy_price_cents
    item.evaluation_confidence = result.confidence
    item.amazon_source_used = _normalize_amazon_source_used(result.amazon_source_used)
    if item.status not in {SourcingStatus.DISCARDED, SourcingStatus.CONVERTED}:
        item.status = SourcingStatus.NEW
        item.status_reason = f"Codex recommendation: {result.recommendation or 'n/a'}"


def _apply_evaluation_failure(item: SourcingItem, error_message: str) -> None:
    item.evaluation_status = SourcingEvaluationStatus.FAILED
    item.evaluation_finished_at = utcnow()
    item.evaluation_last_error = error_message
    item.evaluation_summary = None
    item.evaluation_result_json = None
    item.evaluation_raw_response = None
    item.recommendation = None
    item.expected_profit_cents = None
    item.expected_roi_bp = None
    item.max_buy_price_cents = None
    item.evaluation_confidence = None
    item.amazon_source_used = None
    if item.status not in {SourcingStatus.DISCARDED, SourcingStatus.CONVERTED}:
        item.status = SourcingStatus.ERROR
        item.status_reason = error_message


def _normalize_amazon_source_used(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    lowered = text.lower()
    if lowered in {"none", "n/a", "na", "unknown"}:
        return "none"
    has_live = any(token in lowered for token in ("live", "web", "search"))
    has_cached = any(
        token in lowered
        for token in ("cache", "cached", "erp", "db", "catalog", "buybox", "price_", "rank_", "amazon_")
    )
    if has_live and has_cached:
        return "mixed"
    if has_live:
        return "live"
    if has_cached:
        return "cached"
    return text[:32]


async def claim_next_pending_item(session: AsyncSession, settings: Settings | None = None) -> Any | None:
    settings = settings or get_settings()
    stale_before = utcnow() - timedelta(seconds=max(60, int(settings.codex_timeout_seconds) + 30))
    stale_stmt = select(SourcingItem).where(
        SourcingItem.evaluation_status == SourcingEvaluationStatus.RUNNING,
        SourcingItem.evaluation_started_at.is_not(None),
        SourcingItem.evaluation_started_at < stale_before,
        SourcingItem.evaluation_attempt_count < max(1, int(settings.codex_max_attempts)),
    ).order_by(SourcingItem.evaluation_started_at.asc())
    stale_items = (await session.execute(stale_stmt)).scalars().all()
    stale_claim_id: Any | None = None
    for item in stale_items:
        queue_item_for_evaluation(item)
        item.status = SourcingStatus.NEW
        item.status_reason = "Requeued after stale Codex run"
        item.evaluation_last_error = "Previous Codex run exceeded timeout window and was requeued"
        if stale_claim_id is None:
            stale_claim_id = item.id

    if stale_claim_id is not None:
        item = await session.get(SourcingItem, stale_claim_id)
        if item is not None:
            item.evaluation_status = SourcingEvaluationStatus.RUNNING
            item.evaluation_started_at = utcnow()
            item.evaluation_finished_at = None
            item.evaluation_attempt_count = int(item.evaluation_attempt_count or 0) + 1
            item.evaluation_last_error = None
            item.evaluation_prompt_version = PROMPT_VERSION
            await session.flush()
            return stale_claim_id

    stmt = (
        select(SourcingItem.id)
        .where(
            SourcingItem.evaluation_status == SourcingEvaluationStatus.PENDING,
            SourcingItem.evaluation_attempt_count < max(1, int(settings.codex_max_attempts)),
        )
        .order_by(SourcingItem.evaluation_queued_at.asc().nullsfirst(), SourcingItem.scraped_at.asc())
        .limit(1)
    )
    item_id = (await session.execute(stmt)).scalar_one_or_none()
    if item_id is None:
        return None
    item = await session.get(SourcingItem, item_id)
    if item is None:
        return None
    item.evaluation_status = SourcingEvaluationStatus.RUNNING
    item.evaluation_started_at = utcnow()
    item.evaluation_finished_at = None
    item.evaluation_attempt_count = int(item.evaluation_attempt_count or 0) + 1
    item.evaluation_last_error = None
    item.evaluation_prompt_version = PROMPT_VERSION
    await session.flush()
    return item_id


async def evaluate_item_by_id(
    *,
    session: AsyncSession,
    item_id: Any,
    settings: Settings | None = None,
    item_already_claimed: bool = False,
) -> None:
    settings = settings or get_settings()
    item = await session.get(SourcingItem, item_id)
    if item is None:
        raise RuntimeError("Sourcing item not found")
    ensure_supported_platform(item.platform)
    if not item_already_claimed:
        item.evaluation_status = SourcingEvaluationStatus.RUNNING
        item.evaluation_started_at = utcnow()
        item.evaluation_finished_at = None
        item.evaluation_attempt_count = int(item.evaluation_attempt_count or 0) + 1
        item.evaluation_last_error = None
        item.evaluation_prompt_version = PROMPT_VERSION
        await session.flush()

    workspace = await stage_workspace(session=session, item=item, settings=settings)
    try:
        result, raw_response = await run_codex_evaluation(workspace=workspace, settings=settings)
    except Exception as exc:
        _apply_evaluation_failure(item, str(exc))
        raise
    else:
        _apply_evaluation_result(item, result, raw_response)


async def codex_evaluation_worker_loop(settings: Settings) -> None:
    from app.core.db import SessionLocal

    tick = max(5, int(settings.codex_queue_tick_seconds))
    while True:
        try:
            if not settings.sourcing_enabled or not settings.codex_enabled:
                await asyncio.sleep(tick)
                continue
            async with SessionLocal() as session:
                item_id = await claim_next_pending_item(session, settings=settings)
                await session.commit()
                if item_id is None:
                    await asyncio.sleep(tick)
                    continue
                try:
                    await evaluate_item_by_id(session=session, item_id=item_id, settings=settings, item_already_claimed=True)
                except Exception:
                    logger.warning("Codex evaluation failed", extra={"item_id": str(item_id)}, exc_info=True)
                await session.commit()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Codex evaluation worker tick failed")
            await asyncio.sleep(tick)
