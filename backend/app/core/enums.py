from __future__ import annotations

from enum import StrEnum


class InventoryCondition(StrEnum):
    NEW = "NEW"
    LIKE_NEW = "LIKE_NEW"
    GOOD = "GOOD"
    ACCEPTABLE = "ACCEPTABLE"
    DEFECT = "DEFECT"


class PurchaseType(StrEnum):
    DIFF = "DIFF"
    REGULAR = "REGULAR"


class InventoryStatus(StrEnum):
    DRAFT = "DRAFT"
    AVAILABLE = "AVAILABLE"
    FBA_INBOUND = "FBA_INBOUND"
    FBA_WAREHOUSE = "FBA_WAREHOUSE"
    RESERVED = "RESERVED"
    SOLD = "SOLD"
    RETURNED = "RETURNED"
    DISCREPANCY = "DISCREPANCY"
    LOST = "LOST"


class InventoryQueue(StrEnum):
    PHOTOS_MISSING = "PHOTOS_MISSING"
    STORAGE_MISSING = "STORAGE_MISSING"
    AMAZON_STALE = "AMAZON_STALE"
    OLD_STOCK_90D = "OLD_STOCK_90D"


class PurchaseKind(StrEnum):
    PRIVATE_DIFF = "PRIVATE_DIFF"
    COMMERCIAL_REGULAR = "COMMERCIAL_REGULAR"
    PRIVATE_EQUITY = "PRIVATE_EQUITY"


class PaymentSource(StrEnum):
    CASH = "CASH"
    BANK = "BANK"
    PRIVATE_EQUITY = "PRIVATE_EQUITY"


class OrderChannel(StrEnum):
    EBAY = "EBAY"
    AMAZON = "AMAZON"
    WILLHABEN = "WILLHABEN"
    OTHER = "OTHER"


class OrderStatus(StrEnum):
    DRAFT = "DRAFT"
    FINALIZED = "FINALIZED"
    CANCELLED = "CANCELLED"


class CashRecognition(StrEnum):
    AT_FINALIZE = "AT_FINALIZE"
    AT_PAYOUT = "AT_PAYOUT"


class MarketplaceImportKind(StrEnum):
    ORDERS = "ORDERS"
    PAYOUTS = "PAYOUTS"


class MarketplaceStagedOrderStatus(StrEnum):
    READY = "READY"
    NEEDS_ATTENTION = "NEEDS_ATTENTION"
    APPLIED = "APPLIED"


class MarketplaceMatchStrategy(StrEnum):
    ITEM_CODE = "ITEM_CODE"
    MASTER_SKU_FIFO = "MASTER_SKU_FIFO"
    NONE = "NONE"


class FBAShipmentStatus(StrEnum):
    DRAFT = "DRAFT"
    SHIPPED = "SHIPPED"
    RECEIVED = "RECEIVED"


class FBACostDistributionMethod(StrEnum):
    EQUAL = "EQUAL"
    PURCHASE_PRICE_WEIGHTED = "PURCHASE_PRICE_WEIGHTED"


class MileagePurpose(StrEnum):
    BUYING = "BUYING"
    POST = "POST"
    MATERIAL = "MATERIAL"
    OTHER = "OTHER"


class OpexCategory(StrEnum):
    PACKAGING = "PACKAGING"
    POSTAGE = "POSTAGE"
    SOFTWARE = "SOFTWARE"
    OFFICE = "OFFICE"
    CONSULTING = "CONSULTING"
    FEES = "FEES"
    OTHER = "OTHER"


class DocumentType(StrEnum):
    PURCHASE_CREDIT_NOTE = "PURCHASE_CREDIT_NOTE"
    SALES_INVOICE = "SALES_INVOICE"
    SALES_CORRECTION = "SALES_CORRECTION"
    PRIVATE_EQUITY_NOTE = "PRIVATE_EQUITY_NOTE"


class ReturnAction(StrEnum):
    RESTOCK = "RESTOCK"
    WRITE_OFF = "WRITE_OFF"


class MasterProductKind(StrEnum):
    GAME = "GAME"
    CONSOLE = "CONSOLE"
    ACCESSORY = "ACCESSORY"
    OTHER = "OTHER"


class TargetPriceMode(StrEnum):
    AUTO = "AUTO"
    MANUAL = "MANUAL"


class EffectiveTargetPriceSource(StrEnum):
    MANUAL = "MANUAL"
    AUTO_AMAZON = "AUTO_AMAZON"
    AUTO_COST_FLOOR = "AUTO_COST_FLOOR"
    UNPRICED = "UNPRICED"
