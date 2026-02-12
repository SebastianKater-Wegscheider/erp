import { Check, PackageCheck, PackageOpen, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { formatEur, parseEurToCents } from "../lib/money";
import { paginateItems } from "../lib/pagination";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { InlineMessage } from "../components/ui/inline-message";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PaginationControls } from "../components/ui/pagination-controls";
import { PageHeader } from "../components/ui/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { SearchField } from "../components/ui/search-field";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { TABLE_CELL_NUMERIC_CLASS, TABLE_ROW_COMPACT_CLASS } from "../components/ui/table-row-layout";

type InventoryItem = {
  id: string;
  master_product_id: string;
  purchase_price_cents: number;
  status: string;
};

type MasterProduct = {
  id: string;
  sku?: string;
  title: string;
  platform: string;
  region: string;
  variant?: string;
};

type ShipmentItem = {
  id: string;
  inventory_item_id: string;
  allocated_shipping_cost_cents: number;
  received_status?: string | null;
  discrepancy_note?: string | null;
};

type ShipmentOut = {
  id: string;
  name: string;
  status: string;
  carrier?: string | null;
  tracking_number?: string | null;
  shipping_cost_cents: number;
  cost_distribution_method: string;
  shipped_at?: string | null;
  received_at?: string | null;
  created_at: string;
  updated_at: string;
  items: ShipmentItem[];
};

type ReceiveState = {
  status: "RECEIVED" | "LOST" | "DISCREPANCY";
  note: string;
};

const SHIPMENT_STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "DRAFT", label: "Entwurf" },
  { value: "SHIPPED", label: "Versendet" },
  { value: "RECEIVED", label: "Empfangen" },
];

const DISTRIBUTION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "EQUAL", label: "Gleichmäßig" },
  { value: "PURCHASE_PRICE_WEIGHTED", label: "Gewichtet (EK)" },
];

const INVENTORY_STATUS_LABEL: Record<string, string> = {
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

function optionLabel(options: Array<{ value: string; label: string }>, value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

function statusBadgeVariant(status: string) {
  if (status === "DRAFT") return "secondary" as const;
  if (status === "SHIPPED") return "warning" as const;
  if (status === "RECEIVED") return "success" as const;
  return "secondary" as const;
}

function inventoryStatusLabel(status: string): string {
  return INVENTORY_STATUS_LABEL[status] ?? status;
}

function productLabel(mp?: MasterProduct) {
  if (!mp) return "Unbekanntes Produkt";
  return `${mp.title} · ${mp.platform} · ${mp.region}${mp.variant ? ` · ${mp.variant}` : ""}`;
}

export function FBAShipmentsPage() {
  const api = useApi();
  const qc = useQueryClient();

  const [searchShipment, setSearchShipment] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [shippingCost, setShippingCost] = useState("0,00");
  const [distributionMethod, setDistributionMethod] = useState("EQUAL");
  const [carrier, setCarrier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [searchInventory, setSearchInventory] = useState("");
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [page, setPage] = useState(1);

  const [receiveShipmentId, setReceiveShipmentId] = useState<string | null>(null);
  const [receiveStateByItemId, setReceiveStateByItemId] = useState<Record<string, ReceiveState>>({});

  const shipments = useQuery({
    queryKey: ["fba-shipments"],
    queryFn: () => api.request<ShipmentOut[]>("/fba-shipments"),
  });

  const master = useQuery({
    queryKey: ["master-products"],
    queryFn: () => api.request<MasterProduct[]>("/master-products"),
  });

  const availableInventory = useQuery({
    queryKey: ["fba-available-inventory", searchInventory],
    enabled: formOpen,
    queryFn: () =>
      api.request<InventoryItem[]>(
        `/inventory?status=AVAILABLE&limit=100&offset=0${searchInventory.trim() ? `&q=${encodeURIComponent(searchInventory.trim())}` : ""}`,
      ),
  });

  const mpById = useMemo(() => new Map((master.data ?? []).map((m) => [m.id, m])), [master.data]);

  const listRows = useMemo(() => {
    const q = searchShipment.trim().toLowerCase();
    const all = shipments.data ?? [];
    if (!q) return all;
    return all.filter((s) => `${s.name} ${s.carrier ?? ""} ${s.tracking_number ?? ""}`.toLowerCase().includes(q));
  }, [shipments.data, searchShipment]);
  const totalShipmentCount = shipments.data?.length ?? 0;
  const pagedShipments = useMemo(() => paginateItems(listRows, page), [listRows, page]);

  const shipmentById = useMemo(() => new Map((shipments.data ?? []).map((s) => [s.id, s])), [shipments.data]);
  const editingShipment = editingId ? shipmentById.get(editingId) ?? null : null;
  const receivingShipment = receiveShipmentId ? shipmentById.get(receiveShipmentId) ?? null : null;

  useEffect(() => {
    setPage(1);
  }, [searchShipment]);

  useEffect(() => {
    if (page !== pagedShipments.page) setPage(pagedShipments.page);
  }, [page, pagedShipments.page]);

  const inventoryRows = availableInventory.data ?? [];
  const selectedInventoryRows = useMemo(() => {
    const map = new Map(inventoryRows.map((i) => [i.id, i]));
    const fromShipment = (editingShipment?.items ?? [])
      .map((line) => map.get(line.inventory_item_id) ?? ({
        id: line.inventory_item_id,
        master_product_id: "",
        purchase_price_cents: 0,
        status: "AVAILABLE",
      } as InventoryItem));

    const rows = selectedItemIds.map((id) => map.get(id) ?? fromShipment.find((x) => x.id === id)).filter(Boolean) as InventoryItem[];
    return rows;
  }, [inventoryRows, selectedItemIds, editingShipment?.items]);

  const saveDraft = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        item_ids: selectedItemIds,
        shipping_cost_cents: parseEurToCents(shippingCost),
        cost_distribution_method: distributionMethod,
        carrier: carrier.trim() ? carrier.trim() : null,
        tracking_number: trackingNumber.trim() ? trackingNumber.trim() : null,
      };
      if (editingId) {
        return api.request<ShipmentOut>(`/fba-shipments/${editingId}`, { method: "PATCH", json: payload });
      }
      return api.request<ShipmentOut>("/fba-shipments", { method: "POST", json: payload });
    },
    onSuccess: async () => {
      closeForm();
      await qc.invalidateQueries({ queryKey: ["fba-shipments"] });
      await qc.invalidateQueries({ queryKey: ["fba-available-inventory"] });
      await qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });

  const markShipped = useMutation({
    mutationFn: (shipmentId: string) => api.request<ShipmentOut>(`/fba-shipments/${shipmentId}/ship`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["fba-shipments"] });
      await qc.invalidateQueries({ queryKey: ["fba-available-inventory"] });
      await qc.invalidateQueries({ queryKey: ["inventory"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const markReceived = useMutation({
    mutationFn: (shipmentId: string) => {
      const discrepancies = Object.entries(receiveStateByItemId)
        .filter(([, state]) => state.status !== "RECEIVED")
        .map(([inventory_item_id, state]) => ({
          inventory_item_id,
          status: state.status,
          note: state.note.trim() ? state.note.trim() : null,
        }));
      return api.request<ShipmentOut>(`/fba-shipments/${shipmentId}/receive`, {
        method: "POST",
        json: { discrepancies },
      });
    },
    onSuccess: async () => {
      setReceiveShipmentId(null);
      setReceiveStateByItemId({});
      await qc.invalidateQueries({ queryKey: ["fba-shipments"] });
      await qc.invalidateQueries({ queryKey: ["inventory"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  function openCreate() {
    setEditingId(null);
    setName("");
    setShippingCost("0,00");
    setDistributionMethod("EQUAL");
    setCarrier("");
    setTrackingNumber("");
    setSelectedItemIds([]);
    setSearchInventory("");
    saveDraft.reset();
    setFormOpen(true);
  }

  function openEdit(shipment: ShipmentOut) {
    setEditingId(shipment.id);
    setName(shipment.name);
    setShippingCost(formatEur(shipment.shipping_cost_cents));
    setDistributionMethod(shipment.cost_distribution_method);
    setCarrier(shipment.carrier ?? "");
    setTrackingNumber(shipment.tracking_number ?? "");
    setSelectedItemIds(shipment.items.map((line) => line.inventory_item_id));
    setSearchInventory("");
    saveDraft.reset();
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
    saveDraft.reset();
  }

  function openReceiveDialog(shipment: ShipmentOut) {
    const initial: Record<string, ReceiveState> = {};
    shipment.items.forEach((line) => {
      initial[line.inventory_item_id] = { status: "RECEIVED", note: "" };
    });
    setReceiveShipmentId(shipment.id);
    setReceiveStateByItemId(initial);
    markReceived.reset();
  }

  function toggleItem(inventoryItemId: string) {
    setSelectedItemIds((prev) => {
      if (prev.includes(inventoryItemId)) return prev.filter((id) => id !== inventoryItemId);
      return [...prev, inventoryItemId];
    });
  }

  const canSaveDraft = name.trim().length > 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="FBA Sendungen"
        description="Inbound-Sendungen an Amazon verwalten, Versandkosten umlegen und Empfang abgleichen."
        actions={
          <>
            <Button className="w-full sm:w-auto" variant="secondary" onClick={() => shipments.refetch()} disabled={shipments.isFetching}>
              <RefreshCw className="h-4 w-4" />
              Aktualisieren
            </Button>
            <Button className="w-full sm:w-auto" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Sendung erstellen
            </Button>
          </>
        }
        actionsClassName="w-full sm:w-auto"
      />

      <Card>
        <CardHeader>
          <CardTitle>Sendungen</CardTitle>
          <CardDescription>
            {shipments.isPending ? "Lade…" : `${listRows.length}${listRows.length !== totalShipmentCount ? ` / ${totalShipmentCount}` : ""} Einträge`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <SearchField
            value={searchShipment}
            onValueChange={setSearchShipment}
            placeholder="Suchen (Name, Carrier, Tracking)"
          />

          {shipments.isError && (
            <InlineMessage tone="error">
              {(shipments.error as Error).message}
            </InlineMessage>
          )}

          <div className="md:hidden space-y-2">
            {pagedShipments.items.map((s) => (
              <div
                key={s.id}
                className="rounded-md border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-gray-900 dark:text-gray-100">{s.name}</div>
                    <div className="mt-1 font-mono text-xs text-gray-500 dark:text-gray-400">{s.id}</div>
                  </div>
                  <Badge variant={statusBadgeVariant(s.status)}>{optionLabel(SHIPMENT_STATUS_OPTIONS, s.status)}</Badge>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div className="text-gray-600 dark:text-gray-300">
                    Artikel: <span className="font-medium text-gray-900 dark:text-gray-100">{s.items.length}</span>
                  </div>
                  <div className="text-right text-gray-600 dark:text-gray-300">
                    Versand: <span className="font-medium text-gray-900 dark:text-gray-100">{formatEur(s.shipping_cost_cents)} €</span>
                  </div>
                </div>

                <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  <div className="truncate">{s.carrier || "-"}</div>
                  <div className="truncate font-mono">{s.tracking_number || "-"}</div>
                </div>

                <div className="mt-3">
                  {s.status === "DRAFT" && (
                    <div className="grid grid-cols-2 gap-2">
                      <Button type="button" size="sm" className="w-full" variant="secondary" onClick={() => openEdit(s)}>
                        <PackageOpen className="h-4 w-4" />
                        Bearbeiten
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="w-full"
                        onClick={() => markShipped.mutate(s.id)}
                        disabled={markShipped.isPending}
                        variant="default"
                      >
                        <PackageCheck className="h-4 w-4" />
                        Versenden
                      </Button>
                    </div>
                  )}
                  {s.status === "SHIPPED" && (
                    <Button type="button" size="sm" className="w-full" onClick={() => openReceiveDialog(s)} disabled={markReceived.isPending}>
                      <Check className="h-4 w-4" />
                      Empfang buchen
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {!listRows.length && (
              <div className="rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
                Keine Sendungen vorhanden.
              </div>
            )}
          </div>

          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Artikel</TableHead>
                  <TableHead>Versandkosten</TableHead>
                  <TableHead>Tracking</TableHead>
                  <TableHead className="text-right">Aktionen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedShipments.items.map((s) => (
                  <TableRow key={s.id} className={TABLE_ROW_COMPACT_CLASS}>
                    <TableCell>
                      <div className="font-medium">{s.name}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{s.id}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusBadgeVariant(s.status)}>{optionLabel(SHIPMENT_STATUS_OPTIONS, s.status)}</Badge>
                    </TableCell>
                    <TableCell>{s.items.length}</TableCell>
                    <TableCell className={TABLE_CELL_NUMERIC_CLASS}>{formatEur(s.shipping_cost_cents)} €</TableCell>
                    <TableCell>
                      <div className="text-sm">{s.carrier || "-"}</div>
                      <div className="font-mono text-xs text-gray-500 dark:text-gray-400">{s.tracking_number || "-"}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-2">
                        {s.status === "DRAFT" && (
                          <>
                            <Button size="sm" variant="secondary" onClick={() => openEdit(s)}>
                              <PackageOpen className="h-4 w-4" />
                              Bearbeiten
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => markShipped.mutate(s.id)}
                              disabled={markShipped.isPending}
                              variant="default"
                            >
                              <PackageCheck className="h-4 w-4" />
                              Versenden
                            </Button>
                          </>
                        )}
                        {s.status === "SHIPPED" && (
                          <Button size="sm" onClick={() => openReceiveDialog(s)} disabled={markReceived.isPending}>
                            <Check className="h-4 w-4" />
                            Empfang buchen
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {!listRows.length && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-sm text-gray-500 dark:text-gray-400">
                      Keine Sendungen vorhanden.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <PaginationControls
            page={pagedShipments.page}
            totalPages={pagedShipments.totalPages}
            totalItems={pagedShipments.totalItems}
            pageSize={pagedShipments.pageSize}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>

      {formOpen && (
        <Card>
          <CardHeader>
            <CardTitle>{editingId ? "Sendung bearbeiten" : "Neue Sendung"}</CardTitle>
            <CardDescription>
              Entwurf pflegen, Artikel auswählen und Versandkosten für die spätere Umlage hinterlegen.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Name / Referenz</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. FBA-2026-02-08_Konsole" />
              </div>
              <div className="space-y-2">
                <Label>Versandkosten (gesamt)</Label>
                <Input value={shippingCost} onChange={(e) => setShippingCost(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Verteilung</Label>
                <Select value={distributionMethod} onValueChange={setDistributionMethod}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DISTRIBUTION_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Versanddienstleister</Label>
                <Input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="z. B. DHL" />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Trackingnummer</Label>
                <Input value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} placeholder="Optional" />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Verfügbare Artikel hinzufügen (Status = AVAILABLE)</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
                <Input
                  placeholder="Suche nach Titel, SKU, EAN, ASIN …"
                  value={searchInventory}
                  onChange={(e) => setSearchInventory(e.target.value)}
                  className="pl-9"
                />
              </div>
              <div className="max-h-56 overflow-auto rounded-md border border-gray-200 dark:border-gray-800">
                <div className="md:hidden divide-y divide-gray-200 dark:divide-gray-800">
                  {inventoryRows.map((it) => {
                    const selected = selectedItemIds.includes(it.id);
                    const mp = mpById.get(it.master_product_id);
                    return (
                      <div key={it.id} className="flex items-start justify-between gap-3 p-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{productLabel(mp)}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                            <span className="font-mono">{it.id}</span>
                            <span>EK: {formatEur(it.purchase_price_cents)} €</span>
                          </div>
                        </div>
                        <Button type="button" size="sm" className="shrink-0" variant={selected ? "secondary" : "outline"} onClick={() => toggleItem(it.id)}>
                          {selected ? "Entfernen" : "Hinzufügen"}
                        </Button>
                      </div>
                    );
                  })}
                  {!inventoryRows.length && (
                    <div className="p-3 text-sm text-gray-500 dark:text-gray-400">
                      Keine passenden verfügbaren Artikel.
                    </div>
                  )}
                </div>

                <div className="hidden md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>ID</TableHead>
                        <TableHead>Produkt</TableHead>
                        <TableHead className="text-right">EK</TableHead>
                        <TableHead className="text-right">Aktion</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {inventoryRows.map((it) => {
                        const selected = selectedItemIds.includes(it.id);
                        const mp = mpById.get(it.master_product_id);
                        return (
                          <TableRow key={it.id} className={TABLE_ROW_COMPACT_CLASS}>
                            <TableCell className="font-mono text-xs">{it.id}</TableCell>
                            <TableCell className="max-w-[28rem] truncate">{productLabel(mp)}</TableCell>
                            <TableCell className={TABLE_CELL_NUMERIC_CLASS}>{formatEur(it.purchase_price_cents)} €</TableCell>
                            <TableCell className="text-right">
                              <Button type="button" size="sm" variant={selected ? "secondary" : "outline"} onClick={() => toggleItem(it.id)}>
                                {selected ? "Entfernen" : "Hinzufügen"}
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                      {!inventoryRows.length && (
                        <TableRow>
                          <TableCell colSpan={4} className="text-sm text-gray-500 dark:text-gray-400">
                            Keine passenden verfügbaren Artikel.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Ausgewählte Artikel ({selectedItemIds.length})</Label>
              <div className="max-h-56 overflow-auto rounded-md border border-gray-200 dark:border-gray-800">
                <div className="md:hidden divide-y divide-gray-200 dark:divide-gray-800">
                  {selectedInventoryRows.map((it) => {
                    const mp = mpById.get(it.master_product_id);
                    return (
                      <div key={it.id} className="flex items-start justify-between gap-3 p-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{productLabel(mp)}</div>
                          <div className="mt-1 font-mono text-xs text-gray-500 dark:text-gray-400">{it.id}</div>
                        </div>
                        <Button type="button" size="sm" className="shrink-0" variant="outline" onClick={() => toggleItem(it.id)}>
                          Entfernen
                        </Button>
                      </div>
                    );
                  })}
                  {!selectedInventoryRows.length && (
                    <div className="p-3 text-sm text-gray-500 dark:text-gray-400">
                      Noch keine Artikel zugeordnet.
                    </div>
                  )}
                </div>

                <div className="hidden md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>ID</TableHead>
                        <TableHead>Produkt</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedInventoryRows.map((it) => {
                        const mp = mpById.get(it.master_product_id);
                        return (
                          <TableRow key={it.id} className={TABLE_ROW_COMPACT_CLASS}>
                            <TableCell className="font-mono text-xs">{it.id}</TableCell>
                            <TableCell>{productLabel(mp)}</TableCell>
                          </TableRow>
                        );
                      })}
                      {!selectedInventoryRows.length && (
                        <TableRow>
                          <TableCell colSpan={2} className="text-sm text-gray-500 dark:text-gray-400">
                            Noch keine Artikel zugeordnet.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>

            {saveDraft.isError && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                {(saveDraft.error as Error).message}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end">
              <Button className="w-full sm:w-auto" type="button" variant="secondary" onClick={closeForm}>
                Schließen
              </Button>
              <Button className="w-full sm:w-auto" type="button" onClick={() => saveDraft.mutate()} disabled={!canSaveDraft || saveDraft.isPending}>
                {editingId ? "Änderungen speichern" : "Sendung erstellen"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!receivingShipment} onOpenChange={(open) => !open && setReceiveShipmentId(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Sendung empfangen</DialogTitle>
            <DialogDescription>
              Soll/Ist-Abgleich erfassen. Standard ist "Empfangen"; fehlende Artikel können als "Abweichung" oder "Verloren" markiert werden.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[55vh] overflow-auto rounded-md border border-gray-200 dark:border-gray-800">
            <div className="md:hidden divide-y divide-gray-200 dark:divide-gray-800">
              {(receivingShipment?.items ?? []).map((line) => {
                const state = receiveStateByItemId[line.inventory_item_id] ?? { status: "RECEIVED", note: "" };
                return (
                  <div key={line.id} className="space-y-2 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs text-gray-500 dark:text-gray-400">Artikel-ID</div>
                        <div className="truncate font-mono text-xs text-gray-700 dark:text-gray-300">{line.inventory_item_id}</div>
                      </div>
                      <Badge variant="warning">{inventoryStatusLabel("FBA_INBOUND")}</Badge>
                    </div>

                    <div className="grid gap-2">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Status bei Empfang</div>
                        <Select
                          value={state.status}
                          onValueChange={(value) =>
                            setReceiveStateByItemId((prev) => ({
                              ...prev,
                              [line.inventory_item_id]: {
                                ...(prev[line.inventory_item_id] ?? { note: "" }),
                                status: value as ReceiveState["status"],
                              },
                            }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="RECEIVED">Empfangen (FBA Lagernd)</SelectItem>
                            <SelectItem value="DISCREPANCY">Abweichung</SelectItem>
                            <SelectItem value="LOST">Verloren</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Notiz</div>
                        <Input
                          value={state.note}
                          onChange={(e) =>
                            setReceiveStateByItemId((prev) => ({
                              ...prev,
                              [line.inventory_item_id]: { ...(prev[line.inventory_item_id] ?? { status: "RECEIVED" }), note: e.target.value },
                            }))
                          }
                          placeholder="Optional (z. B. Fall-ID / Amazon Ticket)"
                          disabled={state.status === "RECEIVED"}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Aktueller Status</TableHead>
                    <TableHead>Status bei Empfang</TableHead>
                    <TableHead>Notiz</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(receivingShipment?.items ?? []).map((line) => {
                    const state = receiveStateByItemId[line.inventory_item_id] ?? { status: "RECEIVED", note: "" };
                    return (
                      <TableRow key={line.id} className={TABLE_ROW_COMPACT_CLASS}>
                        <TableCell className="font-mono text-xs">{line.inventory_item_id}</TableCell>
                        <TableCell>
                          <Badge variant="warning">{inventoryStatusLabel("FBA_INBOUND")}</Badge>
                        </TableCell>
                        <TableCell>
                          <Select
                            value={state.status}
                            onValueChange={(value) =>
                              setReceiveStateByItemId((prev) => ({
                                ...prev,
                                [line.inventory_item_id]: { ...(prev[line.inventory_item_id] ?? { note: "" }), status: value as ReceiveState["status"] },
                              }))
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="RECEIVED">Empfangen (FBA Lagernd)</SelectItem>
                              <SelectItem value="DISCREPANCY">Abweichung</SelectItem>
                              <SelectItem value="LOST">Verloren</SelectItem>
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Input
                            value={state.note}
                            onChange={(e) =>
                              setReceiveStateByItemId((prev) => ({
                                ...prev,
                                [line.inventory_item_id]: { ...(prev[line.inventory_item_id] ?? { status: "RECEIVED" }), note: e.target.value },
                              }))
                            }
                            placeholder="Optional (z. B. Fall-ID / Amazon Ticket)"
                            disabled={state.status === "RECEIVED"}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>

          {markReceived.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
              {(markReceived.error as Error).message}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setReceiveShipmentId(null)}>
              Abbrechen
            </Button>
            <Button
              type="button"
              onClick={() => receivingShipment && markReceived.mutate(receivingShipment.id)}
              disabled={markReceived.isPending || !receivingShipment}
            >
              Empfang abschließen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
