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
        "ALTER TABLE purchases ADD COLUMN IF NOT EXISTS shipping_cost_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE purchases ADD COLUMN IF NOT EXISTS buyer_protection_fee_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE purchases ADD COLUMN IF NOT EXISTS counterparty_birthdate DATE",
        "ALTER TABLE purchases ADD COLUMN IF NOT EXISTS counterparty_id_number VARCHAR(80)",
        "ALTER TABLE purchases ADD COLUMN IF NOT EXISTS source_platform VARCHAR(120)",
        "ALTER TABLE purchases ADD COLUMN IF NOT EXISTS listing_url VARCHAR(1000)",
        "ALTER TABLE purchases ADD COLUMN IF NOT EXISTS notes TEXT",
        # purchase_lines
        "ALTER TABLE purchase_lines ADD COLUMN IF NOT EXISTS shipping_allocated_cents INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE purchase_lines ADD COLUMN IF NOT EXISTS buyer_protection_fee_allocated_cents INTEGER NOT NULL DEFAULT 0",
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
        # mileage_logs
        "ALTER TABLE mileage_logs ADD COLUMN IF NOT EXISTS purpose_text VARCHAR(300)",
    ]
    for stmt in stmts:
        await conn.execute(text(stmt))

    # enum upgrades
    await conn.execute(text("ALTER TYPE inventory_status ADD VALUE IF NOT EXISTS 'FBA_INBOUND'"))
    await conn.execute(text("ALTER TYPE inventory_status ADD VALUE IF NOT EXISTS 'FBA_WAREHOUSE'"))
    await conn.execute(text("ALTER TYPE inventory_status ADD VALUE IF NOT EXISTS 'DISCREPANCY'"))
    await conn.execute(
        text(
            "DO $$ BEGIN "
            "CREATE TYPE fba_shipment_status AS ENUM ('DRAFT', 'SHIPPED', 'RECEIVED'); "
            "EXCEPTION WHEN duplicate_object THEN NULL; "
            "END $$"
        )
    )
    await conn.execute(
        text(
            "DO $$ BEGIN "
            "CREATE TYPE fba_cost_distribution_method AS ENUM ('EQUAL', 'PURCHASE_PRICE_WEIGHTED'); "
            "EXCEPTION WHEN duplicate_object THEN NULL; "
            "END $$"
        )
    )

    # mileage_log_purchases (join table)
    await conn.execute(
        text(
            "CREATE TABLE IF NOT EXISTS mileage_log_purchases ("
            "mileage_log_id UUID NOT NULL REFERENCES mileage_logs(id) ON DELETE CASCADE, "
            "purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE, "
            "PRIMARY KEY (mileage_log_id, purchase_id)"
            ")"
        )
    )
    await conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_mileage_log_purchases_purchase_id "
            "ON mileage_log_purchases (purchase_id)"
        )
    )
    # Migrate legacy single-link data.
    await conn.execute(
        text(
            "INSERT INTO mileage_log_purchases (mileage_log_id, purchase_id) "
            "SELECT id, purchase_id FROM mileage_logs WHERE purchase_id IS NOT NULL "
            "ON CONFLICT DO NOTHING"
        )
    )

    # bank_transaction_purchases (join table)
    await conn.execute(
        text(
            "CREATE TABLE IF NOT EXISTS bank_transaction_purchases ("
            "bank_transaction_id UUID NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE, "
            "purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE, "
            "PRIMARY KEY (bank_transaction_id, purchase_id)"
            ")"
        )
    )
    await conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_bank_transaction_purchases_purchase_id "
            "ON bank_transaction_purchases (purchase_id)"
        )
    )
    await conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_bank_transaction_purchases_bank_transaction_id "
            "ON bank_transaction_purchases (bank_transaction_id)"
        )
    )

    # purchase_attachments
    await conn.execute(
        text(
            "CREATE TABLE IF NOT EXISTS purchase_attachments ("
            "id UUID PRIMARY KEY, "
            "purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE, "
            "upload_path VARCHAR(500) NOT NULL, "
            "original_filename VARCHAR(300) NOT NULL, "
            "kind VARCHAR(40) NOT NULL DEFAULT 'OTHER', "
            "note TEXT, "
            "created_at TIMESTAMPTZ NOT NULL DEFAULT now(), "
            "updated_at TIMESTAMPTZ NOT NULL DEFAULT now()"
            ")"
        )
    )
    await conn.execute(text("ALTER TABLE purchase_attachments ADD COLUMN IF NOT EXISTS original_filename VARCHAR(300)"))
    await conn.execute(text("ALTER TABLE purchase_attachments ADD COLUMN IF NOT EXISTS kind VARCHAR(40) NOT NULL DEFAULT 'OTHER'"))
    await conn.execute(text("ALTER TABLE purchase_attachments ADD COLUMN IF NOT EXISTS note TEXT"))
    await conn.execute(
        text(
            "ALTER TABLE purchase_attachments DROP CONSTRAINT IF EXISTS uq_purchase_attachment_path"
        )
    )
    await conn.execute(
        text(
            "ALTER TABLE purchase_attachments "
            "ADD CONSTRAINT uq_purchase_attachment_path UNIQUE (purchase_id, upload_path)"
        )
    )
    await conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_purchase_attachments_purchase_id "
            "ON purchase_attachments (purchase_id)"
        )
    )

    # fba_shipments
    await conn.execute(
        text(
            "CREATE TABLE IF NOT EXISTS fba_shipments ("
            "id UUID PRIMARY KEY, "
            "name VARCHAR(180) NOT NULL, "
            "status fba_shipment_status NOT NULL DEFAULT 'DRAFT', "
            "carrier VARCHAR(80), "
            "tracking_number VARCHAR(120), "
            "shipping_cost_cents INTEGER NOT NULL DEFAULT 0, "
            "cost_distribution_method fba_cost_distribution_method NOT NULL DEFAULT 'EQUAL', "
            "shipped_at TIMESTAMPTZ, "
            "received_at TIMESTAMPTZ, "
            "created_at TIMESTAMPTZ NOT NULL DEFAULT now(), "
            "updated_at TIMESTAMPTZ NOT NULL DEFAULT now()"
            ")"
        )
    )
    await conn.execute(text("ALTER TABLE fba_shipments ADD COLUMN IF NOT EXISTS name VARCHAR(180)"))
    await conn.execute(text("ALTER TABLE fba_shipments ADD COLUMN IF NOT EXISTS status fba_shipment_status NOT NULL DEFAULT 'DRAFT'"))
    await conn.execute(text("ALTER TABLE fba_shipments ADD COLUMN IF NOT EXISTS carrier VARCHAR(80)"))
    await conn.execute(text("ALTER TABLE fba_shipments ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(120)"))
    await conn.execute(text("ALTER TABLE fba_shipments ADD COLUMN IF NOT EXISTS shipping_cost_cents INTEGER NOT NULL DEFAULT 0"))
    await conn.execute(
        text(
            "ALTER TABLE fba_shipments ADD COLUMN IF NOT EXISTS "
            "cost_distribution_method fba_cost_distribution_method NOT NULL DEFAULT 'EQUAL'"
        )
    )
    await conn.execute(text("ALTER TABLE fba_shipments ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ"))
    await conn.execute(text("ALTER TABLE fba_shipments ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ"))
    await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_fba_shipments_status ON fba_shipments (status)"))

    # fba_shipment_items
    await conn.execute(
        text(
            "CREATE TABLE IF NOT EXISTS fba_shipment_items ("
            "id UUID PRIMARY KEY, "
            "shipment_id UUID NOT NULL REFERENCES fba_shipments(id) ON DELETE CASCADE, "
            "inventory_item_id UUID NOT NULL REFERENCES inventory_items(id), "
            "allocated_shipping_cost_cents INTEGER NOT NULL DEFAULT 0, "
            "received_status inventory_status, "
            "discrepancy_note TEXT, "
            "CONSTRAINT uq_fba_shipment_item UNIQUE (shipment_id, inventory_item_id)"
            ")"
        )
    )
    await conn.execute(
        text("ALTER TABLE fba_shipment_items ADD COLUMN IF NOT EXISTS allocated_shipping_cost_cents INTEGER NOT NULL DEFAULT 0")
    )
    await conn.execute(text("ALTER TABLE fba_shipment_items ADD COLUMN IF NOT EXISTS received_status inventory_status"))
    await conn.execute(text("ALTER TABLE fba_shipment_items ADD COLUMN IF NOT EXISTS discrepancy_note TEXT"))
    await conn.execute(
        text(
            "ALTER TABLE fba_shipment_items DROP CONSTRAINT IF EXISTS uq_fba_shipment_item"
        )
    )
    await conn.execute(
        text(
            "ALTER TABLE fba_shipment_items "
            "ADD CONSTRAINT uq_fba_shipment_item UNIQUE (shipment_id, inventory_item_id)"
        )
    )
    await conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_fba_shipment_items_inventory_item_id "
            "ON fba_shipment_items (inventory_item_id)"
        )
    )

    # Helpful indexes for transaction listing/sync.
    await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_bank_transactions_booked_date ON bank_transactions (booked_date)"))
    await conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_bank_transactions_account_booked_date "
            "ON bank_transactions (bank_account_id, booked_date)"
        )
    )

    # inventory_items
    await conn.execute(text("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS serial_number VARCHAR(120)"))

    # master_products
    await conn.execute(text("ALTER TABLE master_products ADD COLUMN IF NOT EXISTS sku VARCHAR(32)"))
    await conn.execute(text("ALTER TABLE master_products ADD COLUMN IF NOT EXISTS asin VARCHAR(32)"))
    await conn.execute(text("ALTER TABLE master_products ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'GAME'"))
    await conn.execute(text("ALTER TABLE master_products ADD COLUMN IF NOT EXISTS variant VARCHAR(80) NOT NULL DEFAULT ''"))
    await conn.execute(text("ALTER TABLE master_products ADD COLUMN IF NOT EXISTS manufacturer VARCHAR(80)"))
    await conn.execute(text("ALTER TABLE master_products ADD COLUMN IF NOT EXISTS model VARCHAR(80)"))

    # Fill missing SKUs deterministically from UUID and lock it down.
    await conn.execute(
        text(
            "UPDATE master_products "
            "SET sku = 'MP-' || upper(substring(replace(id::text, '-', '') from 1 for 12)) "
            "WHERE sku IS NULL OR sku = ''"
        )
    )
    await conn.execute(text("ALTER TABLE master_products ALTER COLUMN sku SET NOT NULL"))
    await conn.execute(text("ALTER TABLE master_products DROP CONSTRAINT IF EXISTS uq_master_product_sku"))
    await conn.execute(text("ALTER TABLE master_products ADD CONSTRAINT uq_master_product_sku UNIQUE (sku)"))

    # Allow multiple variants (e.g. different colors) for the same title/platform/region.
    await conn.execute(text("ALTER TABLE master_products DROP CONSTRAINT IF EXISTS uq_master_product_identity"))
    await conn.execute(
        text(
            "ALTER TABLE master_products "
            "ADD CONSTRAINT uq_master_product_identity UNIQUE (kind, title, platform, region, variant)"
        )
    )
