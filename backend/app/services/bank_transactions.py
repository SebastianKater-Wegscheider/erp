from __future__ import annotations

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.models.bank_account import BankAccount
from app.models.bank_transaction import BankTransaction
from app.models.purchase import Purchase


logger = logging.getLogger(__name__)

PROVIDER_GOCARDLESS_BANK_DATA = "GOCARDLESS_BANK_DATA"


@dataclass(slots=True)
class BankSyncStats:
    accounts_seen: int = 0
    accounts_created: int = 0
    transactions_seen: int = 0
    transactions_created: int = 0
    transactions_updated: int = 0


def _decimal_amount_to_cents(amount: str) -> int:
    """
    Provider amounts are typically strings like "-12.34".
    """
    cents = (Decimal(amount) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return int(cents)


def _parse_iso_date(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value
    s = str(value).strip()
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def _first_text(raw: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    for k in keys:
        v = raw.get(k)
        if v is None:
            continue
        s = str(v).strip()
        if s:
            return s
    return None


def _remittance_info(raw: dict[str, Any]) -> str | None:
    v = raw.get("remittanceInformationUnstructured")
    if isinstance(v, str) and v.strip():
        return v.strip()
    v = raw.get("remittanceInformationStructured")
    if isinstance(v, str) and v.strip():
        return v.strip()
    v = raw.get("remittanceInformationUnstructuredArray")
    if isinstance(v, list):
        parts = [str(p).strip() for p in v if str(p).strip()]
        if parts:
            return " | ".join(parts)
    return None


def _transaction_external_id(raw: dict[str, Any]) -> str:
    # Prefer the provider's stable IDs if present.
    for k in ("transactionId", "internalTransactionId", "entryReference"):
        v = raw.get(k)
        if v is None:
            continue
        s = str(v).strip()
        if s:
            return s[:200]

    # Fallback: stable hash of key fields.
    stable = {
        "bookingDate": _first_text(raw, ("bookingDate", "bookingDateTime", "valueDate", "transactionDate")),
        "valueDate": _first_text(raw, ("valueDate",)),
        "amount": (raw.get("transactionAmount") or {}).get("amount"),
        "currency": (raw.get("transactionAmount") or {}).get("currency"),
        "counterparty": _first_text(raw, ("creditorName", "debtorName", "counterpartyName")),
        "remittance": _remittance_info(raw),
    }
    h = hashlib.sha256(json.dumps(stable, sort_keys=True, ensure_ascii=True).encode("utf-8")).hexdigest()
    return f"hash_{h[:32]}"


def _extract_transaction_fields(raw: dict[str, Any], *, is_pending: bool, default_currency: str | None) -> dict[str, Any] | None:
    amt = raw.get("transactionAmount") or {}
    amount = amt.get("amount")
    currency = amt.get("currency") or default_currency
    if amount is None or currency is None:
        return None

    booked = _parse_iso_date(raw.get("bookingDate")) or _parse_iso_date(raw.get("valueDate")) or date.today()
    value = _parse_iso_date(raw.get("valueDate"))

    counterparty = _first_text(raw, ("creditorName", "debtorName", "counterpartyName"))
    remittance = _remittance_info(raw)

    return {
        "external_id": _transaction_external_id(raw),
        "booked_date": booked,
        "value_date": value,
        "amount_cents": _decimal_amount_to_cents(str(amount)),
        "currency": str(currency)[:3],
        "counterparty_name": counterparty[:200] if counterparty else None,
        "remittance_information": remittance,
        "is_pending": is_pending,
        "raw": raw,
    }


def _looks_like_jwt(token: str) -> bool:
    # Very lightweight check: JWTs have 3 dot-separated segments.
    parts = token.split(".")
    return len(parts) == 3 and all(p.strip() for p in parts)


def _bank_data_credentials_present(settings) -> bool:
    if settings.gocardless_bank_data_access_token:
        return True
    if settings.gocardless_bank_data_secret_id and settings.gocardless_bank_data_secret_key:
        return True
    if settings.gocardless_token and _looks_like_jwt(settings.gocardless_token):
        return True
    return False


async def _bank_data_access_token(client: httpx.AsyncClient, *, base_url: str) -> str:
    settings = get_settings()

    if settings.gocardless_bank_data_access_token:
        return settings.gocardless_bank_data_access_token

    if settings.gocardless_token and _looks_like_jwt(settings.gocardless_token):
        return settings.gocardless_token

    if not (settings.gocardless_bank_data_secret_id and settings.gocardless_bank_data_secret_key):
        if settings.gocardless_token and not _looks_like_jwt(settings.gocardless_token):
            raise ValueError(
                "GOCARDLESS_TOKEN looks like a GoCardless Pro token (e.g. 'live_...'), which cannot access Bank Account Data. "
                "Set GOCARDLESS_BANK_DATA_SECRET_ID + GOCARDLESS_BANK_DATA_SECRET_KEY (recommended) or GOCARDLESS_BANK_DATA_ACCESS_TOKEN."
            )
        raise ValueError(
            "Missing GoCardless Bank Account Data credentials. "
            "Set GOCARDLESS_BANK_DATA_SECRET_ID + GOCARDLESS_BANK_DATA_SECRET_KEY (recommended) or GOCARDLESS_BANK_DATA_ACCESS_TOKEN."
        )

    url = f"{base_url}/token/new/"
    r = await client.post(
        url,
        json={"secret_id": settings.gocardless_bank_data_secret_id, "secret_key": settings.gocardless_bank_data_secret_key},
    )
    try:
        r.raise_for_status()
    except httpx.HTTPStatusError as e:
        raise ValueError(f"GoCardless token/new failed ({e.response.status_code}): {e.response.text}") from e
    data = r.json()
    access = data.get("access")
    if not access:
        raise ValueError("GoCardless token/new response missing 'access'")
    return str(access)


async def _paginate(client: httpx.AsyncClient, url: str, *, headers: dict[str, str], params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    next_url: str | None = url
    next_params = params
    while next_url:
        r = await client.get(next_url, headers=headers, params=next_params)
        try:
            r.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise ValueError(f"GoCardless request failed ({e.response.status_code}): {e.response.text}") from e
        payload = r.json()
        results = payload.get("results")
        if isinstance(results, list):
            out.extend([x for x in results if isinstance(x, dict)])
        next_url = payload.get("next")
        next_params = None  # 'next' already encodes paging parameters.
    return out


async def _get_or_create_bank_account(session: AsyncSession, *, provider: str, external_id: str) -> tuple[BankAccount, bool]:
    row = (
        await session.execute(
            select(BankAccount).where(BankAccount.provider == provider, BankAccount.external_id == external_id)
        )
    ).scalar_one_or_none()
    if row is not None:
        return row, False

    row = BankAccount(provider=provider, external_id=external_id)
    session.add(row)
    await session.flush()
    return row, True


async def _maybe_enrich_account_details(
    session: AsyncSession,
    *,
    client: httpx.AsyncClient,
    base_url: str,
    headers: dict[str, str],
    account: BankAccount,
) -> None:
    # Best effort: details vary per institution and not all fields are guaranteed.
    url = f"{base_url}/accounts/{account.external_id}/details/"
    r = await client.get(url, headers=headers)
    if r.status_code >= 400:
        return
    try:
        data = r.json()
    except Exception:
        return

    acc = data.get("account") if isinstance(data, dict) else None
    if not isinstance(acc, dict):
        return

    iban = acc.get("iban")
    currency = acc.get("currency")
    name = acc.get("name") or acc.get("ownerName") or acc.get("product")

    if isinstance(iban, str) and iban.strip():
        account.iban = iban.strip()[:34]
    if isinstance(currency, str) and currency.strip():
        account.currency = currency.strip()[:3]
    if isinstance(name, str) and name.strip():
        account.name = name.strip()[:200]

    await session.flush()


async def _sync_account_transactions(
    session: AsyncSession,
    *,
    client: httpx.AsyncClient,
    base_url: str,
    headers: dict[str, str],
    account: BankAccount,
    stats: BankSyncStats,
) -> None:
    settings = get_settings()
    max_booked: date | None = (
        await session.execute(
            select(func.max(BankTransaction.booked_date)).where(BankTransaction.bank_account_id == account.id)
        )
    ).scalar_one()

    today = date.today()
    if max_booked:
        date_from = max_booked - timedelta(days=settings.bank_sync_overlap_days)
    elif settings.bank_sync_start_date:
        date_from = settings.bank_sync_start_date
    else:
        date_from = today - timedelta(days=settings.bank_sync_initial_lookback_days)

    url = f"{base_url}/accounts/{account.external_id}/transactions/"
    r = await client.get(
        url,
        headers=headers,
        params={"date_from": date_from.isoformat(), "date_to": today.isoformat()},
    )
    try:
        r.raise_for_status()
    except httpx.HTTPStatusError as e:
        raise ValueError(f"GoCardless transactions failed ({e.response.status_code}): {e.response.text}") from e

    payload = r.json()
    tx = payload.get("transactions") if isinstance(payload, dict) else None
    if not isinstance(tx, dict):
        return

    extracted: dict[str, dict[str, Any]] = {}
    for is_pending, items in (
        (False, tx.get("booked") or []),
        (True, tx.get("pending") or []),
    ):
        if not isinstance(items, list):
            continue
        for raw in items:
            if not isinstance(raw, dict):
                continue
            fields = _extract_transaction_fields(raw, is_pending=is_pending, default_currency=account.currency)
            if fields is None:
                continue
            extracted[fields["external_id"]] = fields

    if not extracted:
        account.last_synced_at = datetime.now(timezone.utc)
        await session.flush()
        return

    stats.transactions_seen += len(extracted)

    external_ids = list(extracted.keys())
    existing_rows = (
        await session.execute(
            select(BankTransaction)
            .where(BankTransaction.bank_account_id == account.id, BankTransaction.external_id.in_(external_ids))
        )
    ).scalars().all()
    existing_by_external = {r.external_id: r for r in existing_rows}

    for ext_id, fields in extracted.items():
        row = existing_by_external.get(ext_id)
        if row is None:
            session.add(
                BankTransaction(
                    bank_account_id=account.id,
                    **fields,
                )
            )
            stats.transactions_created += 1
            continue

        changed = False
        for attr in (
            "booked_date",
            "value_date",
            "amount_cents",
            "currency",
            "counterparty_name",
            "remittance_information",
            "is_pending",
            "raw",
        ):
            new_val = fields.get(attr)
            if getattr(row, attr) != new_val:
                setattr(row, attr, new_val)
                changed = True
        if changed:
            stats.transactions_updated += 1

    account.last_synced_at = datetime.now(timezone.utc)
    await session.flush()


async def sync_bank_transactions(session: AsyncSession) -> BankSyncStats:
    """
    Sync transactions from GoCardless Bank Account Data into local tables.
    """
    settings = get_settings()
    if not settings.bank_sync_enabled:
        return BankSyncStats()
    if not _bank_data_credentials_present(settings):
        # Raising here is useful for the manual sync endpoint; the background loop will catch & log.
        raise ValueError(
            "Bank sync is enabled but GoCardless Bank Account Data credentials are missing. "
            "Set GOCARDLESS_BANK_DATA_SECRET_ID + GOCARDLESS_BANK_DATA_SECRET_KEY (recommended) "
            "or GOCARDLESS_BANK_DATA_ACCESS_TOKEN."
        )

    base_url = settings.gocardless_bank_data_base_url.rstrip("/")

    stats = BankSyncStats()
    async with httpx.AsyncClient(timeout=30.0) as client:
        access = await _bank_data_access_token(client, base_url=base_url)
        headers = {"Authorization": f"Bearer {access}", "Accept": "application/json"}

        req_ids_filter: set[str] | None = None
        if settings.gocardless_bank_data_requisition_ids:
            req_ids_filter = {x.strip() for x in settings.gocardless_bank_data_requisition_ids.split(",") if x.strip()}

        requisitions = await _paginate(client, f"{base_url}/requisitions/", headers=headers, params={"limit": 100})
        for req in requisitions:
            req_id = str(req.get("id") or "").strip()
            if not req_id:
                continue
            if req_ids_filter is not None and req_id not in req_ids_filter:
                continue

            accounts = req.get("accounts")
            if not isinstance(accounts, list):
                # Some list endpoints might not include accounts; fetch detail.
                r = await client.get(f"{base_url}/requisitions/{req_id}/", headers=headers)
                if r.status_code < 400:
                    try:
                        req_detail = r.json()
                    except Exception:
                        req_detail = None
                    accounts = req_detail.get("accounts") if isinstance(req_detail, dict) else None

            if not isinstance(accounts, list):
                continue

            for account_external_id in accounts:
                ext = str(account_external_id).strip()
                if not ext:
                    continue

                stats.accounts_seen += 1
                account, created = await _get_or_create_bank_account(
                    session,
                    provider=PROVIDER_GOCARDLESS_BANK_DATA,
                    external_id=ext,
                )
                if created:
                    stats.accounts_created += 1
                    await _maybe_enrich_account_details(session, client=client, base_url=base_url, headers=headers, account=account)

                await _sync_account_transactions(
                    session,
                    client=client,
                    base_url=base_url,
                    headers=headers,
                    account=account,
                    stats=stats,
                )

    return stats


async def set_bank_transaction_purchases(
    session: AsyncSession,
    *,
    bank_transaction_id: uuid.UUID,
    purchase_ids: list[uuid.UUID],
) -> BankTransaction:
    tx = (
        await session.execute(
            select(BankTransaction)
            .where(BankTransaction.id == bank_transaction_id)
            .options(selectinload(BankTransaction.purchases))
        )
    ).scalar_one_or_none()
    if tx is None:
        raise ValueError("Bank transaction not found")

    purchases: list[Purchase] = []
    if purchase_ids:
        purchases = (await session.execute(select(Purchase).where(Purchase.id.in_(purchase_ids)))).scalars().all()
        found = {p.id for p in purchases}
        missing = [pid for pid in purchase_ids if pid not in found]
        if missing:
            raise ValueError(f"Unknown purchase id(s): {', '.join(str(m) for m in missing)}")

    tx.purchases = purchases
    await session.flush()
    return tx

