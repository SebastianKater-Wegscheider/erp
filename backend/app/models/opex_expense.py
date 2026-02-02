from __future__ import annotations

from datetime import date

from sqlalchemy import Boolean, Date, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.enums import OpexCategory, PaymentSource
from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.sql_enums import opex_category_enum, payment_source_enum


class OpexExpense(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "opex_expenses"

    expense_date: Mapped[date] = mapped_column(Date, nullable=False)
    recipient: Mapped[str] = mapped_column(String(200), nullable=False)

    category: Mapped[OpexCategory] = mapped_column(opex_category_enum, nullable=False)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    amount_net_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    amount_tax_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tax_rate_bp: Mapped[int] = mapped_column(Integer, nullable=False, default=2000)
    input_tax_deductible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    payment_source: Mapped[PaymentSource] = mapped_column(payment_source_enum, nullable=False)

    receipt_upload_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
