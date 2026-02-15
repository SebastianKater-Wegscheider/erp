from __future__ import annotations

from sqlalchemy import Enum

from app.core.enums import (
    FBACostDistributionMethod,
    FBAShipmentStatus,
    DocumentType,
    InventoryCondition,
    InventoryStatus,
    MileagePurpose,
    MarketplaceImportKind,
    MarketplaceMatchStrategy,
    MarketplaceStagedOrderStatus,
    OpexCategory,
    OrderChannel,
    OrderStatus,
    CashRecognition,
    PaymentSource,
    PurchaseKind,
    PurchaseType,
    ReturnAction,
)

inventory_condition_enum = Enum(InventoryCondition, name="inventory_condition")
purchase_type_enum = Enum(PurchaseType, name="purchase_type")
inventory_status_enum = Enum(InventoryStatus, name="inventory_status")
fba_shipment_status_enum = Enum(FBAShipmentStatus, name="fba_shipment_status")
fba_cost_distribution_method_enum = Enum(FBACostDistributionMethod, name="fba_cost_distribution_method")

purchase_kind_enum = Enum(PurchaseKind, name="purchase_kind")
payment_source_enum = Enum(PaymentSource, name="payment_source")

order_channel_enum = Enum(OrderChannel, name="order_channel")
order_status_enum = Enum(OrderStatus, name="order_status")
cash_recognition_enum = Enum(CashRecognition, name="cash_recognition")

mileage_purpose_enum = Enum(MileagePurpose, name="mileage_purpose")
opex_category_enum = Enum(OpexCategory, name="opex_category")

document_type_enum = Enum(DocumentType, name="document_type")

return_action_enum = Enum(ReturnAction, name="return_action")

marketplace_import_kind_enum = Enum(MarketplaceImportKind, name="marketplace_import_kind")
marketplace_staged_order_status_enum = Enum(MarketplaceStagedOrderStatus, name="marketplace_staged_order_status")
marketplace_match_strategy_enum = Enum(MarketplaceMatchStrategy, name="marketplace_match_strategy")
