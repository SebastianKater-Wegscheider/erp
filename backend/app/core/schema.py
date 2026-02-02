from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection


async def ensure_schema(conn: AsyncConnection) -> None:
    """
    Minimal, idempotent schema upgrades for the MVP.

    This project currently relies on SQLAlchemy `create_all()` at startup.
    `create_all()` does not add new columns to existing tables, so we keep a small
    set of `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` statements here.

    This is intentionally limited and should be replaced with Alembic migrations
    once the schema stabilizes.
    """
    stmts = [
        # purchases
        "ALTER TABLE purchases ADD COLUMN IF NOT EXISTS total_net_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE purchases ADD COLUMN IF NOT EXISTS total_tax_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE purchases ADD COLUMN IF NOT EXISTS tax_rate_bp INTEGER NOT NULL DEFAULT 0",
        # purchase_lines
        "ALTER TABLE purchase_lines ADD COLUMN IF NOT EXISTS purchase_price_net_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE purchase_lines ADD COLUMN IF NOT EXISTS purchase_price_tax_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE purchase_lines ADD COLUMN IF NOT EXISTS tax_rate_bp INTEGER NOT NULL DEFAULT 0",
        # sales_orders
        "ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS shipping_regular_gross_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS shipping_regular_net_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS shipping_regular_tax_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS shipping_margin_gross_cents INTEGER NOT NULL DEFAULT 0",
        # sales_order_lines
        "ALTER TABLE sales_order_lines ADD COLUMN IF NOT EXISTS shipping_allocated_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sales_order_lines ADD COLUMN IF NOT EXISTS cost_basis_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sales_order_lines ADD COLUMN IF NOT EXISTS margin_gross_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sales_order_lines ADD COLUMN IF NOT EXISTS margin_net_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sales_order_lines ADD COLUMN IF NOT EXISTS margin_tax_cents INTEGER NOT NULL DEFAULT 0",
        # sales_corrections
        "ALTER TABLE sales_corrections ADD COLUMN IF NOT EXISTS shipping_refund_regular_gross_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sales_corrections ADD COLUMN IF NOT EXISTS shipping_refund_regular_net_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sales_corrections ADD COLUMN IF NOT EXISTS shipping_refund_regular_tax_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sales_corrections ADD COLUMN IF NOT EXISTS shipping_refund_margin_gross_cents INTEGER NOT NULL DEFAULT 0",
        # sales_correction_lines
        "ALTER TABLE sales_correction_lines ADD COLUMN IF NOT EXISTS shipping_refund_allocated_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sales_correction_lines ADD COLUMN IF NOT EXISTS margin_vat_adjustment_cents INTEGER NOT NULL DEFAULT 0",
        # opex_expenses
        "ALTER TABLE opex_expenses ADD COLUMN IF NOT EXISTS amount_net_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE opex_expenses ADD COLUMN IF NOT EXISTS amount_tax_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE opex_expenses ADD COLUMN IF NOT EXISTS tax_rate_bp INTEGER NOT NULL DEFAULT 2000",
        "ALTER TABLE opex_expenses ADD COLUMN IF NOT EXISTS input_tax_deductible BOOLEAN NOT NULL DEFAULT TRUE",
        # cost_allocations
        "ALTER TABLE cost_allocations ADD COLUMN IF NOT EXISTS amount_net_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE cost_allocations ADD COLUMN IF NOT EXISTS amount_tax_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE cost_allocations ADD COLUMN IF NOT EXISTS tax_rate_bp INTEGER NOT NULL DEFAULT 2000",
        "ALTER TABLE cost_allocations ADD COLUMN IF NOT EXISTS input_tax_deductible BOOLEAN NOT NULL DEFAULT TRUE",
        # cost_allocation_lines
        "ALTER TABLE cost_allocation_lines ADD COLUMN IF NOT EXISTS amount_net_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE cost_allocation_lines ADD COLUMN IF NOT EXISTS amount_tax_cents INTEGER NOT NULL DEFAULT 0",
    ]
    for stmt in stmts:
        await conn.execute(text(stmt))

