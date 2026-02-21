import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FilePlus, Pencil, RefreshCw, Save, Undo2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useApi } from "../api/api";
import { formatEur, fmtEur, parseEurToCents } from "../lib/money";
import { paginateItems } from "../lib/pagination";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { InlineAlert } from "../ui/InlineAlert";
import { Pagination } from "../ui/Pagination";

type PurchaseType = "DIFF" | "REGULAR";
type OrderStatus = "DRAFT" | "FINALIZED" | "CANCELLED";
type OrderChannel = "EBAY" | "AMAZON" | "WILLHABEN" | "OTHER";
type PaymentSource = "CASH" | "BANK";
type ReturnAction = "RESTOCK" | "WRITE_OFF";

type InventoryItem = {
  id: string;
  item_code: string;
  master_product_id: string;
  purchase_type: PurchaseType;
  purchase_price_cents: number;
  status: string;
  effective_target_sell_price_cents?: number | null;
};

type MasterProduct = { id: string; sku?: string; title: string; platform: string; region: string; variant?: string | null };

type SalesOrder = {
  id: string;
  order_date: string;
  channel: OrderChannel;
  status: OrderStatus;
  buyer_name: string;
  buyer_address?: string | null;
  shipping_gross_cents: number;
  payment_source: PaymentSource;
  invoice_number?: string | null;
  invoice_pdf_path?: string | null;
  created_at: string;
  updated_at: string;
  lines: Array<{
    id: string;
    inventory_item_id: string;
    purchase_type: PurchaseType;
    sale_gross_cents: number;
    sale_net_cents: number;
    sale_tax_cents: number;
    tax_rate_bp: number;
  }>;
};

type SalesCorrection = {
  id: string;
  order_id: string;
  correction_date: string;
  correction_number: string;
  pdf_path?: string | null;
  refund_gross_cents: number;
  shipping_refund_gross_cents: number;
  payment_source: PaymentSource;
  created_at: string;
  updated_at: string;
  lines: Array<{
    id: string;
    inventory_item_id: string;
    action: ReturnAction;
    purchase_type: PurchaseType;
    refund_gross_cents: number;
    refund_net_cents: number;
    refund_tax_cents: number;
    tax_rate_bp: number;
  }>;
};

type DraftLine = { inventory_item_id: string; sale_gross: string };
type ReturnLineDraft = { inventory_item_id: string; include: boolean; action: ReturnAction; refund_gross: string };

const CHANNEL_OPTIONS: Array<{ value: OrderChannel; label: string }> = [
  { value: "EBAY", label: "eBay" },
  { value: "AMAZON", label: "Amazon" },
  { value: "WILLHABEN", label: "willhaben" },
  { value: "OTHER", label: "Sonstiges" },
];

const PAYMENT_SOURCE_OPTIONS: Array<{ value: PaymentSource; label: string }> = [
  { value: "CASH", label: "Bar" },
  { value: "BANK", label: "Bank" },
];

const STATUS_OPTIONS: Array<{ value: OrderStatus | "ALL"; label: string }> = [
  { value: "ALL", label: "Alle" },
  { value: "DRAFT", label: "Entwurf" },
  { value: "FINALIZED", label: "Abgeschlossen" },
  { value: "CANCELLED", label: "Storniert" },
];

const RETURN_ACTION_OPTIONS: Array<{ value: ReturnAction; label: string }> = [
  { value: "RESTOCK", label: "Wieder einlagern" },
  { value: "WRITE_OFF", label: "Ausbuchen" },
];

function optionLabel(options: Array<{ value: string; label: string }>, value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

function todayIsoLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function safeParseEurToCents(input: string): number | null {
  try {
    return parseEurToCents(input);
  } catch {
    return null;
  }
}

export function SalesPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [message, setMessage] = useState<string | null>(null);

  const selectedId = params.get("selected") ?? "";
  const modeParam = params.get("mode") ?? "";
  const mode: "view" | "edit" = selectedId === "new" ? "edit" : modeParam === "edit" ? "edit" : "view";
  const search = params.get("q") ?? "";
  const statusFilter = (params.get("status") as any) ?? "ALL";
  const page = Number(params.get("page") ?? "1") || 1;

  const master = useQuery({
    queryKey: ["master-products"],
    queryFn: () => api.request<MasterProduct[]>("/master-products"),
  });
  const mpById = useMemo(() => new Map((master.data ?? []).map((m) => [m.id, m] as const)), [master.data]);

  const orders = useQuery({
    queryKey: ["sales"],
    queryFn: () => api.request<SalesOrder[]>("/sales"),
  });

  const ordersAll = orders.data ?? [];
  const ordersFiltered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rows = ordersAll.filter((o) => (statusFilter === "ALL" ? true : o.status === statusFilter));
    if (!needle) return rows;
    return rows.filter((o) => {
      const gross = o.shipping_gross_cents + o.lines.reduce((s, l) => s + l.sale_gross_cents, 0);
      const hay = [o.order_date, o.channel, o.status, o.buyer_name, o.invoice_number ?? "", String(gross)].join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }, [ordersAll, search, statusFilter]);

  const paged = useMemo(() => paginateItems(ordersFiltered, page, 30), [ordersFiltered, page]);

  useEffect(() => {
    if (page !== paged.page) {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("page", String(paged.page));
        return next;
      });
    }
  }, [page, paged.page, setParams]);

  const selectedOrder: SalesOrder | null = useMemo(() => {
    if (!selectedId || selectedId === "new") return null;
    return ordersAll.find((o) => o.id === selectedId) ?? null;
  }, [ordersAll, selectedId]);

  // --- Editor state ---
  const [draftOrderId, setDraftOrderId] = useState<string | null>(null);
  const [orderDate, setOrderDate] = useState(todayIsoLocal());
  const [channel, setChannel] = useState<OrderChannel>("EBAY");
  const [buyerName, setBuyerName] = useState("");
  const [buyerAddress, setBuyerAddress] = useState("");
  const [shippingGross, setShippingGross] = useState("0,00");
  const [paymentSource, setPaymentSource] = useState<PaymentSource>("BANK");
  const [searchInv, setSearchInv] = useState("");
  const [selectedLines, setSelectedLines] = useState<DraftLine[]>([]);

  const inventorySearchTrimmed = searchInv.trim();
  const canQueryInventory = mode === "edit" && inventorySearchTrimmed.length >= 2;

  const inv = useQuery({
    queryKey: ["inventory-available", inventorySearchTrimmed],
    enabled: canQueryInventory,
    queryFn: () =>
      api.request<InventoryItem[]>(
        `/inventory?status=AVAILABLE&limit=50&offset=0&q=${encodeURIComponent(inventorySearchTrimmed)}`,
      ),
  });

  const invById = useMemo(() => new Map((inv.data ?? []).map((item) => [item.id, item] as const)), [inv.data]);

  const finalize = useMutation({
    mutationFn: (orderId: string) => api.request<SalesOrder>(`/sales/${orderId}/finalize`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales"] });
      await qc.invalidateQueries({ queryKey: ["inventory"] });
      setMessage("Auftrag abgeschlossen.");
    },
  });

  const cancel = useMutation({
    mutationFn: (orderId: string) => api.request<SalesOrder>(`/sales/${orderId}/cancel`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales"] });
      await qc.invalidateQueries({ queryKey: ["inventory"] });
      setMessage("Auftrag storniert.");
    },
  });

  const generateInvoicePdf = useMutation({
    mutationFn: (orderId: string) => api.request<SalesOrder>(`/sales/${orderId}/generate-invoice-pdf`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales"] });
      setMessage("Rechnung erstellt.");
    },
  });

  const reopenOrder = useMutation({
    mutationFn: (orderId: string) => api.request<SalesOrder>(`/sales/${orderId}/reopen`, { method: "POST" }),
    onSuccess: async (order) => {
      await qc.invalidateQueries({ queryKey: ["sales"] });
      await qc.invalidateQueries({ queryKey: ["inventory"] });
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("selected", order.id);
        next.set("mode", "edit");
        return next;
      });
      setMessage("Zur Bearbeitung geöffnet.");
    },
  });

  const saveDraft = useMutation({
    mutationFn: async () => {
      const parsedShipping = safeParseEurToCents(shippingGross);
      if (parsedShipping === null) throw new Error("Ungültiger Versandbetrag");
      const payload = {
        order_date: orderDate,
        channel,
        buyer_name: buyerName.trim(),
        buyer_address: buyerAddress.trim() ? buyerAddress.trim() : null,
        shipping_gross_cents: parsedShipping,
        payment_source: paymentSource,
        lines: selectedLines.map((l) => ({
          inventory_item_id: l.inventory_item_id,
          sale_gross_cents: parseEurToCents(l.sale_gross),
        })),
      };
      if (draftOrderId) return api.request<SalesOrder>(`/sales/${draftOrderId}`, { method: "PUT", json: payload });
      return api.request<SalesOrder>("/sales", { method: "POST", json: payload });
    },
    onSuccess: async (order) => {
      const created = !draftOrderId;
      setDraftOrderId(order.id);
      await qc.invalidateQueries({ queryKey: ["sales"] });
      await qc.invalidateQueries({ queryKey: ["inventory"] });
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("selected", order.id);
        next.set("mode", "view");
        return next;
      });
      setMessage(created ? "Auftrag erstellt (Entwurf)." : "Auftrag gespeichert.");
    },
  });

  const [returnDate, setReturnDate] = useState(todayIsoLocal());
  const [returnPaymentSource, setReturnPaymentSource] = useState<PaymentSource>("BANK");
  const [shippingRefund, setShippingRefund] = useState("0,00");
  const [returnLines, setReturnLines] = useState<ReturnLineDraft[]>([]);

  const returns = useQuery({
    queryKey: ["sales-returns", selectedOrder?.id ?? ""],
    enabled: Boolean(selectedOrder?.id),
    queryFn: async () => {
      if (!selectedOrder) return [];
      return api.request<SalesCorrection[]>(`/sales/${selectedOrder.id}/returns`);
    },
  });

  const correctedItemIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of returns.data ?? []) {
      for (const line of c.lines) ids.add(line.inventory_item_id);
    }
    return ids;
  }, [returns.data]);

  const createReturn = useMutation({
    mutationFn: async () => {
      if (!selectedOrder) throw new Error("Kein Auftrag ausgewählt");
      const parsedShipRefund = safeParseEurToCents(shippingRefund);
      if (parsedShipRefund === null) throw new Error("Ungültige Versand-Erstattung");
      const included = returnLines.filter((l) => l.include && !correctedItemIds.has(l.inventory_item_id));
      if (!included.length) throw new Error("Keine Position ausgewählt");
      return api.request<SalesCorrection>(`/sales/${selectedOrder.id}/returns`, {
        method: "POST",
        json: {
          correction_date: returnDate,
          payment_source: returnPaymentSource,
          shipping_refund_gross_cents: parsedShipRefund,
          lines: included.map((l) => ({
            inventory_item_id: l.inventory_item_id,
            action: l.action,
            refund_gross_cents: l.refund_gross.trim() ? parseEurToCents(l.refund_gross) : null,
          })),
        },
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales"] });
      await qc.invalidateQueries({ queryKey: ["inventory"] });
      await qc.invalidateQueries({ queryKey: ["sales-returns"] });
      setMessage("Korrektur erstellt.");
    },
  });

  const generateReturnPdf = useMutation({
    mutationFn: ({ orderId, correctionId }: { orderId: string; correctionId: string }) =>
      api.request<SalesCorrection>(`/sales/${orderId}/returns/${correctionId}/generate-pdf`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales"] });
      await qc.invalidateQueries({ queryKey: ["sales-returns"] });
      setMessage("Korrektur-PDF erstellt.");
    },
  });

  const canSubmit =
    /^\d{4}-\d{2}-\d{2}$/.test(orderDate) &&
    buyerName.trim().length > 0 &&
    selectedLines.length > 0 &&
    selectedLines.every((l) => safeParseEurToCents(l.sale_gross) !== null && (safeParseEurToCents(l.sale_gross) ?? 0) > 0) &&
    safeParseEurToCents(shippingGross) !== null;

  useEffect(() => {
    if (mode !== "edit") return;
    if (selectedId === "new") {
      if (draftOrderId === null) resetDraft();
      return;
    }
    if (!selectedOrder) return;
    if (draftOrderId === selectedOrder.id) return;
    startEdit(selectedOrder);
  }, [draftOrderId, mode, selectedId, selectedOrder]);

  function resetDraft() {
    setDraftOrderId(null);
    setOrderDate(todayIsoLocal());
    setChannel("EBAY");
    setBuyerName("");
    setBuyerAddress("");
    setShippingGross("0,00");
    setPaymentSource("BANK");
    setSearchInv("");
    setSelectedLines([]);
    saveDraft.reset();
  }

  function startEdit(o: SalesOrder) {
    setDraftOrderId(o.id);
    setOrderDate(o.order_date);
    setChannel(o.channel);
    setBuyerName(o.buyer_name);
    setBuyerAddress(o.buyer_address ?? "");
    setShippingGross(formatEur(o.shipping_gross_cents));
    setPaymentSource(o.payment_source);
    setSearchInv("");
    setSelectedLines(o.lines.map((l) => ({ inventory_item_id: l.inventory_item_id, sale_gross: formatEur(l.sale_gross_cents) })));

    setReturnDate(todayIsoLocal());
    setReturnPaymentSource(o.payment_source);
    setShippingRefund("0,00");
    setReturnLines(
      o.lines.map((l) => ({
        inventory_item_id: l.inventory_item_id,
        include: true,
        action: "RESTOCK",
        refund_gross: formatEur(l.sale_gross_cents),
      })),
    );
    saveDraft.reset();
  }

  function requestNewOrder() {
    if (mode === "edit" && hasDraftChanges()) {
      const ok = window.confirm("Ungespeicherte Eingaben gehen verloren. Trotzdem neuen Auftrag starten?");
      if (!ok) return;
    }
    resetDraft();
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("selected", "new");
      next.set("mode", "edit");
      return next;
    });
  }

  function hasDraftChanges(): boolean {
    if (!draftOrderId) {
      if (buyerName.trim() || buyerAddress.trim()) return true;
      if (shippingGross !== "0,00") return true;
      if (selectedLines.length) return true;
    }
    return false;
  }

  function closeEditor() {
    if (mode !== "edit") return;
    if (hasDraftChanges()) {
      const ok = window.confirm("Ungespeicherte Eingaben gehen verloren. Trotzdem schließen?");
      if (!ok) return;
    }
    resetDraft();
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("mode", "view");
      if (selectedId === "new") next.delete("selected");
      return next;
    });
  }

  function openEditorForSelected() {
    if (!selectedOrder) return;
    if (selectedOrder.status !== "DRAFT") return;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("selected", selectedOrder.id);
      next.set("mode", "edit");
      return next;
    });
  }

  const errors = [
    orders.isError ? (orders.error as Error) : null,
    inv.isError ? (inv.error as Error) : null,
    saveDraft.isError ? (saveDraft.error as Error) : null,
    finalize.isError ? (finalize.error as Error) : null,
    cancel.isError ? (cancel.error as Error) : null,
    generateInvoicePdf.isError ? (generateInvoicePdf.error as Error) : null,
    reopenOrder.isError ? (reopenOrder.error as Error) : null,
    returns.isError ? (returns.error as Error) : null,
    createReturn.isError ? (createReturn.error as Error) : null,
    generateReturnPdf.isError ? (generateReturnPdf.error as Error) : null,
  ].filter(Boolean) as Error[];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Verkäufe</div>
          <div className="page-subtitle">Aufträge erfassen, abschließen, Rechnungen/Korrekturen als PDF.</div>
        </div>
        <div className="page-actions">
          <Button variant="secondary" size="sm" onClick={() => orders.refetch()} disabled={orders.isFetching}>
            <RefreshCw size={16} /> Aktualisieren
          </Button>
          <Button variant="primary" size="sm" onClick={requestNewOrder}>
            <FilePlus size={16} /> Neu
          </Button>
        </div>
      </div>

      {message ? (
        <InlineAlert tone="info" onDismiss={() => setMessage(null)}>
          {message}
        </InlineAlert>
      ) : null}

      {errors.length ? <InlineAlert tone="error">{errors[0].message}</InlineAlert> : null}

      <div className="split" style={{ gridTemplateColumns: "1fr 540px" }}>
        <div className="panel">
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <input
              className="input"
              placeholder="Suche (Käufer, Datum, Invoice, …)"
              value={search}
              onChange={(e) =>
                setParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.set("q", e.target.value);
                  next.set("page", "1");
                  return next;
                })
              }
            />
            <select
              className="input"
              style={{ width: 200 }}
              value={statusFilter}
              onChange={(e) =>
                setParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.set("status", e.target.value);
                  next.set("page", "1");
                  return next;
                })
              }
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <div className="toolbar-spacer" />
            <Pagination
              page={paged.page}
              pageSize={paged.pageSize}
              total={paged.totalItems}
              onPageChange={(p) =>
                setParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.set("page", String(p));
                  return next;
                })
              }
            />
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>Datum</th>
                <th>Kanal</th>
                <th>Status</th>
                <th>Käufer</th>
                <th className="numeric">Brutto</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((o) => {
                const gross = o.shipping_gross_cents + o.lines.reduce((s, l) => s + l.sale_gross_cents, 0);
                const selected = o.id === selectedId;
                return (
                  <tr
                    key={o.id}
                    style={{ cursor: "pointer", background: selected ? "var(--surface-2)" : undefined }}
                    onClick={() =>
                      setParams((prev) => {
                        const next = new URLSearchParams(prev);
                        next.set("selected", o.id);
                        next.set("mode", "view");
                        return next;
                      })
                    }
                  >
                    <td className="nowrap mono">{o.order_date}</td>
                    <td>{optionLabel(CHANNEL_OPTIONS, o.channel)}</td>
                    <td>
                      <span className={o.status === "FINALIZED" ? "badge badge--ok" : o.status === "DRAFT" ? "badge badge--warn" : "badge"}>
                        {optionLabel(STATUS_OPTIONS, o.status)}
                      </span>
                      {o.invoice_number ? (
                        <div className="muted mono" style={{ fontSize: 12, marginTop: 4 }}>
                          #{o.invoice_number}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <div style={{ fontWeight: 650 }}>{o.buyer_name}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {o.lines.length} Position{ o.lines.length === 1 ? "" : "en" }
                      </div>
                    </td>
                    <td className="numeric mono">{fmtEur(gross)}</td>
                  </tr>
                );
              })}
              {!paged.items.length ? (
                <tr>
                  <td colSpan={5} className="muted">
                    Keine Daten.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="panel">
          {selectedId === "new" || mode === "edit" ? (
            <div className="stack">
              <div className="toolbar" style={{ justifyContent: "space-between" }}>
                <div>
                  <div className="panel-title">{draftOrderId ? "Auftrag bearbeiten" : "Auftrag erfassen"}</div>
                  <div className="panel-sub">{draftOrderId ? <span className="mono">{draftOrderId}</span> : "Draft wird erst beim Speichern erstellt."}</div>
                </div>
                <div className="toolbar">
                  <Button variant="secondary" size="sm" onClick={closeEditor}>
                    <Undo2 size={16} /> Schließen
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => saveDraft.mutate()} disabled={!canSubmit || saveDraft.isPending}>
                    <Save size={16} /> {saveDraft.isPending ? "Speichere…" : "Speichern"}
                  </Button>
                </div>
              </div>

              <details open>
                <summary className="panel-title" style={{ cursor: "pointer" }}>
                  Basis
                </summary>
                <div className="stack" style={{ marginTop: 10 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <Field label="Datum">
                      <input className="input" type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
                    </Field>
                    <Field label="Kanal">
                      <select className="input" value={channel} onChange={(e) => setChannel(e.target.value as OrderChannel)}>
                        {CHANNEL_OPTIONS.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>

                  <Field label="Käufer">
                    <input className="input" value={buyerName} onChange={(e) => setBuyerName(e.target.value)} placeholder="Name" />
                  </Field>
                  <Field label="Adresse (optional)">
                    <textarea className="input" value={buyerAddress} onChange={(e) => setBuyerAddress(e.target.value)} rows={2} />
                  </Field>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <Field label="Versand brutto (EUR)">
                      <input className="input" value={shippingGross} onChange={(e) => setShippingGross(e.target.value)} />
                    </Field>
                    <Field label="Zahlungsquelle">
                      <select className="input" value={paymentSource} onChange={(e) => setPaymentSource(e.target.value as PaymentSource)}>
                        {PAYMENT_SOURCE_OPTIONS.map((p) => (
                          <option key={p.value} value={p.value}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                </div>
              </details>

              <details open>
                <summary className="panel-title" style={{ cursor: "pointer" }}>
                  Positionen ({selectedLines.length})
                </summary>
                <div className="stack" style={{ marginTop: 10 }}>
                  <div className="toolbar">
                    <input className="input" placeholder="Verfügbaren Bestand suchen (Status=AVAILABLE)..." value={searchInv} onChange={(e) => setSearchInv(e.target.value)} />
                    <div className="toolbar-spacer" />
                    <span className="muted" style={{ fontSize: 12 }}>
                      {canQueryInventory ? "Tippe um zu suchen" : "Mind. 2 Zeichen"}
                    </span>
                  </div>

                  {canQueryInventory ? (
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Artikel</th>
                          <th className="numeric">EK</th>
                          <th className="numeric">Vorschlag</th>
                          <th className="numeric"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {(inv.data ?? []).map((it) => {
                          const mp = mpById.get(it.master_product_id);
                          const already = selectedLines.some((l) => l.inventory_item_id === it.id);
                          return (
                            <tr key={it.id}>
                              <td>
                                <div style={{ fontWeight: 650 }}>{mp?.title ?? it.master_product_id}</div>
                                <div className="muted" style={{ fontSize: 12 }}>
                                  <span className="mono">{it.item_code}</span>
                                  {mp?.sku ? ` · ${mp.sku}` : ""}
                                </div>
                              </td>
                              <td className="numeric mono">{fmtEur(it.purchase_price_cents)}</td>
                              <td className="numeric mono">{it.effective_target_sell_price_cents ? fmtEur(it.effective_target_sell_price_cents) : "—"}</td>
                              <td className="numeric">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant={already ? "secondary" : "primary"}
                                  disabled={already}
                                  onClick={() => {
                                    const preset = it.effective_target_sell_price_cents ? formatEur(it.effective_target_sell_price_cents) : "";
                                    setSelectedLines((s) => [...s, { inventory_item_id: it.id, sale_gross: preset }]);
                                  }}
                                >
                                  {already ? "✓" : "+ Hinzufügen"}
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                        {inv.isFetching ? (
                          <tr>
                            <td colSpan={4} className="muted">
                              Lade…
                            </td>
                          </tr>
                        ) : null}
                        {canQueryInventory && !inv.isFetching && !(inv.data ?? []).length ? (
                          <tr>
                            <td colSpan={4} className="muted">
                              Keine Treffer.
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  ) : null}

                  <div className="panel" style={{ padding: 12 }}>
                    <div className="panel-title" style={{ fontSize: 13 }}>
                      Auftragspositionen
                    </div>
                    <table className="table" style={{ marginTop: 10 }}>
                      <thead>
                        <tr>
                          <th>Inventory</th>
                          <th className="numeric">Verkauf brutto (EUR)</th>
                          <th className="numeric"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedLines.map((l, idx) => {
                          const invItem = invById.get(l.inventory_item_id);
                          const mp = invItem ? mpById.get(invItem.master_product_id) : null;
                          return (
                            <tr key={`${l.inventory_item_id}-${idx}`}>
                              <td>
                                <div className="mono" style={{ fontSize: 12 }}>
                                  {invItem?.item_code ?? l.inventory_item_id}
                                </div>
                                {mp ? <div className="muted" style={{ fontSize: 12 }}>{mp.title}</div> : null}
                              </td>
                              <td className="numeric">
                                <input
                                  className="input"
                                  style={{ textAlign: "right" }}
                                  value={l.sale_gross}
                                  onChange={(e) => setSelectedLines((s) => s.map((x, i) => (i === idx ? { ...x, sale_gross: e.target.value } : x)))}
                                />
                              </td>
                              <td className="numeric">
                                <Button type="button" size="sm" variant="ghost" onClick={() => setSelectedLines((s) => s.filter((_, i) => i !== idx))}>
                                  <XCircle size={16} />
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                        {!selectedLines.length ? (
                          <tr>
                            <td colSpan={3} className="muted">
                              Noch keine Positionen.
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </div>
              </details>
            </div>
          ) : selectedOrder ? (
            <div className="stack">
              <div className="toolbar" style={{ justifyContent: "space-between" }}>
                <div>
                  <div className="panel-title">Auftrag</div>
                  <div className="panel-sub">
                    <span className="mono">{selectedOrder.id}</span>
                  </div>
                </div>
                <div className="toolbar">
                  {selectedOrder.status === "DRAFT" ? (
                    <>
                      <Button variant="primary" size="sm" onClick={openEditorForSelected}>
                        <Pencil size={16} /> Bearbeiten
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => finalize.mutate(selectedOrder.id)} disabled={finalize.isPending}>
                        Abschließen
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => cancel.mutate(selectedOrder.id)} disabled={cancel.isPending}>
                        Stornieren
                      </Button>
                    </>
                  ) : selectedOrder.status === "FINALIZED" ? (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          selectedOrder.invoice_pdf_path
                            ? api.download(selectedOrder.invoice_pdf_path, selectedOrder.invoice_pdf_path.split("/").pop() ?? "rechnung.pdf")
                            : generateInvoicePdf.mutate(selectedOrder.id)
                        }
                        disabled={generateInvoicePdf.isPending}
                      >
                        <Download size={16} /> {selectedOrder.invoice_pdf_path ? "Rechnung" : "PDF erstellen"}
                      </Button>
                      <Button variant="primary" size="sm" onClick={() => reopenOrder.mutate(selectedOrder.id)} disabled={reopenOrder.isPending}>
                        <Undo2 size={16} /> Reopen
                      </Button>
                      {selectedOrder.invoice_pdf_path ? (
                        <Button variant="ghost" size="sm" onClick={() => generateInvoicePdf.mutate(selectedOrder.id)} disabled={generateInvoicePdf.isPending}>
                          PDF neu
                        </Button>
                      ) : null}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </div>
              </div>

              <div className="kv">
                <div className="k">Datum</div>
                <div className="v mono">{selectedOrder.order_date}</div>
                <div className="k">Kanal</div>
                <div className="v">{optionLabel(CHANNEL_OPTIONS, selectedOrder.channel)}</div>
                <div className="k">Status</div>
                <div className="v">{optionLabel(STATUS_OPTIONS, selectedOrder.status)}</div>
                <div className="k">Käufer</div>
                <div className="v">{selectedOrder.buyer_name}</div>
                <div className="k">Versand</div>
                <div className="v mono">{fmtEur(selectedOrder.shipping_gross_cents)}</div>
                <div className="k">Invoice</div>
                <div className="v">{selectedOrder.invoice_number ? <span className="badge mono">#{selectedOrder.invoice_number}</span> : "—"}</div>
              </div>

              <div className="panel" style={{ padding: 12 }}>
                <div className="panel-title" style={{ fontSize: 13 }}>
                  Positionen
                </div>
                <table className="table" style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>Inventory</th>
                      <th>Typ</th>
                      <th className="numeric">Brutto</th>
                      <th className="numeric">Netto</th>
                      <th className="numeric">USt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedOrder.lines.map((l) => (
                      <tr key={l.id}>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {l.inventory_item_id}
                        </td>
                        <td className="mono">{l.purchase_type}</td>
                        <td className="numeric mono">{fmtEur(l.sale_gross_cents)}</td>
                        <td className="numeric mono">{fmtEur(l.sale_net_cents)}</td>
                        <td className="numeric mono">{fmtEur(l.sale_tax_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {selectedOrder.status === "FINALIZED" ? (
                <details>
                  <summary className="panel-title" style={{ cursor: "pointer" }}>
                    Rückgabe / Korrektur
                  </summary>
                  <div className="stack" style={{ marginTop: 10 }}>
                    <div className="panel" style={{ padding: 12 }}>
                      <div className="panel-title" style={{ fontSize: 13 }}>
                        Bestehende Korrekturen
                      </div>
                      {returns.isFetching ? (
                        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                          Lade…
                        </div>
                      ) : (returns.data ?? []).length ? (
                        <table className="table" style={{ marginTop: 10 }}>
                          <thead>
                            <tr>
                              <th>Nr.</th>
                              <th>Datum</th>
                              <th className="numeric">Brutto</th>
                              <th className="numeric">PDF</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(returns.data ?? []).map((r) => (
                              <tr key={r.id}>
                                <td className="mono">{r.correction_number}</td>
                                <td className="mono">{r.correction_date}</td>
                                <td className="numeric mono">{fmtEur(r.refund_gross_cents + r.shipping_refund_gross_cents)}</td>
                                <td className="numeric">
                                  {r.pdf_path ? (
                                    <Button type="button" size="sm" variant="ghost" onClick={() => api.download(r.pdf_path!, r.pdf_path!.split("/").pop() ?? "korrektur.pdf")}>
                                      <Download size={16} /> PDF
                                    </Button>
                                  ) : (
                                    <Button type="button" size="sm" variant="secondary" onClick={() => generateReturnPdf.mutate({ orderId: selectedOrder.id, correctionId: r.id })} disabled={generateReturnPdf.isPending}>
                                      PDF erstellen
                                    </Button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                          Keine Korrekturen.
                        </div>
                      )}
                    </div>

                    <div className="panel" style={{ padding: 12 }}>
                      <div className="panel-title" style={{ fontSize: 13 }}>
                        Neue Korrektur
                      </div>
                      <div className="stack" style={{ marginTop: 10 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                          <Field label="Datum">
                            <input className="input" type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
                          </Field>
                          <Field label="Zahlungsquelle">
                            <select className="input" value={returnPaymentSource} onChange={(e) => setReturnPaymentSource(e.target.value as PaymentSource)}>
                              {PAYMENT_SOURCE_OPTIONS.map((p) => (
                                <option key={p.value} value={p.value}>
                                  {p.label}
                                </option>
                              ))}
                            </select>
                          </Field>
                          <Field label="Versand-Erstattung (EUR)">
                            <input className="input" value={shippingRefund} onChange={(e) => setShippingRefund(e.target.value)} />
                          </Field>
                        </div>

                        <table className="table">
                          <thead>
                            <tr>
                              <th></th>
                              <th>Item</th>
                              <th>Aktion</th>
                              <th className="numeric">Erstattung brutto</th>
                            </tr>
                          </thead>
                          <tbody>
                            {returnLines.map((l) => {
                              const disabled = correctedItemIds.has(l.inventory_item_id);
                              return (
                                <tr key={l.inventory_item_id}>
                                  <td className="nowrap">
                                    <input
                                      type="checkbox"
                                      checked={l.include && !disabled}
                                      disabled={disabled}
                                      onChange={(e) =>
                                        setReturnLines((s) =>
                                          s.map((x) => (x.inventory_item_id === l.inventory_item_id ? { ...x, include: e.target.checked } : x)),
                                        )
                                      }
                                    />
                                  </td>
                                  <td className="mono" style={{ fontSize: 12 }}>
                                    {l.inventory_item_id}
                                    {disabled ? (
                                      <div className="muted" style={{ fontSize: 12 }}>
                                        bereits korrigiert
                                      </div>
                                    ) : null}
                                  </td>
                                  <td>
                                    <select
                                      className="input"
                                      value={l.action}
                                      onChange={(e) =>
                                        setReturnLines((s) =>
                                          s.map((x) => (x.inventory_item_id === l.inventory_item_id ? { ...x, action: e.target.value as ReturnAction } : x)),
                                        )
                                      }
                                      disabled={disabled}
                                    >
                                      {RETURN_ACTION_OPTIONS.map((a) => (
                                        <option key={a.value} value={a.value}>
                                          {a.label}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                  <td className="numeric">
                                    <input
                                      className="input"
                                      style={{ textAlign: "right" }}
                                      value={l.refund_gross}
                                      onChange={(e) =>
                                        setReturnLines((s) =>
                                          s.map((x) => (x.inventory_item_id === l.inventory_item_id ? { ...x, refund_gross: e.target.value } : x)),
                                        )
                                      }
                                      disabled={disabled}
                                    />
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>

                        <div className="toolbar" style={{ justifyContent: "flex-end" }}>
                          <Button type="button" variant="primary" size="sm" onClick={() => createReturn.mutate()} disabled={createReturn.isPending}>
                            {createReturn.isPending ? "Speichere…" : "Korrektur erstellen"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </details>
              ) : null}
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 13 }}>
              Auftrag auswählen oder „Neu“ starten.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

