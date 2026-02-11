from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.endpoints.master_products import bulk_import_master_products
from app.models.master_product import MasterProduct
from app.schemas.master_product import MasterProductBulkImportIn


@pytest.mark.asyncio
async def test_bulk_import_master_products_imports_valid_rows_and_reports_row_errors(db_session: AsyncSession) -> None:
    out = await bulk_import_master_products(
        MasterProductBulkImportIn(
            csv_text=(
                "kind,title,platform,region,variant,ean\n"
                "GAME,Mario Kart 64,Nintendo 64,EU,Classic,1234567890123\n"
                "Spiel,Super Mario 64,Nintendo 64,EU,,\n"
                "GAME,,Nintendo 64,EU,,\n"
            )
        ),
        db_session,
    )

    assert out.total_rows == 3
    assert out.imported_count == 2
    assert out.failed_count == 1
    assert out.skipped_count == 0
    assert len(out.errors) == 1
    assert out.errors[0].row_number == 4
    assert "title" in out.errors[0].message.lower()

    created = (await db_session.execute(select(MasterProduct).order_by(MasterProduct.title))).scalars().all()
    assert [item.title for item in created] == ["Mario Kart 64", "Super Mario 64"]


@pytest.mark.asyncio
async def test_bulk_import_master_products_supports_semicolon_header_aliases_and_default_region(db_session: AsyncSession) -> None:
    out = await bulk_import_master_products(
        MasterProductBulkImportIn(
            csv_text=(
                "Typ;Titel;Plattform;Variante\n"
                "Konsole;PlayStation 2;Sony;\n"
                "Konsole;PlayStation 2;Sony;\n"
            )
        ),
        db_session,
    )

    assert out.total_rows == 2
    assert out.imported_count == 1
    assert out.failed_count == 1
    assert out.errors[0].row_number == 3

    created = (await db_session.execute(select(MasterProduct))).scalars().all()
    assert len(created) == 1
    assert created[0].kind == "CONSOLE"
    assert created[0].region == "EU"
