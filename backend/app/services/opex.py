from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ledger_entry import LedgerEntry
from app.models.opex_expense import OpexExpense
from app.schemas.opex import OpexCreate
from app.services.audit import audit_log


async def create_opex(session: AsyncSession, *, actor: str, data: OpexCreate) -> OpexExpense:
    expense = OpexExpense(
        expense_date=data.expense_date,
        recipient=data.recipient,
        category=data.category,
        amount_cents=data.amount_cents,
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
        after={"category": expense.category, "amount_cents": expense.amount_cents, "payment_source": expense.payment_source},
    )

    return expense

