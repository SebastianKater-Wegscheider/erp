from __future__ import annotations

from datetime import date

import pytest

from app.core.enums import DocumentType
from app.services.documents import next_document_number


@pytest.mark.asyncio
async def test_next_document_number_increments_per_type_and_year(db_session) -> None:
    async with db_session.begin():
        first = await next_document_number(
            db_session,
            doc_type=DocumentType.SALES_INVOICE,
            issue_date=date(2026, 2, 8),
        )
        second = await next_document_number(
            db_session,
            doc_type=DocumentType.SALES_INVOICE,
            issue_date=date(2026, 2, 9),
        )
        other_type = await next_document_number(
            db_session,
            doc_type=DocumentType.SALES_CORRECTION,
            issue_date=date(2026, 2, 9),
        )
        next_year = await next_document_number(
            db_session,
            doc_type=DocumentType.SALES_INVOICE,
            issue_date=date(2027, 1, 1),
        )

    assert first == "INV-2026-000001"
    assert second == "INV-2026-000002"
    assert other_type == "COR-2026-000001"
    assert next_year == "INV-2027-000001"
