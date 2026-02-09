from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

# Script entrypoint: ensure `backend/` is importable.
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.enums import (  # noqa: E402
    FBACostDistributionMethod,
    FBAShipmentStatus,
    DocumentType,
    InventoryCondition,
    InventoryStatus,
    MileagePurpose,
    OpexCategory,
    OrderChannel,
    OrderStatus,
    PaymentSource,
    PurchaseKind,
    PurchaseType,
    ReturnAction,
)


EXPECTED_ENUMS: dict[str, list[str]] = {
    "inventory_condition": [e.value for e in InventoryCondition],
    "purchase_type": [e.value for e in PurchaseType],
    "inventory_status": [e.value for e in InventoryStatus],
    "fba_shipment_status": [e.value for e in FBAShipmentStatus],
    "fba_cost_distribution_method": [e.value for e in FBACostDistributionMethod],
    "purchase_kind": [e.value for e in PurchaseKind],
    "payment_source": [e.value for e in PaymentSource],
    "order_channel": [e.value for e in OrderChannel],
    "order_status": [e.value for e in OrderStatus],
    "mileage_purpose": [e.value for e in MileagePurpose],
    "opex_category": [e.value for e in OpexCategory],
    "document_type": [e.value for e in DocumentType],
    "return_action": [e.value for e in ReturnAction],
}


async def _main() -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL is required.", file=sys.stderr)
        return 2

    engine = create_async_engine(url, pool_pre_ping=True)
    try:
        async with engine.connect() as conn:
            for type_name, expected in EXPECTED_ENUMS.items():
                rows = (
                    await conn.execute(
                        text(
                            """
                            SELECT e.enumlabel
                            FROM pg_enum e
                            JOIN pg_type t ON t.oid = e.enumtypid
                            JOIN pg_namespace n ON n.oid = t.typnamespace
                            WHERE n.nspname = 'public' AND t.typname = :type_name
                            ORDER BY e.enumsortorder
                            """
                        ),
                        {"type_name": type_name},
                    )
                ).all()
                actual = [r[0] for r in rows]

                missing = [v for v in expected if v not in actual]
                if missing:
                    print(f"Enum type '{type_name}' is missing values: {missing}", file=sys.stderr)
                    print(f"Expected: {expected}", file=sys.stderr)
                    print(f"Actual:   {actual}", file=sys.stderr)
                    return 1
    finally:
        await engine.dispose()

    print("DB invariants ok (enums contain expected values).")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))

