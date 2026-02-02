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

type MasterProduct = { id: string; title: string; platform: string; region: string };

type PurchaseOut = {
  id: string;
  kind: string;
  purchase_date: string;
  counterparty_name: string;
  total_amount_cents: number;
  payment_source: string;
  document_number?: string | null;
  pdf_path?: string | null;
  receipt_upload_path?: string | null;
};

type UploadOut = { upload_path: string };

type Line = {
  master_product_id: string;
  condition: string;
  purchase_price: string;
};

export function PurchasesPage() {
  const api = useApi();
  const qc = useQueryClient();

  const master = useQuery({
    queryKey: ["master-products"],
    queryFn: () => api.request<MasterProduct[]>("/master-products"),
  });

  const list = useQuery({
    queryKey: ["purchases"],
    queryFn: () => api.request<PurchaseOut[]>("/purchases"),
  });

  const [kind, setKind] = useState<string>("PRIVATE_DIFF");
  const [purchaseDate, setPurchaseDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [counterpartyName, setCounterpartyName] = useState("");
  const [counterpartyAddress, setCounterpartyAddress] = useState("");
  const [paymentSource, setPaymentSource] = useState<string>("CASH");
  const [totalAmount, setTotalAmount] = useState<string>("0,00");

  const [externalInvoiceNumber, setExternalInvoiceNumber] = useState<string>("");
  const [receiptUploadPath, setReceiptUploadPath] = useState<string>("");

  const [lines, setLines] = useState<Line[]>([]);

  const purchaseType = kind === "PRIVATE_DIFF" ? "DIFF" : "REGULAR";

  const totalCents = useMemo(() => {
    try {
      return parseEurToCents(totalAmount);
    } catch {
      return 0;
    }
  }, [totalAmount]);

  const sumLinesCents = useMemo(() => {
    let sum = 0;
    for (const l of lines) {
      try {
        sum += parseEurToCents(l.purchase_price);
      } catch {
        return null;
      }
    }
    return sum;
  }, [lines]);

  const splitOk = sumLinesCents !== null && sumLinesCents === totalCents;

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.request<UploadOut>("/uploads", { method: "POST", body: fd });
    },
    onSuccess: (r) => setReceiptUploadPath(r.upload_path),
  });

  const create = useMutation({
    mutationFn: async () => {
      const payload = {
        kind,
        purchase_date: purchaseDate,
        counterparty_name: counterpartyName,
        counterparty_address: counterpartyAddress || null,
        total_amount_cents: totalCents,
        payment_source: paymentSource,
        external_invoice_number: kind === "COMMERCIAL_REGULAR" ? externalInvoiceNumber : null,
        receipt_upload_path: kind === "COMMERCIAL_REGULAR" ? receiptUploadPath : null,
        lines: lines.map((l) => ({
          master_product_id: l.master_product_id,
          condition: l.condition,
          purchase_type: purchaseType,
          purchase_price_cents: parseEurToCents(l.purchase_price),
        })),
      };
      return api.request<PurchaseOut>("/purchases", { method: "POST", json: payload });
    },
    onSuccess: async () => {
      setCounterpartyName("");
      setCounterpartyAddress("");
      setExternalInvoiceNumber("");
      setReceiptUploadPath("");
      setTotalAmount("0,00");
      setLines([]);
      await qc.invalidateQueries({ queryKey: ["purchases"] });
    },
  });

  const canSubmit =
    counterpartyName.trim() &&
    lines.length > 0 &&
    splitOk &&
    (kind === "PRIVATE_DIFF" || (externalInvoiceNumber.trim() && receiptUploadPath.trim()));

  return (
    <div className="space-y-4">
      <div className="text-xl font-semibold">Purchases</div>

      <Card>
        <CardHeader>
          <CardTitle>Create purchase</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label>Kind</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PRIVATE_DIFF">PRIVATE_DIFF</SelectItem>
                  <SelectItem value="COMMERCIAL_REGULAR">COMMERCIAL_REGULAR</SelectItem>
                </SelectContent>
              </Select>
              <div className="text-xs text-gray-500">Purchase type is forced to {purchaseType}.</div>
            </div>
            <div className="space-y-2">
              <Label>Date</Label>
              <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Payment source</Label>
              <Select value={paymentSource} onValueChange={setPaymentSource}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CASH">CASH</SelectItem>
                  <SelectItem value="BANK">BANK</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Seller / Supplier</Label>
              <Input value={counterpartyName} onChange={(e) => setCounterpartyName(e.target.value)} placeholder="Name" />
            </div>
            <div className="space-y-2">
              <Label>Address (optional)</Label>
              <Input value={counterpartyAddress} onChange={(e) => setCounterpartyAddress(e.target.value)} placeholder="Address" />
            </div>
          </div>

          {kind === "COMMERCIAL_REGULAR" && (
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label>External invoice number</Label>
                <Input value={externalInvoiceNumber} onChange={(e) => setExternalInvoiceNumber(e.target.value)} />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Receipt upload</Label>
                <div className="flex items-center gap-2">
                  <Input value={receiptUploadPath} readOnly placeholder="Upload a PDF/image…" />
                  <Input
                    type="file"
                    className="max-w-xs"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) upload.mutate(f);
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Total amount (EUR)</Label>
            <Input value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} />
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge variant={splitOk ? "success" : "warning"}>
                Split: {sumLinesCents === null ? "invalid" : `${formatEur(sumLinesCents)} €`} / {formatEur(totalCents)} €
              </Badge>
              {!splitOk && <div className="text-xs text-gray-500">Save is blocked until sums match.</div>}
            </div>
            <Button onClick={() => create.mutate()} disabled={!canSubmit || create.isPending}>
              Create
            </Button>
          </div>

          {create.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {(create.error as Error).message}
            </div>
          )}

          <Card className="border-dashed">
            <CardHeader>
              <CardTitle>Lines</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <Button
                  variant="secondary"
                  onClick={() =>
                    setLines((s) => [
                      ...s,
                      { master_product_id: master.data?.[0]?.id ?? "", condition: "GOOD", purchase_price: "0,00" },
                    ])
                  }
                  disabled={!master.data?.length}
                >
                  Add line
                </Button>
                {!master.data?.length && <div className="text-xs text-gray-500">Create master products first.</div>}
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Condition</TableHead>
                    <TableHead className="text-right">EK (EUR)</TableHead>
                    <TableHead className="text-right"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l, idx) => (
                    <TableRow key={idx}>
                      <TableCell>
                        <Select
                          value={l.master_product_id}
                          onValueChange={(v) =>
                            setLines((s) => s.map((x, i) => (i === idx ? { ...x, master_product_id: v } : x)))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select…" />
                          </SelectTrigger>
                          <SelectContent>
                            {(master.data ?? []).map((m) => (
                              <SelectItem key={m.id} value={m.id}>
                                {m.title} · {m.platform} · {m.region}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={l.condition}
                          onValueChange={(v) => setLines((s) => s.map((x, i) => (i === idx ? { ...x, condition: v } : x)))}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {["NEW", "LIKE_NEW", "GOOD", "ACCEPTABLE", "DEFECT"].map((c) => (
                              <SelectItem key={c} value={c}>
                                {c}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          className="text-right"
                          value={l.purchase_price}
                          onChange={(e) =>
                            setLines((s) => s.map((x, i) => (i === idx ? { ...x, purchase_price: e.target.value } : x)))
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" onClick={() => setLines((s) => s.filter((_, i) => i !== idx))}>
                          Remove
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!lines.length && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-sm text-gray-500">
                        No lines yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="secondary" onClick={() => list.refetch()}>
            Refresh
          </Button>

          {list.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {(list.error as Error).message}
            </div>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Seller</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Docs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{p.purchase_date}</TableCell>
                  <TableCell>{p.kind}</TableCell>
                  <TableCell>{p.counterparty_name}</TableCell>
                  <TableCell className="text-right">{formatEur(p.total_amount_cents)} €</TableCell>
                  <TableCell className="text-right">
                    {p.pdf_path ? (
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="outline">PDF</Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Purchase PDF</DialogTitle>
                            <DialogDescription>{p.pdf_path}</DialogDescription>
                          </DialogHeader>
                          <DialogFooter>
                            <Button variant="secondary" onClick={() => api.download(p.pdf_path!, p.pdf_path!.split("/").pop()!)}>
                              Download
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {!list.data?.length && (
                <TableRow>
                  <TableCell colSpan={5} className="text-sm text-gray-500">
                    No data.
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

