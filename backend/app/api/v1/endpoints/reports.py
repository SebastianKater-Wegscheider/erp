from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.db import get_session
from app.schemas.reports import DashboardOut, MonthlyCloseParams
from app.services.reports import dashboard, monthly_close_zip


router = APIRouter()


@router.get("/dashboard", response_model=DashboardOut)
async def get_dashboard(session: AsyncSession = Depends(get_session)) -> DashboardOut:
    data = await dashboard(session, today=date.today())
    return DashboardOut(
        inventory_value_cents=data["inventory_value_cents"],
        cash_balance_cents=data["cash_balance_cents"],
        gross_profit_month_cents=data["gross_profit_month_cents"],
    )


@router.post("/month-close")
async def month_close_export(params: MonthlyCloseParams, session: AsyncSession = Depends(get_session)) -> Response:
    settings = get_settings()
    filename, content = await monthly_close_zip(
        session, year=params.year, month=params.month, storage_dir=settings.app_storage_dir
    )
    return Response(
        content=content,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
