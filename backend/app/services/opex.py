from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.ledger_entry import LedgerEntry
from app.models.opex_expense import OpexExpense
from app.schemas.opex import OpexCreate
from app.services.audit import audit_log
from app.services.money import split_gross_to_net_and_tax


async def create_opex(session: AsyncSession, *, actor: str, data: OpexCreate) -> OpexExpense:
    settings = get_settings()
    tax_rate_bp = data.tax_rate_bp if settings.vat_enabled else 0
    input_tax_deductible = data.input_tax_deductible if settings.vat_enabled else False

    net, tax = split_gross_to_net_and_tax(gross_cents=data.amount_cents, tax_rate_bp=tax_rate_bp)
    expense = OpexExpense(
        expense_date=data.expense_date,
        recipient=data.recipient,
        category=data.category,
        amount_cents=data.amount_cents,
        amount_net_cents=net,
        amount_tax_cents=tax,
        tax_rate_bp=tax_rate_bp,
        input_tax_deductible=input_tax_deductible,
        payment_source=data.payment_source,
        receipt_upload_path=data.receipt_upload_path,
    )
    session.add(expense)
    await session.flush()

    session.add(
        LedgerEntry(
            entry_date=data.expense_date,
            account=data.payment_source,
            amount_cents=-data.amount_cents,
            entity_type="opex",
            entity_id=expense.id,
            memo=f"{data.category} {data.recipient}".strip()[:500],
        )
    )

    await audit_log(
        session,
        actor=actor,
        entity_type="opex",
        entity_id=expense.id,
        action="create",
        after={
            "category": expense.category,
            "amount_cents": expense.amount_cents,
            "amount_net_cents": expense.amount_net_cents,
            "amount_tax_cents": expense.amount_tax_cents,
            "tax_rate_bp": expense.tax_rate_bp,
            "input_tax_deductible": expense.input_tax_deductible,
            "payment_source": expense.payment_source,
        },
    )

    return expense
