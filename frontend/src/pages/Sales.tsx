import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { formatEur, parseEurToCents } from "../lib/money";
import { paginateItems } from "../lib/pagination";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { InlineMessage } from "../components/ui/inline-message";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PaginationControls } from "../components/ui/pagination-controls";
import { PageHeader } from "../components/ui/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { TABLE_CELL_NUMERIC_CLASS, TABLE_ROW_COMPACT_CLASS } from "../components/ui/table-row-layout";

type InventoryItem = {
  id: string;
  master_product_id: string;
  purchase_type: string;
  status: string;
};

type MasterProduct = { id: string; sku?: string; title: string; platform: string; region: string; variant?: string };

type SalesOrder = {
  id: string;
  order_date: string;
  channel: string;
  status: string;
  buyer_name: string;
  buyer_address?: string | null;
  shipping_gross_cents: number;
  payment_source: string;
  invoice_number?: string | null;
  invoice_pdf_path?: string | null;
  lines: Array<{
    id: string;
    inventory_item_id: string;
    purchase_type: string;
    sale_gross_cents: number;
    sale_net_cents: number;
    sale_tax_cents: number;
    tax_rate_bp: number;
  }>;
};

type ReturnOut = {
  id: string;
  correction_date: string;
  correction_number: string;
  pdf_path?: string | null;
  refund_gross_cents: number;
};

const CHANNEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "EBAY", label: "eBay" },
  { value: "AMAZON", label: "Amazon" },
  { value: "WILLHABEN", label: "willhaben" },
  { value: "OTHER", label: "Sonstiges" },
];

const PAYMENT_SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "CASH", label: "Bar" },
  { value: "BANK", label: "Bank" },
];

const RETURN_ACTION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "RESTOCK", label: "Wieder einlagern" },
  { value: "WRITE_OFF", label: "Ausbuchen" },
];

const PURCHASE_TYPE_LABEL: Record<string, string> = {
  DIFF: "Differenz",
  REGULAR: "Regulär",
};

const ORDER_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Entwurf",
  FINALIZED: "Abgeschlossen",
  CANCELLED: "Storniert",
};

function optionLabel(options: Array<{ value: string; label: string }>, value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

function purchaseTypeLabel(purchaseType: string): string {
  return PURCHASE_TYPE_LABEL[purchaseType] ?? purchaseType;
}

function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABEL[status] ?? status;
}

export function SalesPage() {
  const api = useApi();
  const qc = useQueryClient();

  const master = useQuery({
    queryKey: ["master-products"],
    queryFn: () => api.request<MasterProduct[]>("/master-products"),
  });
  const mpById = useMemo(() => new Map((master.data ?? []).map((m) => [m.id, m])), [master.data]);

  const [orderDate, setOrderDate] = useState(new Date().toISOString().slice(0, 10));
  const [channel, setChannel] = useState("EBAY");
  const [buyerName, setBuyerName] = useState("");
  const [buyerAddress, setBuyerAddress] = useState("");
  const [shippingGross, setShippingGross] = useState("0,00");
  const [paymentSource, setPaymentSource] = useState("BANK");
  const [searchInv, setSearchInv] = useState("");

  const [selectedLines, setSelectedLines] = useState<Array<{ inventory_item_id: string; sale_gross: string }>>([]);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [page, setPage] = useState(1);

  const inv = useQuery({
    queryKey: ["inventory-available", searchInv],
    enabled: formOpen,
    queryFn: () =>
      api.request<InventoryItem[]>(
        `/inventory?status=AVAILABLE&limit=50&offset=0${searchInv.trim() ? `&q=${encodeURIComponent(searchInv.trim())}` : ""}`,
      ),
  });

  const orders = useQuery({
    queryKey: ["sales"],
    queryFn: () => api.request<SalesOrder[]>("/sales"),
  });

  const editingOrder = useMemo(() => {
    if (!editingOrderId) return null;
    return (orders.data ?? []).find((o) => o.id === editingOrderId) ?? null;
  }, [orders.data, editingOrderId]);
  const editingIsFinalized = editingOrder?.status === "FINALIZED";
  const orderRows = orders.data ?? [];
  const pagedOrders = useMemo(() => paginateItems(orderRows, page), [orderRows, page]);

  useEffect(() => {
    if (page !== pagedOrders.page) setPage(pagedOrders.page);
  }, [page, pagedOrders.page]);

  const create = useMutation({
    mutationFn: () =>
      api.request<SalesOrder>("/sales", {
        method: "POST",
        json: {
          order_date: orderDate,
          channel,
          buyer_name: buyerName,
          buyer_address: buyerAddress || null,
          shipping_gross_cents: parseEurToCents(shippingGross),
          payment_source: paymentSource,
          lines: selectedLines.map((l) => ({
            inventory_item_id: l.inventory_item_id,
            sale_gross_cents: parseEurToCents(l.sale_gross),
          })),
        },
      }),
    onSuccess: async () => {
      setBuyerName("");
      setBuyerAddress("");
      setShippingGross("0,00");
      setSelectedLines([]);
      setEditingOrderId(null);
      setFormOpen(false);
      await qc.invalidateQueries({ queryKey: ["sales"] });
      await qc.invalidateQueries({ queryKey: ["inventory-available"] });
    },
  });

  const update = useMutation({
    mutationFn: () => {
      if (!editingOrderId) throw new Error("Kein Auftrag ausgewählt");
      return api.request<SalesOrder>(`/sales/${editingOrderId}`, {
        method: "PUT",
        json: {
          order_date: orderDate,
          channel,
          buyer_name: buyerName,
          buyer_address: buyerAddress || null,
          shipping_gross_cents: parseEurToCents(shippingGross),
          payment_source: paymentSource,
          lines: selectedLines.map((l) => ({
            inventory_item_id: l.inventory_item_id,
            sale_gross_cents: parseEurToCents(l.sale_gross),
          })),
        },
      });
    },
    onSuccess: async () => {
      setEditingOrderId(null);
      setBuyerName("");
      setBuyerAddress("");
      setShippingGross("0,00");
      setSelectedLines([]);
      setFormOpen(false);
      await qc.invalidateQueries({ queryKey: ["sales"] });
      await qc.invalidateQueries({ queryKey: ["inventory-available"] });
    },
  });

  const finalize = useMutation({
    mutationFn: (orderId: string) => api.request<SalesOrder>(`/sales/${orderId}/finalize`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales"] });
      await qc.invalidateQueries({ queryKey: ["inventory-available"] });
    },
  });

  const generateInvoicePdf = useMutation({
    mutationFn: (orderId: string) => api.request<SalesOrder>(`/sales/${orderId}/generate-invoice-pdf`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales"] });
    },
  });
  const reopenOrder = useMutation({
    mutationFn: (orderId: string) => api.request<SalesOrder>(`/sales/${orderId}/reopen`, { method: "POST" }),
    onSuccess: async (order) => {
      await qc.invalidateQueries({ queryKey: ["sales"] });
      await qc.invalidateQueries({ queryKey: ["inventory-available"] });
      startEdit(order);
    },
  });

  const cancel = useMutation({
    mutationFn: (orderId: string) => api.request<SalesOrder>(`/sales/${orderId}/cancel`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales"] });
      await qc.invalidateQueries({ queryKey: ["inventory-available"] });
    },
  });

  const [returnOrderId, setReturnOrderId] = useState<string | null>(null);
  const [returnDate, setReturnDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [returnPaymentSource, setReturnPaymentSource] = useState<string>("BANK");
  const [shippingRefund, setShippingRefund] = useState<string>("0,00");
  const [returnLines, setReturnLines] = useState<Array<{ inventory_item_id: string; action: string; refund_gross?: string }>>([]);

  const returns = useQuery({
    queryKey: ["sales-returns", returnOrderId],
    enabled: !!returnOrderId,
    queryFn: async () => {
      if (!returnOrderId) return [];
      return api.request<ReturnOut[]>(`/sales/${returnOrderId}/returns`);
    },
  });

  const generateReturnPdf = useMutation({
    mutationFn: ({ orderId, correctionId }: { orderId: string; correctionId: string }) =>
      api.request<ReturnOut>(`/sales/${orderId}/returns/${correctionId}/generate-pdf`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales"] });
      await qc.invalidateQueries({ queryKey: ["sales-returns"] });
    },
  });

  const createReturn = useMutation({
    mutationFn: async () => {
      if (!returnOrderId) throw new Error("Kein Auftrag ausgewählt");
      return api.request<ReturnOut>(`/sales/${returnOrderId}/returns`, {
        method: "POST",
        json: {
          correction_date: returnDate,
          payment_source: returnPaymentSource,
          shipping_refund_gross_cents: parseEurToCents(shippingRefund),
          lines: returnLines.map((l) => ({
            inventory_item_id: l.inventory_item_id,
            action: l.action,
            refund_gross_cents: l.refund_gross?.trim() ? parseEurToCents(l.refund_gross) : null,
          })),
        },
      });
    },
    onSuccess: async () => {
      setReturnLines([]);
      setShippingRefund("0,00");
      await qc.invalidateQueries({ queryKey: ["sales"] });
      await qc.invalidateQueries({ queryKey: ["inventory-available"] });
      await qc.invalidateQueries({ queryKey: ["sales-returns"] });
    },
  });

  const canCreateOrder = buyerName.trim() && selectedLines.length > 0 && selectedLines.every((l) => l.sale_gross.trim());

  function startEdit(o: SalesOrder) {
    setEditingOrderId(o.id);
    setOrderDate(o.order_date);
    setChannel(o.channel);
    setBuyerName(o.buyer_name);
    setBuyerAddress(o.buyer_address ?? "");
    setShippingGross(formatEur(o.shipping_gross_cents));
    setPaymentSource(o.payment_source);
    setSelectedLines(o.lines.map((l) => ({ inventory_item_id: l.inventory_item_id, sale_gross: formatEur(l.sale_gross_cents) })));
    create.reset();
    update.reset();
    setFormOpen(true);
  }

  function cancelEdit() {
    setEditingOrderId(null);
    setOrderDate(new Date().toISOString().slice(0, 10));
    setChannel("EBAY");
    setBuyerName("");
    setBuyerAddress("");
    setShippingGross("0,00");
    setPaymentSource("BANK");
    setSelectedLines([]);
    create.reset();
    update.reset();
  }

  function openCreateForm() {
    cancelEdit();
    setFormOpen(true);
  }

  function closeForm() {
    cancelEdit();
    setFormOpen(false);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Verkäufe"
        description="Aufträge erfassen, abschließen und Rechnungen als PDF erstellen."
        actions={
          <>
            <Button variant="secondary" className="w-full sm:w-auto" onClick={() => orders.refetch()} disabled={orders.isFetching}>
              <RefreshCw className="h-4 w-4" />
              Aktualisieren
            </Button>
            <Button className="w-full sm:w-auto" onClick={openCreateForm}>
              <Plus className="h-4 w-4" />
              {editingOrderId ? "Neuer Auftrag" : "Auftrag erstellen"}
            </Button>
          </>
        }
        actionsClassName="w-full sm:w-auto"
      />

      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-col gap-1">
            <CardTitle>Aufträge</CardTitle>
            <CardDescription>
              {orders.isPending ? "Lade…" : `${orderRows.length} Aufträge`}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {orders.isError && (
            <InlineMessage tone="error">
              {(orders.error as Error).message}
            </InlineMessage>
          )}
          {(generateInvoicePdf.isError || reopenOrder.isError) && (
            <InlineMessage tone="error">
              {String(((generateInvoicePdf.error as Error) ?? (reopenOrder.error as Error))?.message ?? "Unbekannter Fehler")}
            </InlineMessage>
          )}

          <div className="space-y-2 md:hidden">
            {orders.isPending &&
              Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={`skel-so-${i}`}
                  className="animate-pulse rounded-md border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-800 dark:bg-gray-900"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-2">
                      <div className="h-4 w-36 rounded bg-gray-200 dark:bg-gray-800" />
                      <div className="h-3 w-56 rounded bg-gray-100 dark:bg-gray-800" />
                      <div className="h-3 w-40 rounded bg-gray-100 dark:bg-gray-800" />
                    </div>
                    <div className="space-y-2 text-right">
                      <div className="h-4 w-20 rounded bg-gray-200 dark:bg-gray-800" />
                      <div className="h-3 w-24 rounded bg-gray-100 dark:bg-gray-800" />
                    </div>
                  </div>
                </div>
              ))}

            {!orders.isPending &&
              pagedOrders.items.map((o) => {
                const gross = o.shipping_gross_cents + o.lines.reduce((s, l) => s + l.sale_gross_cents, 0);
                const statusVariant = o.status === "FINALIZED" ? "success" : o.status === "DRAFT" ? "secondary" : "warning";
                return (
                  <div
                    key={o.id}
                    className="rounded-md border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-800 dark:bg-gray-900"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{o.order_date}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline">{optionLabel(CHANNEL_OPTIONS, o.channel)}</Badge>
                          <Badge variant={statusVariant}>{orderStatusLabel(o.status)}</Badge>
                          {o.invoice_number ? (
                            <Badge variant="outline" className="font-mono text-[11px]">
                              #{o.invoice_number}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-2 truncate text-sm text-gray-700 dark:text-gray-200">{o.buyer_name}</div>
                      </div>

                      <div className="shrink-0 text-right">
                        <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">{formatEur(gross)} €</div>
                      </div>
                    </div>

                    {o.status === "DRAFT" && (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <Button
                          variant="secondary"
                          className="w-full"
                          onClick={() => startEdit(o)}
                          disabled={create.isPending || update.isPending}
                        >
                          Bearbeiten
                        </Button>
                        <Button variant="outline" className="w-full" onClick={() => finalize.mutate(o.id)} disabled={finalize.isPending}>
                          Abschließen
                        </Button>
                        <Button variant="destructive" className="w-full sm:col-span-2" onClick={() => cancel.mutate(o.id)} disabled={cancel.isPending}>
                          Stornieren
                        </Button>
                      </div>
                    )}

                    {o.status === "FINALIZED" && (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <Button
                          variant="outline"
                          className="w-full"
                          onClick={() =>
                            o.invoice_pdf_path
                              ? api.download(o.invoice_pdf_path!, o.invoice_pdf_path!.split("/").pop()!)
                              : generateInvoicePdf.mutate(o.id)
                          }
                          disabled={generateInvoicePdf.isPending}
                        >
                          {o.invoice_pdf_path ? "Rechnung (PDF)" : "Rechnung erstellen"}
                        </Button>
                        <Button
                          variant="secondary"
                          className="w-full"
                          onClick={() => reopenOrder.mutate(o.id)}
                          disabled={reopenOrder.isPending || create.isPending || update.isPending}
                        >
                          Zur Bearbeitung öffnen
                        </Button>

                        <Dialog>
                          <DialogTrigger asChild>
                            <Button
                              variant="secondary"
                              className="w-full sm:col-span-2"
                              onClick={() => {
                                setReturnOrderId(o.id);
                                setReturnPaymentSource(o.payment_source);
                                setReturnLines(
                                  o.lines.map((l) => ({
                                    inventory_item_id: l.inventory_item_id,
                                    action: "RESTOCK",
                                    refund_gross: formatEur(l.sale_gross_cents),
                                  })),
                                );
                              }}
                            >
                              Rückgabe / Korrektur
                            </Button>
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>Rückgabe / Korrektur</DialogTitle>
                              <DialogDescription>Korrektur erfassen. PDF wird danach manuell erstellt.</DialogDescription>
                            </DialogHeader>

                            <div className="space-y-4">
                              <div className="space-y-2">
                                <div className="text-sm font-medium">Bestehende Korrekturen</div>
                                {returns.isLoading ? (
                                  <div className="text-xs text-gray-500 dark:text-gray-400">Lade…</div>
                                ) : returns.isError ? (
                                  <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                                    {(returns.error as Error).message}
                                  </div>
                                ) : (returns.data ?? []).length ? (
                                  <div className="max-h-40 overflow-auto rounded-md border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-950/40">
                                    <Table>
                                      <TableHeader>
                                        <TableRow>
                                          <TableHead>Nr.</TableHead>
                                          <TableHead>Datum</TableHead>
                                          <TableHead className="text-right">Brutto</TableHead>
                                          <TableHead className="text-right">PDF</TableHead>
                                        </TableRow>
                                      </TableHeader>
                                      <TableBody>
                                        {(returns.data ?? []).map((r) => (
                                          <TableRow key={r.id} className={TABLE_ROW_COMPACT_CLASS}>
                                            <TableCell className="font-mono text-xs">{r.correction_number}</TableCell>
                                            <TableCell>{r.correction_date}</TableCell>
                                            <TableCell className="text-right">{formatEur(r.refund_gross_cents)} €</TableCell>
                                            <TableCell className="text-right">
                                              {r.pdf_path ? (
                                                <Button
                                                  size="sm"
                                                  variant="outline"
                                                  onClick={() => api.download(r.pdf_path!, r.pdf_path!.split("/").pop()!)}
                                                >
                                                  PDF
                                                </Button>
                                              ) : (
                                                <Button
                                                  size="sm"
                                                  variant="outline"
                                                  onClick={() => generateReturnPdf.mutate({ orderId: o.id, correctionId: r.id })}
                                                  disabled={generateReturnPdf.isPending}
                                                >
                                                  PDF erstellen
                                                </Button>
                                              )}
                                            </TableCell>
                                          </TableRow>
                                        ))}
                                      </TableBody>
                                    </Table>
                                  </div>
                                ) : (
                                  <div className="text-xs text-gray-500 dark:text-gray-400">Keine Korrekturen.</div>
                                )}
                              </div>

                              <div className="space-y-3">
                                <div className="grid gap-3 md:grid-cols-3">
                                  <div className="space-y-2">
                                    <Label>Datum</Label>
                                    <Input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
                                  </div>
                                  <div className="space-y-2">
                                    <Label>Zahlungsquelle</Label>
                                    <Select value={returnPaymentSource} onValueChange={setReturnPaymentSource}>
                                      <SelectTrigger><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        {PAYMENT_SOURCE_OPTIONS.map((p) => (
                                          <SelectItem key={p.value} value={p.value}>
                                            {p.label}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="space-y-2">
                                    <Label>Versand-Erstattung (EUR)</Label>
                                    <Input value={shippingRefund} onChange={(e) => setShippingRefund(e.target.value)} />
                                  </div>
                                </div>

                                <div className="max-h-64 overflow-auto rounded-md border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-950/40">
                                  <Table>
                                    <TableHeader>
                                      <TableRow>
                                        <TableHead>Artikel</TableHead>
                                        <TableHead>Aktion</TableHead>
                                        <TableHead className="text-right">Erstattung brutto</TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {returnLines.map((l, idx) => (
                                        <TableRow key={l.inventory_item_id} className={TABLE_ROW_COMPACT_CLASS}>
                                          <TableCell className="font-mono text-xs">{l.inventory_item_id}</TableCell>
                                          <TableCell>
                                            <Select
                                              value={l.action}
                                              onValueChange={(v) => setReturnLines((s) => s.map((x, i) => (i === idx ? { ...x, action: v } : x)))}
                                            >
                                              <SelectTrigger><SelectValue /></SelectTrigger>
                                              <SelectContent>
                                                {RETURN_ACTION_OPTIONS.map((a) => (
                                                  <SelectItem key={a.value} value={a.value}>
                                                    {a.label}
                                                  </SelectItem>
                                                ))}
                                              </SelectContent>
                                            </Select>
                                          </TableCell>
                                          <TableCell className="text-right">
                                            <Input
                                              className="text-right"
                                              value={l.refund_gross ?? ""}
                                              onChange={(e) => setReturnLines((s) => s.map((x, i) => (i === idx ? { ...x, refund_gross: e.target.value } : x)))}
                                            />
                                          </TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                </div>
                              </div>
                            </div>

                            <DialogFooter>
                              <Button onClick={() => createReturn.mutate()} disabled={!returnOrderId || createReturn.isPending}>
                                Korrektur erstellen
                              </Button>
                            </DialogFooter>

                            {(createReturn.isError || generateReturnPdf.isError) && (
                              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                                {(((createReturn.error ?? generateReturnPdf.error) as Error) ?? new Error("Unbekannter Fehler")).message}
                              </div>
                            )}
                          </DialogContent>
                        </Dialog>

                        {o.invoice_pdf_path ? (
                          <Button
                            variant="outline"
                            className="w-full sm:col-span-2"
                            onClick={() => generateInvoicePdf.mutate(o.id)}
                            disabled={generateInvoicePdf.isPending}
                          >
                            Rechnung neu erstellen
                          </Button>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}

            {!orders.isPending && !orderRows.length && (
              <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-300">
                Keine Aufträge.
              </div>
            )}
          </div>

          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Datum</TableHead>
                  <TableHead>Kanal</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Käufer</TableHead>
                  <TableHead className="text-right">Brutto</TableHead>
                  <TableHead className="text-right">Aktionen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedOrders.items.map((o) => {
                  const gross = o.shipping_gross_cents + o.lines.reduce((s, l) => s + l.sale_gross_cents, 0);
                  return (
                    <TableRow key={o.id} className={TABLE_ROW_COMPACT_CLASS}>
                      <TableCell>{o.order_date}</TableCell>
                      <TableCell>{optionLabel(CHANNEL_OPTIONS, o.channel)}</TableCell>
                      <TableCell>
                        <Badge variant={o.status === "FINALIZED" ? "success" : o.status === "DRAFT" ? "secondary" : "warning"}>
                          {orderStatusLabel(o.status)}
                        </Badge>
                        {o.invoice_number && <div className="text-xs text-gray-500 dark:text-gray-400">#{o.invoice_number}</div>}
                      </TableCell>
                      <TableCell>{o.buyer_name}</TableCell>
                      <TableCell className={TABLE_CELL_NUMERIC_CLASS}>{formatEur(gross)} €</TableCell>
                      <TableCell className="text-right space-x-2">
                        {o.status === "DRAFT" && (
                          <>
                            <Button variant="secondary" onClick={() => startEdit(o)} disabled={create.isPending || update.isPending}>
                              Bearbeiten
                            </Button>
                            <Button variant="outline" onClick={() => finalize.mutate(o.id)} disabled={finalize.isPending}>
                              Abschließen
                            </Button>
                            <Button variant="secondary" onClick={() => cancel.mutate(o.id)} disabled={cancel.isPending}>
                              Stornieren
                            </Button>
                          </>
                        )}
                        {o.status === "FINALIZED" && (
                          <>
                            {o.invoice_pdf_path ? (
                              <>
                                <Button variant="outline" onClick={() => api.download(o.invoice_pdf_path!, o.invoice_pdf_path!.split("/").pop()!)}>
                                  Rechnung (PDF)
                                </Button>
                                <Button variant="ghost" onClick={() => generateInvoicePdf.mutate(o.id)} disabled={generateInvoicePdf.isPending}>
                                  Neu erstellen
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button variant="outline" onClick={() => generateInvoicePdf.mutate(o.id)} disabled={generateInvoicePdf.isPending}>
                                  Rechnung erstellen
                                </Button>
                              </>
                            )}
                            <Button
                              variant="secondary"
                              onClick={() => reopenOrder.mutate(o.id)}
                              disabled={reopenOrder.isPending || create.isPending || update.isPending}
                            >
                              Zur Bearbeitung öffnen
                            </Button>

                            <Dialog>
                              <DialogTrigger asChild>
                                <Button
                                  variant="secondary"
                                  onClick={() => {
                                    setReturnOrderId(o.id);
                                    setReturnPaymentSource(o.payment_source);
                                    setReturnLines(
                                      o.lines.map((l) => ({
                                        inventory_item_id: l.inventory_item_id,
                                        action: "RESTOCK",
                                        refund_gross: formatEur(l.sale_gross_cents),
                                      })),
                                    );
                                  }}
                                >
                                  Rückgabe / Korrektur
                                </Button>
                              </DialogTrigger>
                              <DialogContent>
                                <DialogHeader>
                                  <DialogTitle>Rückgabe / Korrektur</DialogTitle>
                                  <DialogDescription>Korrektur erfassen. PDF wird danach manuell erstellt.</DialogDescription>
                                </DialogHeader>

                                <div className="space-y-4">
                                  <div className="space-y-2">
                                    <div className="text-sm font-medium">Bestehende Korrekturen</div>
                                    {returns.isLoading ? (
                                      <div className="text-xs text-gray-500 dark:text-gray-400">Lade…</div>
                                    ) : returns.isError ? (
                                      <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                                        {(returns.error as Error).message}
                                      </div>
                                    ) : (returns.data ?? []).length ? (
                                      <div className="max-h-40 overflow-auto rounded-md border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-950/40">
                                        <Table>
                                          <TableHeader>
                                            <TableRow>
                                              <TableHead>Nr.</TableHead>
                                              <TableHead>Datum</TableHead>
                                              <TableHead className="text-right">Brutto</TableHead>
                                              <TableHead className="text-right">PDF</TableHead>
                                            </TableRow>
                                          </TableHeader>
                                          <TableBody>
                                            {(returns.data ?? []).map((r) => (
                                              <TableRow key={r.id} className={TABLE_ROW_COMPACT_CLASS}>
                                                <TableCell className="font-mono text-xs">{r.correction_number}</TableCell>
                                                <TableCell>{r.correction_date}</TableCell>
                                                <TableCell className="text-right">{formatEur(r.refund_gross_cents)} €</TableCell>
                                                <TableCell className="text-right">
                                                  {r.pdf_path ? (
                                                    <Button
                                                      size="sm"
                                                      variant="outline"
                                                      onClick={() => api.download(r.pdf_path!, r.pdf_path!.split("/").pop()!)}
                                                    >
                                                      PDF
                                                    </Button>
                                                  ) : (
                                                    <Button
                                                      size="sm"
                                                      variant="outline"
                                                      onClick={() => generateReturnPdf.mutate({ orderId: o.id, correctionId: r.id })}
                                                      disabled={generateReturnPdf.isPending}
                                                    >
                                                      PDF erstellen
                                                    </Button>
                                                  )}
                                                </TableCell>
                                              </TableRow>
                                            ))}
                                          </TableBody>
                                        </Table>
                                      </div>
                                    ) : (
                                      <div className="text-xs text-gray-500 dark:text-gray-400">Keine Korrekturen.</div>
                                    )}
                                  </div>

                                  <div className="space-y-3">
                                    <div className="grid gap-3 md:grid-cols-3">
                                      <div className="space-y-2">
                                        <Label>Datum</Label>
                                        <Input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
                                      </div>
                                      <div className="space-y-2">
                                        <Label>Zahlungsquelle</Label>
                                        <Select value={returnPaymentSource} onValueChange={setReturnPaymentSource}>
                                          <SelectTrigger><SelectValue /></SelectTrigger>
                                          <SelectContent>
                                            {PAYMENT_SOURCE_OPTIONS.map((p) => (
                                              <SelectItem key={p.value} value={p.value}>
                                                {p.label}
                                              </SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>
                                      </div>
                                      <div className="space-y-2">
                                        <Label>Versand-Erstattung (EUR)</Label>
                                        <Input value={shippingRefund} onChange={(e) => setShippingRefund(e.target.value)} />
                                      </div>
                                    </div>

                                    <div className="max-h-64 overflow-auto rounded-md border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-950/40">
                                      <Table>
                                        <TableHeader>
                                          <TableRow>
                                            <TableHead>Artikel</TableHead>
                                            <TableHead>Aktion</TableHead>
                                            <TableHead className="text-right">Erstattung brutto</TableHead>
                                          </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                          {returnLines.map((l, idx) => (
                                            <TableRow key={l.inventory_item_id} className={TABLE_ROW_COMPACT_CLASS}>
                                              <TableCell className="font-mono text-xs">{l.inventory_item_id}</TableCell>
                                              <TableCell>
                                                <Select
                                                  value={l.action}
                                                  onValueChange={(v) => setReturnLines((s) => s.map((x, i) => (i === idx ? { ...x, action: v } : x)))}
                                                >
                                                  <SelectTrigger><SelectValue /></SelectTrigger>
                                                  <SelectContent>
                                                    {RETURN_ACTION_OPTIONS.map((a) => (
                                                      <SelectItem key={a.value} value={a.value}>
                                                        {a.label}
                                                      </SelectItem>
                                                    ))}
                                                  </SelectContent>
                                                </Select>
                                              </TableCell>
                                              <TableCell className="text-right">
                                                <Input
                                                  className="text-right"
                                                  value={l.refund_gross ?? ""}
                                                  onChange={(e) => setReturnLines((s) => s.map((x, i) => (i === idx ? { ...x, refund_gross: e.target.value } : x)))}
                                                />
                                              </TableCell>
                                            </TableRow>
                                          ))}
                                        </TableBody>
                                      </Table>
                                    </div>
                                  </div>
                                </div>

                                <DialogFooter>
                                  <Button onClick={() => createReturn.mutate()} disabled={!returnOrderId || createReturn.isPending}>
                                    Korrektur erstellen
                                  </Button>
                                </DialogFooter>

                                {(createReturn.isError || generateReturnPdf.isError) && (
                                  <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                                    {(((createReturn.error ?? generateReturnPdf.error) as Error) ?? new Error("Unbekannter Fehler")).message}
                                  </div>
                                )}
                              </DialogContent>
                            </Dialog>
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!orderRows.length && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-sm text-gray-500 dark:text-gray-400">
                      Keine Aufträge.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <PaginationControls
            page={pagedOrders.page}
            totalPages={pagedOrders.totalPages}
            totalItems={pagedOrders.totalItems}
            pageSize={pagedOrders.pageSize}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>

      <Dialog
        open={formOpen || !!editingOrderId}
        onOpenChange={(open) => {
          if (!open) closeForm();
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingOrderId ? "Auftrag bearbeiten" : "Auftrag erstellen"}</DialogTitle>
            <DialogDescription>
              {editingOrderId ? `ID: ${editingOrderId}` : "Entwurf anlegen, Positionen befuellen und spaeter abschliessen."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-4">
              <div className="space-y-2">
                <Label>Datum</Label>
                <Input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Kanal</Label>
                <Select value={channel} onValueChange={setChannel}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CHANNEL_OPTIONS.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Zahlungsquelle</Label>
                <Select value={paymentSource} onValueChange={setPaymentSource}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PAYMENT_SOURCE_OPTIONS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Versand (brutto, EUR)</Label>
                <Input value={shippingGross} onChange={(e) => setShippingGross(e.target.value)} />
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Käufername</Label>
                <Input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Käuferadresse (optional)</Label>
                <Input value={buyerAddress} onChange={(e) => setBuyerAddress(e.target.value)} />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              {editingIsFinalized ? (
                <div className="space-y-2">
                  <Label>Hinweis</Label>
                  <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-800 dark:border-gray-800 dark:bg-gray-950/40 dark:text-gray-200">
                    Positionen können nach Abschluss nicht mehr verändert werden. Solange noch keine PDF erzeugt wurde,
                    kannst du Käuferdaten, Datum, Versand und Preise anpassen.
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label>Verfügbarer Bestand (Status=AVAILABLE)</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      placeholder="SKU/Titel/EAN/ASIN suchen…"
                      value={searchInv}
                      onChange={(e) => setSearchInv(e.target.value)}
                    />
                    <Button variant="secondary" onClick={() => inv.refetch()}>Aktualisieren</Button>
                  </div>
                  {inv.isError && (
                    <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                      {(inv.error as Error).message}
                    </div>
                  )}
                  <div className="max-h-64 overflow-auto rounded-md border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Artikel</TableHead>
                          <TableHead>Typ</TableHead>
                          <TableHead className="text-right"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(inv.data ?? []).map((it) => {
                          const mp = mpById.get(it.master_product_id);
                          const already = selectedLines.some((l) => l.inventory_item_id === it.id);
                          return (
                            <TableRow key={it.id} className={TABLE_ROW_COMPACT_CLASS}>
                              <TableCell>
                                <div className="font-medium">{mp ? mp.title : it.master_product_id}</div>
                                {mp && (
                                  <div className="text-xs text-gray-500 dark:text-gray-400">
                                    {mp.platform} · {mp.region}
                                    {mp.variant ? ` · ${mp.variant}` : ""}
                                  </div>
                                )}
                                {mp?.sku && <div className="text-xs font-mono text-gray-400 dark:text-gray-500">{mp.sku}</div>}
                                <div className="text-xs font-mono text-gray-400 dark:text-gray-500">{it.id}</div>
                              </TableCell>
                              <TableCell>{purchaseTypeLabel(it.purchase_type)}</TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant={already ? "secondary" : "outline"}
                                  disabled={already}
                                  onClick={() => setSelectedLines((s) => [...s, { inventory_item_id: it.id, sale_gross: "" }])}
                                >
                                  Hinzufügen
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                        {!inv.data?.length && (
                          <TableRow>
                            <TableCell colSpan={3} className="text-sm text-gray-500 dark:text-gray-400">Keine verfügbaren Artikel.</TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <Label>Auftragspositionen</Label>
                <div className="rounded-md border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Lagerartikel</TableHead>
                        <TableHead className="text-right">Verkauf brutto (EUR)</TableHead>
                        <TableHead className="text-right"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedLines.map((l, idx) => (
                        <TableRow key={l.inventory_item_id} className={TABLE_ROW_COMPACT_CLASS}>
                          <TableCell className="font-mono text-xs">{l.inventory_item_id}</TableCell>
                          <TableCell className="text-right">
                            <Input
                              className="text-right"
                              value={l.sale_gross}
                              onChange={(e) =>
                                setSelectedLines((s) => s.map((x, i) => (i === idx ? { ...x, sale_gross: e.target.value } : x)))
                              }
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            {editingIsFinalized ? (
                              <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                            ) : (
                              <Button variant="ghost" onClick={() => setSelectedLines((s) => s.filter((_, i) => i !== idx))}>
                                Entfernen
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                      {!selectedLines.length && (
                        <TableRow>
                          <TableCell colSpan={3} className="text-sm text-gray-500 dark:text-gray-400">Noch keine Positionen.</TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="secondary" onClick={closeForm} disabled={create.isPending || update.isPending}>
                {editingOrderId ? "Abbrechen" : "Schließen"}
              </Button>
              <Button
                onClick={() => (editingOrderId ? update.mutate() : create.mutate())}
                disabled={!canCreateOrder || create.isPending || update.isPending}
              >
                {editingOrderId ? "Änderungen speichern" : "Auftrag erstellen (ENTWURF)"}
              </Button>
            </div>

            {(create.isError || update.isError) && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                {(((create.error ?? update.error) as Error) ?? new Error("Unbekannter Fehler")).message}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
