from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.v1.endpoints import (
    bank,
    cost_allocations,
    fba_shipments,
    files,
    inventory,
    master_products,
    mileage,
    opex,
    purchases,
    reports,
    sales,
    uploads,
)
from app.core.security import require_basic_auth


api_router = APIRouter(dependencies=[Depends(require_basic_auth)])

api_router.include_router(uploads.router, prefix="/uploads", tags=["uploads"])
api_router.include_router(files.router, prefix="/files", tags=["files"])

api_router.include_router(master_products.router, prefix="/master-products", tags=["master-products"])
api_router.include_router(inventory.router, prefix="/inventory", tags=["inventory"])
api_router.include_router(fba_shipments.router, prefix="/fba-shipments", tags=["fba-shipments"])

api_router.include_router(purchases.router, prefix="/purchases", tags=["purchases"])
api_router.include_router(cost_allocations.router, prefix="/cost-allocations", tags=["cost-allocations"])
api_router.include_router(opex.router, prefix="/opex", tags=["opex"])
api_router.include_router(mileage.router, prefix="/mileage", tags=["mileage"])

api_router.include_router(sales.router, prefix="/sales", tags=["sales"])
api_router.include_router(reports.router, prefix="/reports", tags=["reports"])

api_router.include_router(bank.router, prefix="/bank", tags=["bank"])
