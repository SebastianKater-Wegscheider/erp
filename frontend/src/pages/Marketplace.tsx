import { CheckCircle2, ClipboardCopy, FileText, RefreshCw, Upload, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { formatEur } from "../lib/money";
import { useApi } from "../lib/api";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { InlineMessage } from "../components/ui/inline-message";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PageHeader } from "../components/ui/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";

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

const STAGED_STATUS_LABEL: Record<MarketplaceStagedOrderOut["status"], string> = {
  READY: "READY",
  NEEDS_ATTENTION: "Needs attention",
  APPLIED: "Applied",
};

const MATCH_STRATEGY_LABEL: Record<MarketplaceStagedOrderLineOut["match_strategy"], string> = {
  ITEM_CODE: "IT- Code",
  MASTER_SKU_FIFO: "MP FIFO",
  NONE: "None",
};

function countUnmatched(order: MarketplaceStagedOrderOut): number {
  return order.lines.filter((l) => !l.matched_inventory_item_id).length;
}

function badgeForStatus(status: MarketplaceStagedOrderOut["status"]): "secondary" | "success" | "danger" {
  if (status === "READY") return "success";
  if (status === "APPLIED") return "secondary";
  return "danger";
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

  const [tab, setTab] = useState("orders");

  const [ordersCsv, setOrdersCsv] = useState("");
  const [ordersDelimiter, setOrdersDelimiter] = useState<string>("");
  const [ordersSourceLabel, setOrdersSourceLabel] = useState<string>("");
  const [lastOrdersBatchId, setLastOrdersBatchId] = useState<string | null>(null);
  const [ordersImportOut, setOrdersImportOut] = useState<MarketplaceOrdersImportOut | null>(null);

  const [reviewStatus, setReviewStatus] = useState<string>("ALL");
  const [reviewQuery, setReviewQuery] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  const [applyOut, setApplyOut] = useState<MarketplaceStagedOrderApplyOut | null>(null);

  const [payoutsCsv, setPayoutsCsv] = useState("");
  const [payoutsDelimiter, setPayoutsDelimiter] = useState<string>("");
  const [payoutsImportOut, setPayoutsImportOut] = useState<MarketplacePayoutImportOut | null>(null);

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
      await qc.invalidateQueries({ queryKey: ["marketplace-staged-orders"] });
    },
  });

  const stagedOrders = useQuery({
    queryKey: ["marketplace-staged-orders", reviewStatus, lastOrdersBatchId, reviewQuery],
    enabled: tab !== "payouts",
    queryFn: () => {
      const params = new URLSearchParams();
      if (reviewStatus !== "ALL") params.set("status", reviewStatus);
      if (lastOrdersBatchId) params.set("batch_id", lastOrdersBatchId);
      if (reviewQuery.trim()) params.set("q", reviewQuery.trim());
      const q = params.toString();
      return api.request<MarketplaceStagedOrderOut[]>(`/marketplace/staged-orders${q ? `?${q}` : ""}`);
    },
  });

  const selectedOrder = useMemo(() => {
    const orders = stagedOrders.data ?? [];
    return orders.find((o) => o.id === selectedOrderId) ?? null;
  }, [stagedOrders.data, selectedOrderId]);

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
    },
  });

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
    },
  });

  const stagedOrderRows = stagedOrders.data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader title="Marketplace" description="Amazon/eBay Import (CSV) mit SKU-basierendem Auto-Matching (IT-/MP-...)." />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="review">Review</TabsTrigger>
          <TabsTrigger value="apply">Apply</TabsTrigger>
          <TabsTrigger value="payouts">Payouts</TabsTrigger>
        </TabsList>

        <TabsContent value="orders">
          <div className="grid gap-4 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Upload className="h-5 w-5" />
                  Import Orders (CSV)
                </CardTitle>
                <CardDescription>Eine Zeile pro verkaufter Einheit. SKU bevorzugt: `IT-...`.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Quelle (optional)</Label>
                    <Input value={ordersSourceLabel} onChange={(e) => setOrdersSourceLabel(e.target.value)} placeholder="z.B. Amazon export 2026-02-01" />
                  </div>
                  <div className="space-y-2">
                    <Label>Delimiter (optional)</Label>
                    <Input value={ordersDelimiter} onChange={(e) => setOrdersDelimiter(e.target.value)} placeholder="z.B. , oder ;" />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <Label>CSV</Label>
                    <Input
                      type="file"
                      className="max-w-xs"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        setOrdersCsv(await f.text());
                        e.currentTarget.value = "";
                      }}
                    />
                  </div>
                  <textarea
                    value={ordersCsv}
                    onChange={(e) => setOrdersCsv(e.target.value)}
                    placeholder={[
                      "channel,external_order_id,order_date,sku,sale_gross_eur,shipping_gross_eur",
                      "AMAZON,AO-1,2026-02-01,IT-3F2504E04F89,29.99,0",
                    ].join("\n")}
                    className="min-h-[240px] w-full rounded-lg border border-[color:var(--app-border)] bg-[color:var(--app-surface)] p-3 font-mono text-xs text-[color:var(--app-text)] shadow-sm"
                  />
                </div>

                {(importOrders.isError || stagedOrders.isError) && (
                  <InlineMessage tone="error">{((importOrders.error ?? stagedOrders.error) as Error).message}</InlineMessage>
                )}

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <Button
                    type="button"
                    onClick={() => importOrders.mutate()}
                    disabled={importOrders.isPending || !ordersCsv.trim()}
                  >
                    <Upload className="h-4 w-4" />
                    Import
                  </Button>

                  {ordersImportOut?.batch_id && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={async () => {
                        await copyText(ordersImportOut.batch_id);
                      }}
                    >
                      <ClipboardCopy className="h-4 w-4" />
                      Batch ID kopieren
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  Ergebnis
                </CardTitle>
                <CardDescription>READY Orders koennen direkt angewendet werden.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {!ordersImportOut && <div className="text-sm text-[color:var(--app-text-muted)]">Noch kein Import.</div>}
                {ordersImportOut && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="text-[color:var(--app-text-muted)]">Rows</div>
                      <div className="text-right font-semibold">{ordersImportOut.total_rows}</div>
                      <div className="text-[color:var(--app-text-muted)]">Orders staged</div>
                      <div className="text-right font-semibold">{ordersImportOut.staged_orders_count}</div>
                      <div className="text-[color:var(--app-text-muted)]">Lines staged</div>
                      <div className="text-right font-semibold">{ordersImportOut.staged_lines_count}</div>
                      <div className="text-[color:var(--app-text-muted)]">READY</div>
                      <div className="text-right font-semibold text-emerald-700 dark:text-emerald-300">
                        {ordersImportOut.ready_orders_count}
                      </div>
                      <div className="text-[color:var(--app-text-muted)]">Needs attention</div>
                      <div className="text-right font-semibold text-rose-700 dark:text-rose-300">
                        {ordersImportOut.needs_attention_orders_count}
                      </div>
                      <div className="text-[color:var(--app-text-muted)]">Skipped</div>
                      <div className="text-right font-semibold">{ordersImportOut.skipped_orders_count}</div>
                      <div className="text-[color:var(--app-text-muted)]">Row errors</div>
                      <div className="text-right font-semibold">{ordersImportOut.failed_count}</div>
                    </div>

                    {!!ordersImportOut.errors.length && (
                      <div className="space-y-2">
                        <div className="text-sm font-semibold">CSV Fehler</div>
                        <div className="max-h-48 overflow-auto rounded-lg border border-[color:var(--app-border)] bg-[color:var(--app-surface)]">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-16">Row</TableHead>
                                <TableHead>Message</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {ordersImportOut.errors.map((e) => (
                                <TableRow key={`${e.row_number}-${e.message}`}>
                                  <TableCell className="font-mono text-xs">{e.row_number}</TableCell>
                                  <TableCell className="text-xs">{e.message}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="review">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-3">
                <span>Staged Orders</span>
                <Button type="button" variant="outline" onClick={() => stagedOrders.refetch()} disabled={stagedOrders.isFetching}>
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </Button>
              </CardTitle>
              <CardDescription>Detailansicht zeigt Matching pro Line. Unmatched Lines verursachen NEEDS_ATTENTION.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select value={reviewStatus} onValueChange={setReviewStatus}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">ALL</SelectItem>
                      <SelectItem value="READY">READY</SelectItem>
                      <SelectItem value="NEEDS_ATTENTION">NEEDS_ATTENTION</SelectItem>
                      <SelectItem value="APPLIED">APPLIED</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label>Suche</Label>
                  <Input value={reviewQuery} onChange={(e) => setReviewQuery(e.target.value)} placeholder="external_order_id" />
                </div>
              </div>

              {stagedOrders.isError && <InlineMessage tone="error">{(stagedOrders.error as Error).message}</InlineMessage>}
              {!stagedOrders.isLoading && !stagedOrderRows.length && (
                <div className="text-sm text-[color:var(--app-text-muted)]">Keine Orders gefunden.</div>
              )}

              {!!stagedOrderRows.length && (
                <div className="overflow-auto rounded-lg border border-[color:var(--app-border)] bg-[color:var(--app-surface)]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Channel</TableHead>
                        <TableHead>External ID</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Lines</TableHead>
                        <TableHead className="text-right">Unmatched</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {stagedOrderRows.map((o) => (
                        <TableRow
                          key={o.id}
                          className="cursor-pointer hover:bg-[color:color-mix(in_oklab,var(--app-primary-soft)_55%,transparent)]"
                          onClick={() => setSelectedOrderId(o.id)}
                        >
                          <TableCell className="font-mono text-xs">{o.order_date}</TableCell>
                          <TableCell className="font-mono text-xs">{o.channel}</TableCell>
                          <TableCell className="font-mono text-xs">{o.external_order_id}</TableCell>
                          <TableCell>
                            <Badge variant={badgeForStatus(o.status)} className="font-mono text-[11px]">
                              {STAGED_STATUS_LABEL[o.status]}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">{o.lines.length}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{countUnmatched(o)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <Dialog
            open={!!selectedOrderId}
            onOpenChange={(open) => {
              if (!open) setSelectedOrderId(null);
            }}
          >
            <DialogContent className="max-w-4xl">
              <DialogHeader>
                <DialogTitle>Order Details</DialogTitle>
                <DialogDescription className="font-mono text-xs">
                  {selectedOrder ? `${selectedOrder.channel} ${selectedOrder.external_order_id} (${selectedOrder.order_date})` : ""}
                </DialogDescription>
              </DialogHeader>

              {!selectedOrder && <div className="text-sm text-[color:var(--app-text-muted)]">Nicht gefunden.</div>}
              {selectedOrder && (
                <div className="space-y-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="rounded-lg border border-[color:var(--app-border)] bg-[color:var(--app-surface)] p-3">
                      <div className="text-xs text-[color:var(--app-text-muted)]">Buyer</div>
                      <div className="text-sm font-semibold">{selectedOrder.buyer_name}</div>
                      {selectedOrder.buyer_address && <div className="mt-1 text-xs text-[color:var(--app-text-muted)]">{selectedOrder.buyer_address}</div>}
                    </div>
                    <div className="rounded-lg border border-[color:var(--app-border)] bg-[color:var(--app-surface)] p-3">
                      <div className="text-xs text-[color:var(--app-text-muted)]">Shipping</div>
                      <div className="text-sm font-semibold">{formatEur(selectedOrder.shipping_gross_cents)}</div>
                      <div className="mt-1 text-xs text-[color:var(--app-text-muted)]">Lines: {selectedOrder.lines.length}</div>
                    </div>
                  </div>

                  <div className="overflow-auto rounded-lg border border-[color:var(--app-border)] bg-[color:var(--app-surface)]">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>SKU</TableHead>
                          <TableHead>Title</TableHead>
                          <TableHead className="text-right">Sale</TableHead>
                          <TableHead>Strategy</TableHead>
                          <TableHead>Matched item</TableHead>
                          <TableHead>Error</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selectedOrder.lines.map((l) => (
                          <TableRow key={l.id}>
                            <TableCell className="font-mono text-xs">{l.sku}</TableCell>
                            <TableCell className="text-xs">{l.title ?? ""}</TableCell>
                            <TableCell className="text-right font-mono text-xs">{formatEur(l.sale_gross_cents)}</TableCell>
                            <TableCell className="font-mono text-xs">{MATCH_STRATEGY_LABEL[l.match_strategy]}</TableCell>
                            <TableCell className="font-mono text-xs">
                              {l.matched_inventory_item_id ? (
                                <div className="flex items-center gap-2">
                                  <span className="truncate">{l.matched_inventory_item_id}</span>
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7"
                                    onClick={async () => {
                                      await copyText(l.matched_inventory_item_id ?? "");
                                    }}
                                  >
                                    <ClipboardCopy className="h-4 w-4" />
                                  </Button>
                                </div>
                              ) : (
                                <span className="text-[color:var(--app-text-muted)]">-</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-rose-700 dark:text-rose-300">{l.match_error ?? ""}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </DialogContent>
          </Dialog>
        </TabsContent>

        <TabsContent value="apply">
          <Card>
            <CardHeader>
              <CardTitle>Apply READY Orders</CardTitle>
              <CardDescription>
                Erstellt sofort `FINALIZED` SalesOrders (cash_recognition=AT_PAYOUT), setzt Inventory direkt auf SOLD.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {!lastOrdersBatchId && (
                <InlineMessage tone="neutral">Noch kein Import-Batch. Bitte zuerst im Tab Orders importieren.</InlineMessage>
              )}

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm text-[color:var(--app-text-muted)]">
                  Batch:{" "}
                  <span className="font-mono text-xs text-[color:var(--app-text)]">
                    {lastOrdersBatchId ?? "-"}
                  </span>
                </div>
                <Button
                  type="button"
                  disabled={!lastOrdersBatchId || applyReady.isPending}
                  onClick={() => applyReady.mutate()}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Apply READY from batch
                </Button>
              </div>

              {(applyReady.isError || stagedOrders.isError) && (
                <InlineMessage tone="error">{((applyReady.error ?? stagedOrders.error) as Error).message}</InlineMessage>
              )}

              {applyOut && (
                <div className="space-y-2">
                  <div className="text-sm font-semibold">Ergebnis</div>
                  <div className="overflow-auto rounded-lg border border-[color:var(--app-border)] bg-[color:var(--app-surface)]">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Staged</TableHead>
                          <TableHead>Result</TableHead>
                          <TableHead>Sale ID</TableHead>
                          <TableHead>Error</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {applyOut.results.map((r) => (
                          <TableRow key={r.staged_order_id}>
                            <TableCell className="font-mono text-xs">{r.staged_order_id}</TableCell>
                            <TableCell>
                              {r.ok ? (
                                <div className="inline-flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
                                  <CheckCircle2 className="h-4 w-4" />
                                  OK
                                </div>
                              ) : (
                                <div className="inline-flex items-center gap-2 text-rose-700 dark:text-rose-300">
                                  <XCircle className="h-4 w-4" />
                                  Failed
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="font-mono text-xs">{r.sales_order_id ?? "-"}</TableCell>
                            <TableCell className="text-xs text-rose-700 dark:text-rose-300">{r.error ?? ""}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="payouts">
          <div className="grid gap-4 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Upload className="h-5 w-5" />
                  Import Payouts (CSV)
                </CardTitle>
                <CardDescription>Erzeugt einen Bank LedgerEntry pro Auszahlung (net).</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <Label>Delimiter (optional)</Label>
                    <Input value={payoutsDelimiter} onChange={(e) => setPayoutsDelimiter(e.target.value)} placeholder="z.B. , oder ;" />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <Label>CSV</Label>
                    <Input
                      type="file"
                      className="max-w-xs"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        setPayoutsCsv(await f.text());
                        e.currentTarget.value = "";
                      }}
                    />
                  </div>
                  <textarea
                    value={payoutsCsv}
                    onChange={(e) => setPayoutsCsv(e.target.value)}
                    placeholder={[
                      "channel,external_payout_id,payout_date,net_amount_eur",
                      "AMAZON,PO-1,2026-02-01,123.45",
                    ].join("\n")}
                    className="min-h-[220px] w-full rounded-lg border border-[color:var(--app-border)] bg-[color:var(--app-surface)] p-3 font-mono text-xs text-[color:var(--app-text)] shadow-sm"
                  />
                </div>

                {importPayouts.isError && <InlineMessage tone="error">{(importPayouts.error as Error).message}</InlineMessage>}

                <Button type="button" onClick={() => importPayouts.mutate()} disabled={importPayouts.isPending || !payoutsCsv.trim()}>
                  <Upload className="h-4 w-4" />
                  Import Payouts
                </Button>

                {payoutsImportOut && (
                  <div className="rounded-lg border border-[color:var(--app-border)] bg-[color:var(--app-surface)] p-3 text-sm">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="text-[color:var(--app-text-muted)]">Rows</div>
                      <div className="text-right font-semibold">{payoutsImportOut.total_rows}</div>
                      <div className="text-[color:var(--app-text-muted)]">Imported</div>
                      <div className="text-right font-semibold">{payoutsImportOut.imported_count}</div>
                      <div className="text-[color:var(--app-text-muted)]">Skipped</div>
                      <div className="text-right font-semibold">{payoutsImportOut.skipped_count}</div>
                      <div className="text-[color:var(--app-text-muted)]">Failed</div>
                      <div className="text-right font-semibold">{payoutsImportOut.failed_count}</div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Payouts</CardTitle>
                <CardDescription>Liste der importierten Auszahlungen.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm text-[color:var(--app-text-muted)]">{payouts.isFetching ? "Lade…" : ""}</div>
                  <Button type="button" variant="outline" onClick={() => payouts.refetch()} disabled={payouts.isFetching}>
                    <RefreshCw className="h-4 w-4" />
                    Refresh
                  </Button>
                </div>

                {payouts.isError && <InlineMessage tone="error">{(payouts.error as Error).message}</InlineMessage>}
                {!payouts.isLoading && !(payouts.data ?? []).length && (
                  <div className="text-sm text-[color:var(--app-text-muted)]">Noch keine Payouts.</div>
                )}
                {!!(payouts.data ?? []).length && (
                  <div className="overflow-auto rounded-lg border border-[color:var(--app-border)] bg-[color:var(--app-surface)]">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Date</TableHead>
                          <TableHead>Channel</TableHead>
                          <TableHead>External ID</TableHead>
                          <TableHead className="text-right">Net</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(payouts.data ?? []).map((p) => (
                          <TableRow key={p.id}>
                            <TableCell className="font-mono text-xs">{p.payout_date}</TableCell>
                            <TableCell className="font-mono text-xs">{p.channel}</TableCell>
                            <TableCell className="font-mono text-xs">{p.external_payout_id}</TableCell>
                            <TableCell className="text-right font-mono text-xs">{formatEur(p.net_amount_cents)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
