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

type MasterProduct = { id: string; sku?: string; kind?: string; title: string; platform: string; region: string; variant?: string };

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

const PURCHASE_KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "PRIVATE_DIFF", label: "Privat (Differenz)" },
  { value: "COMMERCIAL_REGULAR", label: "Gewerblich (Regulär)" },
];

const PAYMENT_SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "CASH", label: "Bar" },
  { value: "BANK", label: "Bank" },
];

const CONDITION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "NEW", label: "Neu" },
  { value: "LIKE_NEW", label: "Wie neu" },
  { value: "GOOD", label: "Gut" },
  { value: "ACCEPTABLE", label: "Akzeptabel" },
  { value: "DEFECT", label: "Defekt" },
];

const PURCHASE_TYPE_LABEL: Record<string, string> = {
  DIFF: "Differenz",
  REGULAR: "Regulär",
};

function optionLabel(options: Array<{ value: string; label: string }>, value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

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
  const [taxRateBp, setTaxRateBp] = useState<string>("2000");

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
        tax_rate_bp: kind === "COMMERCIAL_REGULAR" ? Number(taxRateBp) : 0,
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
      <div className="text-xl font-semibold">Einkäufe</div>

      <Card>
        <CardHeader>
          <CardTitle>Einkauf erfassen</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label>Art</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PURCHASE_KIND_OPTIONS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Einkaufstyp ist fest auf {PURCHASE_TYPE_LABEL[purchaseType] ?? purchaseType} gesetzt.
              </div>
            </div>
            <div className="space-y-2">
              <Label>Datum</Label>
              <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Zahlungsquelle</Label>
              <Select value={paymentSource} onValueChange={setPaymentSource}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_SOURCE_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Verkäufer / Lieferant</Label>
              <Input value={counterpartyName} onChange={(e) => setCounterpartyName(e.target.value)} placeholder="Name" />
            </div>
            <div className="space-y-2">
              <Label>Adresse (optional)</Label>
              <Input value={counterpartyAddress} onChange={(e) => setCounterpartyAddress(e.target.value)} placeholder="Adresse" />
            </div>
          </div>

          {kind === "COMMERCIAL_REGULAR" && (
            <div className="grid gap-4 md:grid-cols-4">
              <div className="space-y-2">
                <Label>Externe Rechnungsnummer</Label>
                <Input value={externalInvoiceNumber} onChange={(e) => setExternalInvoiceNumber(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>VAT rate</Label>
                <Select value={taxRateBp} onValueChange={setTaxRateBp}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1000">10%</SelectItem>
                    <SelectItem value="2000">20%</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Beleg-Upload</Label>
                <div className="flex items-center gap-2">
                  <Input value={receiptUploadPath} readOnly placeholder="PDF/Bild hochladen…" />
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
            <Label>Gesamtbetrag (EUR)</Label>
            <Input value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} />
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge variant={splitOk ? "success" : "warning"}>
                Aufteilung: {sumLinesCents === null ? "ungültig" : `${formatEur(sumLinesCents)} €`} / {formatEur(totalCents)} €
              </Badge>
              {!splitOk && <div className="text-xs text-gray-500 dark:text-gray-400">Erstellen ist blockiert, bis die Summen übereinstimmen.</div>}
            </div>
            <Button onClick={() => create.mutate()} disabled={!canSubmit || create.isPending}>
              Erstellen
            </Button>
          </div>

          {create.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
              {(create.error as Error).message}
            </div>
          )}

          <Card className="border-dashed">
            <CardHeader>
              <CardTitle>Positionen</CardTitle>
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
                  Position hinzufügen
                </Button>
                {!master.data?.length && <div className="text-xs text-gray-500 dark:text-gray-400">Erst Produktstamm anlegen.</div>}
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Produkt</TableHead>
                    <TableHead>Zustand</TableHead>
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
                            <SelectValue placeholder="Auswählen…" />
                          </SelectTrigger>
                          <SelectContent>
                            {(master.data ?? []).map((m) => (
                              <SelectItem key={m.id} value={m.id}>
                                {m.sku ? `${m.sku} · ` : ""}{m.title} · {m.platform} · {m.region}
                                {m.variant ? ` · ${m.variant}` : ""}
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
                            {CONDITION_OPTIONS.map((c) => (
                              <SelectItem key={c.value} value={c.value}>
                                {c.label}
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
                          Entfernen
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!lines.length && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-sm text-gray-500 dark:text-gray-400">
                        Noch keine Positionen.
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
          <CardTitle>Historie</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="secondary" onClick={() => list.refetch()}>
            Aktualisieren
          </Button>

          {list.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
              {(list.error as Error).message}
            </div>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Datum</TableHead>
                <TableHead>Art</TableHead>
                <TableHead>Verkäufer</TableHead>
                <TableHead className="text-right">Gesamt</TableHead>
                <TableHead className="text-right">Dokumente</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{p.purchase_date}</TableCell>
                  <TableCell>{optionLabel(PURCHASE_KIND_OPTIONS, p.kind)}</TableCell>
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
                            <DialogTitle>Einkauf (PDF)</DialogTitle>
                            <DialogDescription>{p.pdf_path}</DialogDescription>
                          </DialogHeader>
                          <DialogFooter>
                            <Button variant="secondary" onClick={() => api.download(p.pdf_path!, p.pdf_path!.split("/").pop()!)}>
                              Herunterladen
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    ) : (
                      <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {!list.data?.length && (
                <TableRow>
                  <TableCell colSpan={5} className="text-sm text-gray-500 dark:text-gray-400">
                    Keine Daten.
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
