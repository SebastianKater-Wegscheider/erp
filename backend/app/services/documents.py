from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import DocumentType
from app.models.document_counter import DocumentCounter


def _prefix(doc_type: DocumentType) -> str:
    match doc_type:
        case DocumentType.PURCHASE_CREDIT_NOTE:
            return "CRN"
        case DocumentType.SALES_INVOICE:
            return "INV"
        case DocumentType.SALES_CORRECTION:
            return "COR"
        case DocumentType.PRIVATE_EQUITY_NOTE:
            return "PAIV"
    return "DOC"


async def next_document_number(session: AsyncSession, *, doc_type: DocumentType, issue_date: date) -> str:
    year = issue_date.year
    result = await session.execute(
        select(DocumentCounter)
        .where(DocumentCounter.doc_type == doc_type, DocumentCounter.year == year)
        .with_for_update()
    )
    counter = result.scalar_one_or_none()
    if counter is None:
        counter = DocumentCounter(doc_type=doc_type, year=year, next_number=1)
        session.add(counter)
        await session.flush()

    number = counter.next_number
    counter.next_number = counter.next_number + 1
    await session.flush()

    return f"{_prefix(doc_type)}-{year}-{number:06d}"
