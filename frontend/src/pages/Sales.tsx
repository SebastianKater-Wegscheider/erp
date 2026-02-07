import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { formatEur, parseEurToCents } from "../lib/money";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

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

  const inv = useQuery({
    queryKey: ["inventory-available", searchInv],
    queryFn: () =>
      api.request<InventoryItem[]>(
        `/inventory?status=AVAILABLE&limit=50&offset=0${searchInv.trim() ? `&q=${encodeURIComponent(searchInv.trim())}` : ""}`,
      ),
  });

  const orders = useQuery({
    queryKey: ["sales"],
    queryFn: () => api.request<SalesOrder[]>("/sales"),
  });

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

  return (
    <div className="space-y-4">
      <div className="text-xl font-semibold">Verkäufe</div>

      <Card>
        <CardHeader>
          <CardTitle>Auftrag erstellen</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
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
            <div className="space-y-2">
              <Label>Verfügbarer Bestand (Status=AVAILABLE)</Label>
              <div className="flex items-center gap-2">
                <Input placeholder="SKU/Titel/EAN/ASIN suchen…" value={searchInv} onChange={(e) => setSearchInv(e.target.value)} />
                <Button variant="secondary" onClick={() => inv.refetch()}>Aktualisieren</Button>
              </div>
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
                        <TableRow key={it.id}>
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
                      <TableRow key={l.inventory_item_id}>
                        <TableCell className="font-mono text-xs">{l.inventory_item_id}</TableCell>
                        <TableCell className="text-right">
                          <Input
                            className="text-right"
                            value={l.sale_gross}
                            onChange={(e) => setSelectedLines((s) => s.map((x, i) => (i === idx ? { ...x, sale_gross: e.target.value } : x)))}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" onClick={() => setSelectedLines((s) => s.filter((_, i) => i !== idx))}>
                            Entfernen
                          </Button>
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
            <Button onClick={() => create.mutate()} disabled={!canCreateOrder || create.isPending}>
              Auftrag erstellen (ENTWURF)
            </Button>
          </div>

          {create.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
              {(create.error as Error).message}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Aufträge</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="secondary" onClick={() => orders.refetch()}>Aktualisieren</Button>

          {(orders.isError || inv.isError) && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
              {((orders.error ?? inv.error) as Error).message}
            </div>
          )}

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
              {(orders.data ?? []).map((o) => {
                const gross = o.shipping_gross_cents + o.lines.reduce((s, l) => s + l.sale_gross_cents, 0);
                return (
                  <TableRow key={o.id}>
                    <TableCell>{o.order_date}</TableCell>
                    <TableCell>{optionLabel(CHANNEL_OPTIONS, o.channel)}</TableCell>
                    <TableCell>
                      <Badge variant={o.status === "FINALIZED" ? "success" : o.status === "DRAFT" ? "secondary" : "warning"}>
                        {orderStatusLabel(o.status)}
                      </Badge>
                      {o.invoice_number && <div className="text-xs text-gray-500 dark:text-gray-400">#{o.invoice_number}</div>}
                    </TableCell>
                    <TableCell>{o.buyer_name}</TableCell>
                    <TableCell className="text-right">{formatEur(gross)} €</TableCell>
                    <TableCell className="text-right space-x-2">
                      {o.status === "DRAFT" && (
                        <>
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
                            <Button variant="outline" onClick={() => generateInvoicePdf.mutate(o.id)} disabled={generateInvoicePdf.isPending}>
                              Rechnung erstellen
                            </Button>
                          )}

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
                                            <TableRow key={r.id}>
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
                                          <TableRow key={l.inventory_item_id}>
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
              {!orders.data?.length && (
                <TableRow>
                  <TableCell colSpan={6} className="text-sm text-gray-500 dark:text-gray-400">
                    Keine Aufträge.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
