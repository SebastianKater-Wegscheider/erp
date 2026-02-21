import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ClipboardCopy, RefreshCw, UploadCloud, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useApi } from "../api/api";
import { fmtEur } from "../lib/money";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { InlineAlert } from "../ui/InlineAlert";

type MarketplaceOrdersImportRowError = {
  row_number: number;
  message: string;
  external_order_id?: string | null;
  sku?: string | null;
};

type MarketplaceOrdersImportOut = {
  batch_id: string;
  total_rows: number;
  staged_orders_count: number;
  staged_lines_count: number;
  ready_orders_count: number;
  needs_attention_orders_count: number;
  skipped_orders_count: number;
  failed_count: number;
  errors: MarketplaceOrdersImportRowError[];
};

type MarketplaceStagedOrderLineOut = {
  id: string;
  sku: string;
  title?: string | null;
  sale_gross_cents: number;
  shipping_gross_cents: number;
  matched_inventory_item_id?: string | null;
  match_strategy: "ITEM_CODE" | "MASTER_SKU_FIFO" | "NONE";
  match_error?: string | null;
};

type MarketplaceStagedOrderOut = {
  id: string;
  batch_id?: string | null;
  channel: "AMAZON" | "EBAY" | "WILLHABEN" | "OTHER";
  external_order_id: string;
  order_date: string;
  buyer_name: string;
  buyer_address?: string | null;
  shipping_gross_cents: number;
  status: "READY" | "NEEDS_ATTENTION" | "APPLIED";
  sales_order_id?: string | null;
  lines: MarketplaceStagedOrderLineOut[];
};

type MarketplaceStagedOrderApplyOut = {
  results: Array<{
    staged_order_id: string;
    sales_order_id?: string | null;
    ok: boolean;
    error?: string | null;
  }>;
};

type MarketplacePayoutOut = {
  id: string;
  channel: "AMAZON" | "EBAY" | "WILLHABEN" | "OTHER";
  external_payout_id: string;
  payout_date: string;
  net_amount_cents: number;
  ledger_entry_id?: string | null;
};

type MarketplacePayoutImportOut = {
  total_rows: number;
  imported_count: number;
  skipped_count: number;
  failed_count: number;
  errors: Array<{ row_number: number; message: string; external_payout_id?: string | null }>;
};

type InventoryMatchCandidate = {
  id: string;
  item_code: string;
  master_product_id: string;
  purchase_price_cents: number;
  status: string;
};

const STAGED_STATUS_LABEL: Record<MarketplaceStagedOrderOut["status"], string> = {
  READY: "READY",
  NEEDS_ATTENTION: "Prüfen",
  APPLIED: "Übernommen",
};

const MATCH_STRATEGY_LABEL: Record<MarketplaceStagedOrderLineOut["match_strategy"], string> = {
  ITEM_CODE: "IT- Code",
  MASTER_SKU_FIFO: "MP FIFO",
  NONE: "Keine",
};

function countUnmatched(order: MarketplaceStagedOrderOut): number {
  return order.lines.filter((l) => !l.matched_inventory_item_id).length;
}

function badgeClassForStatus(status: MarketplaceStagedOrderOut["status"]): string {
  if (status === "READY") return "badge badge--ok";
  if (status === "APPLIED") return "badge";
  return "badge badge--danger";
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function MarketplacePage() {
  const api = useApi();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as any) ?? "orders";

  const [message, setMessage] = useState<string | null>(null);

  const [ordersCsv, setOrdersCsv] = useState("");
  const [ordersDelimiter, setOrdersDelimiter] = useState<string>("");
  const [ordersSourceLabel, setOrdersSourceLabel] = useState<string>("");
  const [ordersFilename, setOrdersFilename] = useState<string>("");
  const [lastOrdersBatchId, setLastOrdersBatchId] = useState<string | null>(null);
  const [ordersImportOut, setOrdersImportOut] = useState<MarketplaceOrdersImportOut | null>(null);
  const [applyOut, setApplyOut] = useState<MarketplaceStagedOrderApplyOut | null>(null);

  const [reviewStatus, setReviewStatus] = useState<string>("ALL");
  const [reviewQuery, setReviewQuery] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  const [overrideTarget, setOverrideTarget] = useState<{ stagedOrderId: string; stagedLineId: string; sku: string } | null>(null);
  const [overrideSearch, setOverrideSearch] = useState("");
  const overrideSearchTrimmed = overrideSearch.trim();

  const importOrders = useMutation({
    mutationFn: () =>
      api.request<MarketplaceOrdersImportOut>("/marketplace/imports/orders", {
        method: "POST",
        json: {
          csv_text: ordersCsv,
          delimiter: ordersDelimiter.trim() ? ordersDelimiter.trim() : null,
          source_label: ordersSourceLabel.trim() ? ordersSourceLabel.trim() : null,
        },
      }),
    onSuccess: async (out) => {
      setOrdersImportOut(out);
      setLastOrdersBatchId(out.batch_id);
      setApplyOut(null);
      setSelectedOrderId(null);
      setOverrideTarget(null);
      setOverrideSearch("");
      await qc.invalidateQueries({ queryKey: ["marketplace-staged-orders"] });
      setMessage(`Import OK: Batch ${out.batch_id}`);
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", "review");
        return next;
      });
    },
  });

  const stagedOrders = useQuery({
    queryKey: ["marketplace-staged-orders", reviewStatus, lastOrdersBatchId, reviewQuery],
    enabled: tab !== "payouts",
    queryFn: () => {
      const usp = new URLSearchParams();
      if (reviewStatus !== "ALL") usp.set("status", reviewStatus);
      if (lastOrdersBatchId) usp.set("batch_id", lastOrdersBatchId);
      if (reviewQuery.trim()) usp.set("q", reviewQuery.trim());
      const q = usp.toString();
      return api.request<MarketplaceStagedOrderOut[]>(`/marketplace/staged-orders${q ? `?${q}` : ""}`);
    },
  });

  const selectedOrder = useMemo(() => {
    const orders = stagedOrders.data ?? [];
    return orders.find((o) => o.id === selectedOrderId) ?? null;
  }, [stagedOrders.data, selectedOrderId]);

  const overrideCandidates = useQuery({
    queryKey: ["marketplace-override-candidates", overrideSearchTrimmed],
    enabled: Boolean(overrideTarget) && overrideSearchTrimmed.length >= 2,
    queryFn: () =>
      api.request<InventoryMatchCandidate[]>(
        `/inventory?status=AVAILABLE&limit=30&offset=0&q=${encodeURIComponent(overrideSearchTrimmed)}`,
      ),
  });

  const overrideMatch = useMutation({
    mutationFn: (inventoryItemId: string) => {
      if (!overrideTarget) throw new Error("Kein Override-Ziel ausgewählt");
      return api.request<MarketplaceStagedOrderOut>(
        `/marketplace/staged-orders/${overrideTarget.stagedOrderId}/lines/${overrideTarget.stagedLineId}/override`,
        {
          method: "POST",
          json: { inventory_item_id: inventoryItemId },
        },
      );
    },
    onSuccess: async (updatedOrder) => {
      setSelectedOrderId(updatedOrder.id);
      setOverrideTarget(null);
      setOverrideSearch("");
      await qc.invalidateQueries({ queryKey: ["marketplace-staged-orders"] });
      await qc.invalidateQueries({ queryKey: ["inventory"] });
      setMessage("Zuordnung gespeichert.");
    },
  });

  const applyReady = useMutation({
    mutationFn: () => {
      if (!lastOrdersBatchId) throw new Error("Kein Import-Batch ausgewählt");
      return api.request<MarketplaceStagedOrderApplyOut>("/marketplace/staged-orders/apply", {
        method: "POST",
        json: { batch_id: lastOrdersBatchId },
      });
    },
    onSuccess: async (out) => {
      setApplyOut(out);
      await qc.invalidateQueries({ queryKey: ["marketplace-staged-orders"] });
      await qc.invalidateQueries({ queryKey: ["sales"] });
      await qc.invalidateQueries({ queryKey: ["inventory"] });
      setMessage("READY Bestellungen übernommen.");
    },
  });

  const applySingle = useMutation({
    mutationFn: (stagedOrderId: string) =>
      api.request<MarketplaceStagedOrderApplyOut>("/marketplace/staged-orders/apply", {
        method: "POST",
        json: { staged_order_ids: [stagedOrderId] },
      }),
    onSuccess: async (out) => {
      setApplyOut(out);
      await qc.invalidateQueries({ queryKey: ["marketplace-staged-orders"] });
      await qc.invalidateQueries({ queryKey: ["sales"] });
      await qc.invalidateQueries({ queryKey: ["inventory"] });
      setMessage("Bestellung übernommen.");
    },
  });

  const [payoutsCsv, setPayoutsCsv] = useState("");
  const [payoutsDelimiter, setPayoutsDelimiter] = useState<string>("");
  const [payoutsFilename, setPayoutsFilename] = useState<string>("");
  const [payoutsImportOut, setPayoutsImportOut] = useState<MarketplacePayoutImportOut | null>(null);

  const payouts = useQuery({
    queryKey: ["marketplace-payouts"],
    enabled: tab === "payouts",
    queryFn: () => api.request<MarketplacePayoutOut[]>("/marketplace/payouts"),
  });

  const importPayouts = useMutation({
    mutationFn: () =>
      api.request<MarketplacePayoutImportOut>("/marketplace/imports/payouts", {
        method: "POST",
        json: {
          csv_text: payoutsCsv,
          delimiter: payoutsDelimiter.trim() ? payoutsDelimiter.trim() : null,
        },
      }),
    onSuccess: async (out) => {
      setPayoutsImportOut(out);
      await qc.invalidateQueries({ queryKey: ["marketplace-payouts"] });
      setMessage("Auszahlungen importiert.");
    },
  });

  const stagedOrderRows = stagedOrders.data ?? [];
  const sortedCandidates = (overrideCandidates.data ?? []).slice().sort((a, b) => a.item_code.localeCompare(b.item_code));

  const errors = [
    importOrders.isError ? (importOrders.error as Error) : null,
    stagedOrders.isError ? (stagedOrders.error as Error) : null,
    applyReady.isError ? (applyReady.error as Error) : null,
    applySingle.isError ? (applySingle.error as Error) : null,
    overrideMatch.isError ? (overrideMatch.error as Error) : null,
    payouts.isError ? (payouts.error as Error) : null,
    importPayouts.isError ? (importPayouts.error as Error) : null,
  ].filter(Boolean) as Error[];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Marktplatz</div>
          <div className="page-subtitle">CSV Import → Review/Override → Apply → Payouts.</div>
        </div>
        <div className="page-actions">
          <Button
            size="sm"
            variant={tab === "orders" ? "primary" : "secondary"}
            onClick={() =>
              setParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set("tab", "orders");
                return next;
              })
            }
          >
            Orders Import
          </Button>
          <Button
            size="sm"
            variant={tab === "review" ? "primary" : "secondary"}
            onClick={() =>
              setParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set("tab", "review");
                return next;
              })
            }
          >
            Review
          </Button>
          <Button
            size="sm"
            variant={tab === "apply" ? "primary" : "secondary"}
            onClick={() =>
              setParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set("tab", "apply");
                return next;
              })
            }
          >
            Apply
          </Button>
          <Button
            size="sm"
            variant={tab === "payouts" ? "primary" : "secondary"}
            onClick={() =>
              setParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set("tab", "payouts");
                return next;
              })
            }
          >
            Payouts
          </Button>
        </div>
      </div>

      {message ? (
        <InlineAlert tone="info" onDismiss={() => setMessage(null)}>
          {message}
        </InlineAlert>
      ) : null}

      {errors.length ? <InlineAlert tone="error">{errors[0].message}</InlineAlert> : null}

      {tab === "orders" ? (
        <div className="split" style={{ gridTemplateColumns: "1fr 420px" }}>
          <div className="panel">
            <div className="panel-title">Bestellungen importieren (CSV)</div>
            <div className="panel-sub">Eine Zeile pro verkaufter Einheit. SKU bevorzugt: `IT-…`.</div>

            <div className="stack" style={{ marginTop: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: 10 }}>
                <Field label="Quelle (optional)">
                  <input className="input" value={ordersSourceLabel} onChange={(e) => setOrdersSourceLabel(e.target.value)} placeholder="z.B. Amazon export 2026-02-01" />
                </Field>
                <Field label="Trennzeichen (optional)">
                  <input className="input" value={ordersDelimiter} onChange={(e) => setOrdersDelimiter(e.target.value)} placeholder="z.B. , oder ;" />
                </Field>
              </div>

              <div className="toolbar" style={{ justifyContent: "space-between" }}>
                <label className="btn btn--secondary btn--sm" style={{ cursor: "pointer" }}>
                  <input
                    type="file"
                    style={{ display: "none" }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      setOrdersFilename(f.name);
                      setOrdersCsv(await f.text());
                      e.currentTarget.value = "";
                    }}
                  />
                  <UploadCloud size={16} /> Datei wählen
                </label>
                <div className="muted" style={{ fontSize: 12 }}>
                  {ordersFilename || "Keine Datei ausgewählt"}
                </div>
              </div>

              <textarea
                value={ordersCsv}
                onChange={(e) => setOrdersCsv(e.target.value)}
                placeholder={[
                  "channel,external_order_id,order_date,sku,sale_gross_eur,shipping_gross_eur",
                  "AMAZON,AO-1,2026-02-01,IT-3F2504E04F89,29.99,0",
                ].join("\n")}
                className="input mono"
                style={{ minHeight: 260 }}
              />

              <div className="toolbar" style={{ justifyContent: "space-between" }}>
                <Button type="button" variant="primary" size="sm" onClick={() => importOrders.mutate()} disabled={!ordersCsv.trim() || importOrders.isPending}>
                  <UploadCloud size={16} /> {importOrders.isPending ? "Import…" : "Importieren"}
                </Button>

                {ordersImportOut?.batch_id ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      await copyText(ordersImportOut.batch_id);
                      setMessage("Batch ID kopiert.");
                    }}
                  >
                    <ClipboardCopy size={16} /> Batch ID
                  </Button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">Ergebnis</div>
            <div className="panel-sub">READY kann direkt übernommen werden.</div>
            {!ordersImportOut ? (
              <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                Noch kein Import.
              </div>
            ) : (
              <div className="stack" style={{ marginTop: 12, gap: 10 }}>
                <div className="kv">
                  <div className="k">Batch</div>
                  <div className="v mono">{ordersImportOut.batch_id}</div>
                  <div className="k">Zeilen</div>
                  <div className="v mono">{ordersImportOut.total_rows}</div>
                  <div className="k">Orders</div>
                  <div className="v mono">{ordersImportOut.staged_orders_count}</div>
                  <div className="k">Lines</div>
                  <div className="v mono">{ordersImportOut.staged_lines_count}</div>
                  <div className="k">READY</div>
                  <div className="v mono">{ordersImportOut.ready_orders_count}</div>
                  <div className="k">Prüfen</div>
                  <div className="v mono">{ordersImportOut.needs_attention_orders_count}</div>
                  <div className="k">Übersprungen</div>
                  <div className="v mono">{ordersImportOut.skipped_orders_count}</div>
                  <div className="k">Fehler</div>
                  <div className="v mono">{ordersImportOut.failed_count}</div>
                </div>

                {ordersImportOut.errors.length ? (
                  <details>
                    <summary className="panel-title" style={{ cursor: "pointer" }}>
                      CSV Fehler ({ordersImportOut.errors.length})
                    </summary>
                    <table className="table" style={{ marginTop: 10 }}>
                      <thead>
                        <tr>
                          <th className="numeric">Zeile</th>
                          <th>Meldung</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ordersImportOut.errors.slice(0, 50).map((e) => (
                          <tr key={`${e.row_number}-${e.message}`}>
                            <td className="numeric mono">{e.row_number}</td>
                            <td style={{ fontSize: 12 }}>{e.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {tab === "review" ? (
        <div className="split" style={{ gridTemplateColumns: "1fr 520px" }}>
          <div className="panel">
            <div className="toolbar" style={{ marginBottom: 10 }}>
              <select className="input" style={{ width: 180 }} value={reviewStatus} onChange={(e) => setReviewStatus(e.target.value)}>
                <option value="ALL">ALL</option>
                <option value="READY">READY</option>
                <option value="NEEDS_ATTENTION">PRÜFEN</option>
                <option value="APPLIED">ÜBERNOMMEN</option>
              </select>
              <input className="input" placeholder="Batch ID (optional)" value={lastOrdersBatchId ?? ""} onChange={(e) => setLastOrdersBatchId(e.target.value.trim() || null)} />
              <input className="input" placeholder="Suche (external_order_id)" value={reviewQuery} onChange={(e) => setReviewQuery(e.target.value)} />
              <div className="toolbar-spacer" />
              <Button variant="secondary" size="sm" onClick={() => stagedOrders.refetch()} disabled={stagedOrders.isFetching}>
                <RefreshCw size={16} /> Refresh
              </Button>
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>Datum</th>
                  <th>Kanal</th>
                  <th>Externe ID</th>
                  <th>Status</th>
                  <th className="numeric">Lines</th>
                  <th className="numeric">No Match</th>
                </tr>
              </thead>
              <tbody>
                {stagedOrderRows.map((o) => (
                  <tr
                    key={o.id}
                    style={{ cursor: "pointer", background: o.id === selectedOrderId ? "var(--surface-2)" : undefined }}
                    onClick={() => setSelectedOrderId(o.id)}
                  >
                    <td className="mono nowrap">{o.order_date}</td>
                    <td className="mono">{o.channel}</td>
                    <td className="mono">{o.external_order_id}</td>
                    <td>
                      <span className={badgeClassForStatus(o.status)}>{STAGED_STATUS_LABEL[o.status]}</span>
                    </td>
                    <td className="numeric mono">{o.lines.length}</td>
                    <td className="numeric mono">{countUnmatched(o)}</td>
                  </tr>
                ))}
                {stagedOrders.isFetching ? (
                  <tr>
                    <td colSpan={6} className="muted">
                      Lade…
                    </td>
                  </tr>
                ) : null}
                {!stagedOrders.isFetching && !stagedOrderRows.length ? (
                  <tr>
                    <td colSpan={6} className="muted">
                      Keine Bestellungen gefunden.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="panel">
            {!selectedOrder ? (
              <div className="muted" style={{ fontSize: 13 }}>
                Bestellung auswählen.
              </div>
            ) : (
              <div className="stack">
                <div className="toolbar" style={{ justifyContent: "space-between" }}>
                  <div>
                    <div className="panel-title">Bestellung</div>
                    <div className="panel-sub mono">
                      {selectedOrder.channel} {selectedOrder.external_order_id} ({selectedOrder.order_date})
                    </div>
                  </div>
                  <div className="toolbar">
                    {selectedOrder.status === "READY" ? (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => applySingle.mutate(selectedOrder.id)}
                        disabled={applySingle.isPending}
                      >
                        {applySingle.isPending ? "Apply…" : "Apply"}
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div className="kv">
                  <div className="k">Buyer</div>
                  <div className="v">{selectedOrder.buyer_name}</div>
                  <div className="k">Address</div>
                  <div className="v">{selectedOrder.buyer_address ?? "—"}</div>
                  <div className="k">Shipping</div>
                  <div className="v mono">{fmtEur(selectedOrder.shipping_gross_cents)}</div>
                  <div className="k">Status</div>
                  <div className="v">
                    <span className={badgeClassForStatus(selectedOrder.status)}>{STAGED_STATUS_LABEL[selectedOrder.status]}</span>
                  </div>
                </div>

                <table className="table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Titel</th>
                      <th className="numeric">Verkauf</th>
                      <th>Match</th>
                      <th>Inventory</th>
                      <th className="numeric"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedOrder.lines.map((l) => (
                      <tr key={l.id}>
                        <td className="mono">{l.sku}</td>
                        <td style={{ fontSize: 12 }}>{l.title ?? ""}</td>
                        <td className="numeric mono">{fmtEur(l.sale_gross_cents)}</td>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {MATCH_STRATEGY_LABEL[l.match_strategy]}
                          {l.match_error ? <div style={{ color: "var(--danger)", fontSize: 12 }}>{l.match_error}</div> : null}
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {l.matched_inventory_item_id ?? "—"}
                        </td>
                        <td className="numeric">
                          {!l.matched_inventory_item_id && selectedOrder.status !== "APPLIED" ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setOverrideSearch(l.sku.startsWith("IT-") ? l.sku : "");
                                setOverrideTarget({ stagedOrderId: selectedOrder.id, stagedLineId: l.id, sku: l.sku });
                              }}
                            >
                              Override
                            </Button>
                          ) : (
                            <span className="muted" style={{ fontSize: 12 }}>
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {overrideTarget ? (
                  <div className="panel" style={{ padding: 12 }}>
                    <div className="panel-title" style={{ fontSize: 13 }}>
                      Override: <span className="mono">{overrideTarget.sku}</span>
                    </div>
                    <div className="stack" style={{ marginTop: 10 }}>
                      <div className="toolbar">
                        <input
                          className="input"
                          placeholder="Inventory Suche (IT-…, SKU, Titel, …)"
                          value={overrideSearch}
                          onChange={(e) => setOverrideSearch(e.target.value)}
                        />
                        <Button size="sm" variant="ghost" onClick={() => setOverrideTarget(null)}>
                          Abbrechen
                        </Button>
                      </div>
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Item</th>
                            <th className="numeric">EK</th>
                            <th className="numeric"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {!overrideSearchTrimmed || overrideSearchTrimmed.length < 2 ? (
                            <tr>
                              <td colSpan={3} className="muted">
                                Mindestens 2 Zeichen suchen.
                              </td>
                            </tr>
                          ) : null}
                          {sortedCandidates.map((c) => (
                            <tr key={c.id}>
                              <td className="mono">{c.item_code}</td>
                              <td className="numeric mono">{fmtEur(c.purchase_price_cents)}</td>
                              <td className="numeric">
                                <Button size="sm" variant="primary" onClick={() => overrideMatch.mutate(c.id)} disabled={overrideMatch.isPending}>
                                  Match
                                </Button>
                              </td>
                            </tr>
                          ))}
                          {overrideCandidates.isFetching ? (
                            <tr>
                              <td colSpan={3} className="muted">
                                Lade…
                              </td>
                            </tr>
                          ) : null}
                          {!overrideCandidates.isFetching && overrideSearchTrimmed.length >= 2 && !sortedCandidates.length ? (
                            <tr>
                              <td colSpan={3} className="muted">
                                Keine Treffer.
                              </td>
                            </tr>
                          ) : null}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {tab === "apply" ? (
        <div className="panel">
          <div className="toolbar" style={{ justifyContent: "space-between" }}>
            <div>
              <div className="panel-title">READY übernehmen</div>
              <div className="panel-sub">Batch ID: <span className="mono">{lastOrdersBatchId ?? "—"}</span></div>
            </div>
            <div className="toolbar">
              <Button size="sm" variant="secondary" onClick={() => stagedOrders.refetch()} disabled={stagedOrders.isFetching}>
                <RefreshCw size={16} /> Refresh
              </Button>
              <Button size="sm" variant="primary" onClick={() => applyReady.mutate()} disabled={!lastOrdersBatchId || applyReady.isPending}>
                {applyReady.isPending ? "Apply…" : "Apply READY"}
              </Button>
            </div>
          </div>

          {ordersImportOut ? (
            <div className="kv" style={{ marginTop: 12 }}>
              <div className="k">READY</div>
              <div className="v mono">{ordersImportOut.ready_orders_count}</div>
              <div className="k">Prüfen</div>
              <div className="v mono">{ordersImportOut.needs_attention_orders_count}</div>
              <div className="k">Orders</div>
              <div className="v mono">{ordersImportOut.staged_orders_count}</div>
              <div className="k">Lines</div>
              <div className="v mono">{ordersImportOut.staged_lines_count}</div>
            </div>
          ) : null}

          {applyOut ? (
            <div className="panel" style={{ padding: 12, marginTop: 12 }}>
              <div className="panel-title" style={{ fontSize: 13 }}>
                Ergebnis
              </div>
              <table className="table" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Staged</th>
                    <th>Sales</th>
                    <th>Status</th>
                    <th>Fehler</th>
                    <th className="numeric"></th>
                  </tr>
                </thead>
                <tbody>
                  {applyOut.results.map((r) => (
                    <tr key={r.staged_order_id}>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {r.staged_order_id}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {r.sales_order_id ?? "—"}
                      </td>
                      <td>
                        {r.ok ? (
                          <span className="badge badge--ok">
                            <CheckCircle2 size={14} style={{ marginRight: 6 }} /> OK
                          </span>
                        ) : (
                          <span className="badge badge--danger">
                            <XCircle size={14} style={{ marginRight: 6 }} /> FAIL
                          </span>
                        )}
                      </td>
                      <td style={{ fontSize: 12, color: r.ok ? "var(--muted)" : "var(--danger)" }}>{r.error ?? "—"}</td>
                      <td className="numeric">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            await copyText(r.sales_order_id ?? "");
                            setMessage("Sales ID kopiert.");
                          }}
                          disabled={!r.sales_order_id}
                        >
                          <ClipboardCopy size={16} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === "payouts" ? (
        <div className="split" style={{ gridTemplateColumns: "1fr 520px" }}>
          <div className="panel">
            <div className="panel-title">Auszahlungen importieren (CSV)</div>
            <div className="panel-sub">Header: channel,external_payout_id,payout_date,net_amount_eur</div>
            <div className="stack" style={{ marginTop: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: 10 }}>
                <Field label="Trennzeichen (optional)">
                  <input className="input" value={payoutsDelimiter} onChange={(e) => setPayoutsDelimiter(e.target.value)} placeholder="z.B. , oder ;" />
                </Field>
                <div />
              </div>

              <div className="toolbar" style={{ justifyContent: "space-between" }}>
                <label className="btn btn--secondary btn--sm" style={{ cursor: "pointer" }}>
                  <input
                    type="file"
                    style={{ display: "none" }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      setPayoutsFilename(f.name);
                      setPayoutsCsv(await f.text());
                      e.currentTarget.value = "";
                    }}
                  />
                  <UploadCloud size={16} /> Datei wählen
                </label>
                <div className="muted" style={{ fontSize: 12 }}>
                  {payoutsFilename || "Keine Datei ausgewählt"}
                </div>
              </div>

              <textarea
                value={payoutsCsv}
                onChange={(e) => setPayoutsCsv(e.target.value)}
                placeholder={[
                  "channel,external_payout_id,payout_date,net_amount_eur",
                  "AMAZON,PO-1,2026-02-01,123.45",
                ].join("\n")}
                className="input mono"
                style={{ minHeight: 220 }}
              />

              <div className="toolbar" style={{ justifyContent: "space-between" }}>
                <Button type="button" variant="primary" size="sm" onClick={() => importPayouts.mutate()} disabled={!payoutsCsv.trim() || importPayouts.isPending}>
                  <UploadCloud size={16} /> {importPayouts.isPending ? "Import…" : "Importieren"}
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={() => payouts.refetch()} disabled={payouts.isFetching}>
                  <RefreshCw size={16} /> Refresh
                </Button>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">Payouts</div>
            <div className="panel-sub">{payouts.isFetching ? "Lade…" : `${(payouts.data ?? []).length} Einträge`}</div>
            <table className="table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Datum</th>
                  <th>Kanal</th>
                  <th>Externe ID</th>
                  <th className="numeric">Netto</th>
                </tr>
              </thead>
              <tbody>
                {(payouts.data ?? []).map((p) => (
                  <tr key={p.id}>
                    <td className="mono nowrap">{p.payout_date}</td>
                    <td className="mono">{p.channel}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {p.external_payout_id}
                    </td>
                    <td className="numeric mono">{fmtEur(p.net_amount_cents)}</td>
                  </tr>
                ))}
                {!payouts.isFetching && !(payouts.data ?? []).length ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      Keine Daten.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>

            {payoutsImportOut ? (
              <div className="panel" style={{ padding: 12, marginTop: 12 }}>
                <div className="panel-title" style={{ fontSize: 13 }}>
                  Import Ergebnis
                </div>
                <div className="kv" style={{ marginTop: 10 }}>
                  <div className="k">Zeilen</div>
                  <div className="v mono">{payoutsImportOut.total_rows}</div>
                  <div className="k">Importiert</div>
                  <div className="v mono">{payoutsImportOut.imported_count}</div>
                  <div className="k">Übersprungen</div>
                  <div className="v mono">{payoutsImportOut.skipped_count}</div>
                  <div className="k">Fehler</div>
                  <div className="v mono">{payoutsImportOut.failed_count}</div>
                </div>

                {payoutsImportOut.errors.length ? (
                  <details style={{ marginTop: 10 }}>
                    <summary className="panel-title" style={{ cursor: "pointer" }}>
                      Fehler ({payoutsImportOut.errors.length})
                    </summary>
                    <table className="table" style={{ marginTop: 10 }}>
                      <thead>
                        <tr>
                          <th className="numeric">Zeile</th>
                          <th>Meldung</th>
                        </tr>
                      </thead>
                      <tbody>
                        {payoutsImportOut.errors.slice(0, 50).map((e) => (
                          <tr key={`${e.row_number}-${e.message}`}>
                            <td className="numeric mono">{e.row_number}</td>
                            <td style={{ fontSize: 12 }}>{e.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
