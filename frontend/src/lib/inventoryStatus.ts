const INVENTORY_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Entwurf",
  AVAILABLE: "Verfügbar",
  FBA_INBOUND: "FBA Unterwegs",
  FBA_WAREHOUSE: "FBA Lagernd",
  RESERVED: "Reserviert",
  SOLD: "Verkauft",
  RETURNED: "Retourniert",
  DISCREPANCY: "Abweichung",
  LOST: "Verloren",
};

export type InventoryStatusBadgeVariant = "success" | "warning" | "danger" | "secondary" | "outline";

export function inventoryStatusLabel(status: string): string {
  return INVENTORY_STATUS_LABELS[status] ?? status;
}

export function inventoryStatusVariant(status: string): InventoryStatusBadgeVariant {
  switch (status) {
    case "AVAILABLE":
      return "success";
    case "FBA_WAREHOUSE":
      return "success";
    case "FBA_INBOUND":
      return "warning";
    case "RESERVED":
      return "warning";
    case "DISCREPANCY":
      return "danger";
    case "LOST":
      return "danger";
    case "SOLD":
      return "secondary";
    case "RETURNED":
      return "outline";
    case "DRAFT":
    default:
      return "secondary";
  }
}
