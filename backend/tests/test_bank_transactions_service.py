from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import InventoryCondition, PaymentSource, PurchaseKind, PurchaseType
from app.models.bank_account import BankAccount
from app.models.bank_transaction import BankTransaction
from app.models.master_product import MasterProduct
from app.schemas.purchase import PurchaseCreate, PurchaseLineCreate
from app.services.bank_transactions import (
    _bank_data_credentials_present,
    _decimal_amount_to_cents,
    _extract_transaction_fields,
    _parse_iso_date,
    _transaction_external_id,
    set_bank_transaction_purchases,
)
from app.services.purchases import create_purchase


ACTOR = "tester"


@pytest.mark.parametrize(
    ("amount", "expected"),
    [
        ("12.34", 1234),
        ("-12.34", -1234),
        ("0.005", 1),
        ("-0.005", -1),
    ],
)
def test_decimal_amount_to_cents_rounds_half_up(amount: str, expected: int) -> None:
    assert _decimal_amount_to_cents(amount) == expected


def test_parse_iso_date_parses_datetime_objects_as_date() -> None:
    parsed = _parse_iso_date(datetime(2026, 2, 8, 12, 30, tzinfo=timezone.utc))
    assert parsed == date(2026, 2, 8)
    assert isinstance(parsed, date)
    assert not isinstance(parsed, datetime)


def test_extract_transaction_fields_prefers_structured_fields() -> None:
    raw = {
        "transactionId": "tx-1",
        "bookingDate": "2026-02-07",
        "valueDate": "2026-02-08",
        "transactionAmount": {"amount": "-12.34", "currency": "EUR"},
        "creditorName": "Supplier",
        "remittanceInformationUnstructuredArray": ["invoice 100", "batch a"],
    }
    fields = _extract_transaction_fields(raw, is_pending=False, default_currency=None)
    assert fields is not None
    assert fields["external_id"] == "tx-1"
    assert fields["booked_date"] == date(2026, 2, 7)
    assert fields["value_date"] == date(2026, 2, 8)
    assert fields["amount_cents"] == -1234
    assert fields["counterparty_name"] == "Supplier"
    assert fields["remittance_information"] == "invoice 100 | batch a"


def test_transaction_external_id_fallback_is_stable_hash() -> None:
    raw = {
        "bookingDate": "2026-02-07",
        "valueDate": "2026-02-08",
        "transactionAmount": {"amount": "-12.34", "currency": "EUR"},
        "creditorName": "Supplier",
        "remittanceInformationUnstructured": "invoice 100",
    }
    first = _transaction_external_id(raw)
    second = _transaction_external_id(raw)
    assert first == second
    assert first.startswith("hash_")


def test_bank_data_credentials_present_detects_only_valid_variants() -> None:
    class Settings:
        def __init__(
            self,
            *,
            access_token: str | None,
            secret_id: str | None,
            secret_key: str | None,
            token: str | None,
        ):
            self.gocardless_bank_data_access_token = access_token
            self.gocardless_bank_data_secret_id = secret_id
            self.gocardless_bank_data_secret_key = secret_key
            self.gocardless_token = token

    assert _bank_data_credentials_present(Settings(access_token="abc", secret_id=None, secret_key=None, token=None))
    assert _bank_data_credentials_present(Settings(access_token=None, secret_id="id", secret_key="key", token=None))
    assert _bank_data_credentials_present(Settings(access_token=None, secret_id=None, secret_key=None, token="a.b.c"))
    assert not _bank_data_credentials_present(Settings(access_token=None, secret_id=None, secret_key=None, token="live_123"))


@pytest.mark.asyncio
async def test_set_bank_transaction_purchases_links_rows(db_session: AsyncSession) -> None:
    async with db_session.begin():
        mp = MasterProduct(kind="GAME", title="Bank Product", platform="PS5", region="EU", variant="bank")
        db_session.add(mp)
        await db_session.flush()

        purchase = await create_purchase(
            db_session,
            actor=ACTOR,
            data=PurchaseCreate(
                kind=PurchaseKind.PRIVATE_DIFF,
                purchase_date=date(2026, 2, 8),
                counterparty_name="Privat",
                total_amount_cents=1_000,
                payment_source=PaymentSource.BANK,
                lines=[
                    PurchaseLineCreate(
                        master_product_id=mp.id,
                        condition=InventoryCondition.GOOD,
                        purchase_type=PurchaseType.DIFF,
                        purchase_price_cents=1_000,
                    )
                ],
            ),
        )

        account = BankAccount(provider="GOCARDLESS_BANK_DATA", external_id="acc-1")
        db_session.add(account)
        await db_session.flush()

        tx = BankTransaction(
            bank_account_id=account.id,
            external_id="tx-1",
            booked_date=date(2026, 2, 8),
            value_date=date(2026, 2, 8),
            amount_cents=-1_000,
            currency="EUR",
            counterparty_name="Privat",
            remittance_information="Kauf",
            is_pending=False,
            raw={"id": "tx-1"},
        )
        db_session.add(tx)
        await db_session.flush()

    async with db_session.begin():
        linked = await set_bank_transaction_purchases(
            db_session,
            bank_transaction_id=tx.id,
            purchase_ids=[purchase.id],
        )

    assert linked.purchase_ids == [purchase.id]


@pytest.mark.asyncio
async def test_set_bank_transaction_purchases_rejects_unknown_purchase_ids(db_session: AsyncSession) -> None:
    async with db_session.begin():
        account = BankAccount(provider="GOCARDLESS_BANK_DATA", external_id="acc-2")
        db_session.add(account)
        await db_session.flush()

        tx = BankTransaction(
            bank_account_id=account.id,
            external_id="tx-2",
            booked_date=date(2026, 2, 8),
            amount_cents=-500,
            currency="EUR",
            is_pending=False,
            raw={"id": "tx-2"},
        )
        db_session.add(tx)
        await db_session.flush()

    with pytest.raises(ValueError, match="Unknown purchase id"):
        async with db_session.begin():
            await set_bank_transaction_purchases(
                db_session,
                bank_transaction_id=tx.id,
                purchase_ids=[uuid.uuid4()],
            )
