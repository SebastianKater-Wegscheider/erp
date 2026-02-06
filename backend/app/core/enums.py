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
    RESERVED = "RESERVED"
    SOLD = "SOLD"
    RETURNED = "RETURNED"
    LOST = "LOST"


class PurchaseKind(StrEnum):
    PRIVATE_DIFF = "PRIVATE_DIFF"
    COMMERCIAL_REGULAR = "COMMERCIAL_REGULAR"


class PaymentSource(StrEnum):
    CASH = "CASH"
    BANK = "BANK"


class OrderChannel(StrEnum):
    EBAY = "EBAY"
    AMAZON = "AMAZON"
    WILLHABEN = "WILLHABEN"
    OTHER = "OTHER"


class OrderStatus(StrEnum):
    DRAFT = "DRAFT"
    FINALIZED = "FINALIZED"
    CANCELLED = "CANCELLED"


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


class ReturnAction(StrEnum):
    RESTOCK = "RESTOCK"
    WRITE_OFF = "WRITE_OFF"


class MasterProductKind(StrEnum):
    GAME = "GAME"
    CONSOLE = "CONSOLE"
    ACCESSORY = "ACCESSORY"
    OTHER = "OTHER"
