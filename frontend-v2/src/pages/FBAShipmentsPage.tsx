import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, PackageCheck, PackageOpen, Plus, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useApi } from "../api/api";
import { formatDateTimeLocal } from "../lib/dates";
import { fmtEur, formatEur, parseEurToCents } from "../lib/money";
import { paginateItems } from "../lib/pagination";
import { Button } from "../ui/Button";
import { InlineAlert } from "../ui/InlineAlert";
import { Pagination } from "../ui/Pagination";

type InventoryItem = {
  id: string;
  item_code: string;
  master_product_id: string;
  purchase_price_cents: number;
  status: string;
};

type MasterProduct = {
  id: string;
  sku: string;
  title: string;
  platform: string;
  region: string;
  variant: string;
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
  status: "DRAFT" | "SHIPPED" | "RECEIVED";
  carrier?: string | null;
  tracking_number?: string | null;
  shipping_cost_cents: number;
  cost_distribution_method: "EQUAL" | "PURCHASE_PRICE_WEIGHTED";
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

const DISTRIBUTION_OPTIONS: Array<{ value: ShipmentOut["cost_distribution_method"]; label: string }> = [
  { value: "EQUAL", label: "Gleichmäßig" },
  { value: "PURCHASE_PRICE_WEIGHTED", label: "Gewichtet (EK)" },
];

function optionLabel(options: Array<{ value: string; label: string }>, value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

function productLabel(mp?: MasterProduct | null) {
  if (!mp) return "Unbekanntes Produkt";
  return `${mp.title} · ${mp.platform} · ${mp.region}${mp.variant ? ` · ${mp.variant}` : ""}`;
}

export function FBAShipmentsPage() {
  const api = useApi();
  const qc = useQueryClient();

  const [message, setMessage] = useState<string | null>(null);
  const [searchShipment, setSearchShipment] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"edit" | "receive">("edit");

  const [name, setName] = useState("");
  const [shippingCost, setShippingCost] = useState("0,00");
  const [distributionMethod, setDistributionMethod] = useState<ShipmentOut["cost_distribution_method"]>("EQUAL");
  const [carrier, setCarrier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [searchInventory, setSearchInventory] = useState("");
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [page, setPage] = useState(1);

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
    enabled: mode === "edit",
    queryFn: () =>
      api.request<InventoryItem[]>(
        `/inventory?status=AVAILABLE&limit=100&offset=0${searchInventory.trim() ? `&q=${encodeURIComponent(searchInventory.trim())}` : ""}`,
      ),
  });

  const inboundInventory = useQuery({
    queryKey: ["fba-inbound-inventory"],
    enabled: mode === "receive",
    queryFn: () => api.request<InventoryItem[]>("/inventory?status=FBA_INBOUND&limit=200&offset=0"),
  });

  const mpById = useMemo(() => new Map((master.data ?? []).map((m) => [m.id, m])), [master.data]);
  const shipmentById = useMemo(() => new Map((shipments.data ?? []).map((s) => [s.id, s])), [shipments.data]);
  const selected = selectedId ? shipmentById.get(selectedId) ?? null : null;

  const listRows = useMemo(() => {
    const needle = searchShipment.trim().toLowerCase();
    const all = shipments.data ?? [];
    if (!needle) return all;
    return all.filter((s) => `${s.name} ${s.carrier ?? ""} ${s.tracking_number ?? ""}`.toLowerCase().includes(needle));
  }, [shipments.data, searchShipment]);

  const pagedShipments = useMemo(() => paginateItems(listRows, page, 20), [listRows, page]);

  useEffect(() => {
    setPage(1);
  }, [searchShipment]);

  useEffect(() => {
    if (page !== pagedShipments.page) setPage(pagedShipments.page);
  }, [page, pagedShipments.page]);

  const inventoryRows = availableInventory.data ?? [];
  const inboundRows = inboundInventory.data ?? [];

  const inventoryById = useMemo(() => new Map(inventoryRows.map((i) => [i.id, i])), [inventoryRows]);
  const inboundById = useMemo(() => new Map(inboundRows.map((i) => [i.id, i])), [inboundRows]);

  const selectedInventoryRows = useMemo(() => {
    const rows: InventoryItem[] = [];
    for (const id of selectedItemIds) {
      const found = inventoryById.get(id) ?? inboundById.get(id);
      if (found) rows.push(found);
      else rows.push({ id, item_code: "(unknown)", master_product_id: "", purchase_price_cents: 0, status: "" });
    }
    return rows;
  }, [selectedItemIds, inventoryById, inboundById]);

  const saveDraft = useMutation({
    mutationFn: () => {
      if (selected && selected.status !== "DRAFT") {
        throw new Error("Nur Draft-Sendungen können bearbeitet werden.");
      }
      const payload = {
        name: name.trim(),
        item_ids: selectedItemIds,
        shipping_cost_cents: parseEurToCents(shippingCost),
        cost_distribution_method: distributionMethod,
        carrier: carrier.trim() ? carrier.trim() : null,
        tracking_number: trackingNumber.trim() ? trackingNumber.trim() : null,
      };
      if (selected && selected.status === "DRAFT") {
        return api.request<ShipmentOut>(`/fba-shipments/${selected.id}`, { method: "PATCH", json: payload });
      }
      return api.request<ShipmentOut>("/fba-shipments", { method: "POST", json: payload });
    },
    onSuccess: async (out) => {
      setMessage("Gespeichert.");
      setSelectedId(out.id);
      await qc.invalidateQueries({ queryKey: ["fba-shipments"] });
      await qc.invalidateQueries({ queryKey: ["fba-available-inventory"] });
      await qc.invalidateQueries({ queryKey: ["inventory"] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Speichern fehlgeschlagen")),
  });

  const markShipped = useMutation({
    mutationFn: (shipmentId: string) => api.request<ShipmentOut>(`/fba-shipments/${shipmentId}/ship`, { method: "POST" }),
    onSuccess: async () => {
      setMessage("Sendung als versendet markiert.");
      await qc.invalidateQueries({ queryKey: ["fba-shipments"] });
      await qc.invalidateQueries({ queryKey: ["fba-available-inventory"] });
      await qc.invalidateQueries({ queryKey: ["inventory"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Ship fehlgeschlagen")),
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
      return api.request<ShipmentOut>(`/fba-shipments/${shipmentId}/receive`, { method: "POST", json: { discrepancies } });
    },
    onSuccess: async () => {
      setMode("edit");
      setReceiveStateByItemId({});
      setMessage("Sendung als empfangen markiert.");
      await qc.invalidateQueries({ queryKey: ["fba-shipments"] });
      await qc.invalidateQueries({ queryKey: ["inventory"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Receive fehlgeschlagen")),
  });

  function resetDraft() {
    setMode("edit");
    setName("");
    setShippingCost("0,00");
    setDistributionMethod("EQUAL");
    setCarrier("");
    setTrackingNumber("");
    setSelectedItemIds([]);
    setSearchInventory("");
    setReceiveStateByItemId({});
  }

  function openCreate() {
    resetDraft();
    setSelectedId("new");
  }

  function backToList() {
    resetDraft();
    setSelectedId(null);
  }

  function openEdit(shipment: ShipmentOut) {
    setSelectedId(shipment.id);
    setMode("edit");
    setName(shipment.name);
    setShippingCost(formatEur(shipment.shipping_cost_cents));
    setDistributionMethod(shipment.cost_distribution_method);
    setCarrier(shipment.carrier ?? "");
    setTrackingNumber(shipment.tracking_number ?? "");
    setSelectedItemIds(shipment.items.map((i) => i.inventory_item_id));
    setSearchInventory("");
    setReceiveStateByItemId({});
  }

  function openReceive(shipment: ShipmentOut) {
    setSelectedId(shipment.id);
    setMode("receive");
    setReceiveStateByItemId(() => {
      const next: Record<string, ReceiveState> = {};
      shipment.items.forEach((line) => {
        next[line.inventory_item_id] = { status: "RECEIVED", note: "" };
      });
      return next;
    });
  }

  const isDraftMode = !selected || selected.status === "DRAFT";
  const editingLocked = Boolean(selected && selected.status !== "DRAFT");
  const canSubmit = isDraftMode && name.trim().length > 0 && selectedItemIds.length > 0 && !saveDraft.isPending;
  const canShip = selected?.status === "DRAFT" && !markShipped.isPending;
  const canReceive = selected?.status === "SHIPPED" && !markReceived.isPending;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">FBA Sendungen</div>
          <div className="page-subtitle">Draft → Shipped → Received. Items werden dabei im Inventory verschoben.</div>
        </div>
        <div className="page-actions">
          <Button variant="secondary" size="sm" onClick={() => shipments.refetch()}>
            <RefreshCw size={16} /> Aktualisieren
          </Button>
          <Button variant="primary" size="sm" onClick={openCreate}>
            <Plus size={16} /> Neu
          </Button>
        </div>
      </div>

      {message ? (
        <InlineAlert tone="info" onDismiss={() => setMessage(null)}>
          {message}
        </InlineAlert>
      ) : null}

      <div className="split" data-mobile={selectedId ? "detail" : "list"}>
        <div className="panel">
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <input
              className="input"
              placeholder="Suche (Name/Carrier/Tracking)…"
              value={searchShipment}
              onChange={(e) => setSearchShipment(e.target.value)}
            />
            <div className="toolbar-spacer" />
            <Pagination page={pagedShipments.page} pageSize={pagedShipments.pageSize} total={pagedShipments.totalItems} onPageChange={setPage} />
          </div>

          {shipments.isError ? <InlineAlert tone="error">Sendungen konnten nicht geladen werden.</InlineAlert> : null}

          <table className="table">
            <thead>
              <tr>
                <th>Sendung</th>
                <th>Status</th>
                <th className="numeric">Items</th>
                <th className="numeric">Kosten</th>
                <th className="numeric hide-mobile">Shipped</th>
              </tr>
            </thead>
            <tbody>
              {pagedShipments.items.map((s) => (
                <tr
                  key={s.id}
                  style={{ cursor: "pointer" }}
                  onClick={() => {
                    if (s.status === "DRAFT") openEdit(s);
                    else if (s.status === "SHIPPED") openReceive(s);
                    else openEdit(s);
                  }}
                >
                  <td>
                    <div style={{ fontWeight: 650 }}>{s.name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {s.carrier ?? "—"} · {s.tracking_number ?? "—"}
                    </div>
                  </td>
                  <td>
                    <span className={s.status === "RECEIVED" ? "badge badge--ok" : s.status === "SHIPPED" ? "badge badge--warn" : "badge"}>
                      {s.status}
                    </span>
                  </td>
                  <td className="numeric">{s.items.length}</td>
                  <td className="numeric nowrap">{fmtEur(s.shipping_cost_cents)}</td>
                  <td className="numeric muted nowrap hide-mobile">{formatDateTimeLocal(s.shipped_at ?? null)}</td>
                </tr>
              ))}
              {!pagedShipments.items.length && !shipments.isLoading ? (
                <tr>
                  <td colSpan={5} className="muted">
                    Keine Treffer.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="panel">
          {selectedId ? (
            <div className="only-mobile" style={{ marginBottom: 8 }}>
              <Button variant="secondary" size="sm" onClick={backToList}>
                ← Zur Liste
              </Button>
            </div>
          ) : null}
          <div className="panel-title">{mode === "receive" ? "Empfang" : selected ? "Draft bearbeiten" : "Neue Sendung"}</div>
          <div className="panel-sub">{selected ? selected.id : "Erstelle eine neue Sendung oder wähle links eine aus."}</div>

          {mode === "edit" ? (
            <div className="stack" style={{ marginTop: 10 }}>
              {selected && selected.status !== "DRAFT" ? (
                <InlineAlert tone="info">Diese Sendung ist nicht im Draft-Status. Bearbeitung ist gesperrt.</InlineAlert>
              ) : null}
              <div className="field">
                <div className="field-label">Name</div>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={editingLocked} />
              </div>
              <div className="toolbar">
                <div className="field" style={{ flex: "1 1 160px" }}>
                  <div className="field-label">Shipping cost (EUR)</div>
                  <input className="input" value={shippingCost} onChange={(e) => setShippingCost(e.target.value)} inputMode="decimal" disabled={editingLocked} />
                </div>
                <div className="field" style={{ flex: "1 1 220px" }}>
                  <div className="field-label">Distribution</div>
                  <select className="input" value={distributionMethod} onChange={(e) => setDistributionMethod(e.target.value as any)} disabled={editingLocked}>
                    {DISTRIBUTION_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="toolbar">
                <input className="input" value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="Carrier" disabled={editingLocked} />
                <input className="input" value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} placeholder="Tracking" disabled={editingLocked} />
              </div>

              <div className="card" style={{ boxShadow: "none" }}>
                <div style={{ fontWeight: 650 }}>Items</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {selectedItemIds.length} ausgewählt
                </div>

                <div className="toolbar" style={{ marginTop: 10 }}>
                  <input
                    className="input"
                    placeholder="Suche Inventory (nur AVAILABLE)…"
                    value={searchInventory}
                    onChange={(e) => setSearchInventory(e.target.value)}
                    disabled={editingLocked}
                  />
                </div>

                {availableInventory.isError ? <InlineAlert tone="error">Inventory Picker konnte nicht geladen werden.</InlineAlert> : null}

                <div style={{ marginTop: 10, maxHeight: 220, overflow: "auto" }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th />
                        <th>Item</th>
                        <th className="numeric">EK</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inventoryRows.map((invRow) => (
                        <tr key={invRow.id}>
                          <td className="nowrap">
                              <input
                                type="checkbox"
                                checked={selectedItemIds.includes(invRow.id)}
                                onChange={(e) => {
                                  setSelectedItemIds((prev) => {
                                    const set = new Set(prev);
                                    if (e.target.checked) set.add(invRow.id);
                                    else set.delete(invRow.id);
                                    return Array.from(set);
                                  });
                                }}
                                disabled={editingLocked}
                              />
                          </td>
                          <td>
                            <div style={{ fontWeight: 650 }} className="mono">
                              {invRow.item_code}
                            </div>
                            <div className="muted" style={{ fontSize: 12 }}>
                              {productLabel(mpById.get(invRow.master_product_id))}
                            </div>
                          </td>
                          <td className="numeric nowrap">{fmtEur(invRow.purchase_price_cents)}</td>
                        </tr>
                      ))}
                      {!inventoryRows.length && !availableInventory.isLoading ? (
                        <tr>
                          <td colSpan={3} className="muted">
                            Keine Treffer.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>

                {selectedInventoryRows.length ? (
                  <div style={{ marginTop: 10 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                      Auswahl
                    </div>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Item</th>
                          <th className="numeric">Allocated ship</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedInventoryRows.map((row) => (
                          <tr key={row.id}>
                            <td>
                              <span className="mono">{row.item_code}</span>{" "}
                              <span className="muted">·</span> {productLabel(mpById.get(row.master_product_id))}
                            </td>
                            <td className="numeric muted">—</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>

              <div className="toolbar">
                <Button variant="primary" onClick={() => saveDraft.mutate()} disabled={!canSubmit}>
                  <Check size={16} /> Speichern
                </Button>

                {selected?.status === "DRAFT" ? (
                  <Button variant="secondary" onClick={() => markShipped.mutate(selected.id)} disabled={!canShip}>
                    <PackageOpen size={16} /> Versendet
                  </Button>
                ) : null}

                {selected?.status === "SHIPPED" ? (
                  <Button variant="secondary" onClick={() => openReceive(selected)} disabled={markReceived.isPending}>
                    <PackageCheck size={16} /> Empfang…
                  </Button>
                ) : null}
              </div>
            </div>
          ) : selected ? (
            <div className="stack" style={{ marginTop: 10 }}>
              <div className="kv">
                <div className="k">Sendung</div>
                <div className="v">{selected.name}</div>
                <div className="k">Status</div>
                <div className="v">
                  <span className={selected.status === "SHIPPED" ? "badge badge--warn" : selected.status === "RECEIVED" ? "badge badge--ok" : "badge"}>
                    {selected.status}
                  </span>
                </div>
                <div className="k">Kosten</div>
                <div className="v">{fmtEur(selected.shipping_cost_cents)} ({optionLabel(DISTRIBUTION_OPTIONS as any, selected.cost_distribution_method)})</div>
                <div className="k">Shipped</div>
                <div className="v">{formatDateTimeLocal(selected.shipped_at ?? null)}</div>
              </div>

              <div className="card" style={{ boxShadow: "none" }}>
                <div style={{ fontWeight: 650 }}>Discrepancies (optional)</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  Default: alle RECEIVED. Markiere nur Lost/Discrepancy.
                </div>
                <table className="table" style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Status</th>
                      <th>Notiz</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.items.map((line) => {
                      const invRow = inboundById.get(line.inventory_item_id);
                      const mp = invRow ? mpById.get(invRow.master_product_id) ?? null : null;
                      const state = receiveStateByItemId[line.inventory_item_id] ?? { status: "RECEIVED", note: "" };
                      return (
                        <tr key={line.id}>
                          <td>
                            <div className="mono">{invRow?.item_code ?? line.inventory_item_id.slice(0, 8) + "…"}</div>
                            <div className="muted" style={{ fontSize: 12 }}>
                              {invRow ? productLabel(mp) : "Inventory lookup: —"}
                            </div>
                          </td>
                          <td className="nowrap">
                            <select
                              className="input"
                              value={state.status}
                              onChange={(e) =>
                                setReceiveStateByItemId((prev) => ({
                                  ...prev,
                                  [line.inventory_item_id]: { ...state, status: e.target.value as any },
                                }))
                              }
                            >
                              <option value="RECEIVED">RECEIVED</option>
                              <option value="DISCREPANCY">DISCREPANCY</option>
                              <option value="LOST">LOST</option>
                            </select>
                          </td>
                          <td>
                            <input
                              className="input"
                              value={state.note}
                              onChange={(e) =>
                                setReceiveStateByItemId((prev) => ({
                                  ...prev,
                                  [line.inventory_item_id]: { ...state, note: e.target.value },
                                }))
                              }
                              placeholder="Notiz (optional)"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="toolbar">
                <Button variant="primary" onClick={() => markReceived.mutate(selected.id)} disabled={!canReceive}>
                  <PackageCheck size={16} /> Empfang bestätigen
                </Button>
                <Button variant="secondary" onClick={() => setMode("edit")}>
                  Zurück
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
