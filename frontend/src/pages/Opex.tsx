import { Plus, RefreshCw, Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { formatDateEuFromIso } from "../lib/dates";
import { useTaxProfile } from "../lib/taxProfile";
import { formatEur, parseEurToCents } from "../lib/money";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

type OpexOut = {
  id: string;
  expense_date: string;
  recipient: string;
  category: string;
  amount_cents: number;
  payment_source: string;
  receipt_upload_path?: string | null;
};

type UploadOut = { upload_path: string };

const CATEGORY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "PACKAGING", label: "Verpackung" },
  { value: "POSTAGE", label: "Porto" },
  { value: "SOFTWARE", label: "Software" },
  { value: "OFFICE", label: "Büro" },
  { value: "CONSULTING", label: "Beratung" },
  { value: "FEES", label: "Gebühren" },
  { value: "OTHER", label: "Sonstiges" },
];

const PAYMENT_SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "CASH", label: "Bar" },
  { value: "BANK", label: "Bank" },
];

function optionLabel(options: Array<{ value: string; label: string }>, value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

export function OpexPage() {
  const api = useApi();
  const qc = useQueryClient();
  const taxProfile = useTaxProfile();
  const vatEnabled = taxProfile.data?.vat_enabled ?? true;
  const formRef = useRef<HTMLDivElement | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().slice(0, 10));
  const [recipient, setRecipient] = useState("");
  const [category, setCategory] = useState("PACKAGING");
  const [amount, setAmount] = useState("0,00");
  const [taxRateBp, setTaxRateBp] = useState("2000");
  const [paymentSource, setPaymentSource] = useState("CASH");
  const [receiptUploadPath, setReceiptUploadPath] = useState("");
  const [search, setSearch] = useState("");

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.request<UploadOut>("/uploads", { method: "POST", body: fd });
    },
    onSuccess: (r) => setReceiptUploadPath(r.upload_path),
  });

  const list = useQuery({
    queryKey: ["opex"],
    queryFn: () => api.request<OpexOut[]>("/opex"),
  });

  const create = useMutation({
    mutationFn: () =>
      api.request<OpexOut>("/opex", {
        method: "POST",
        json: {
          expense_date: expenseDate,
          recipient,
          category,
          amount_cents: parseEurToCents(amount),
          tax_rate_bp: vatEnabled ? Number(taxRateBp) : 0,
          payment_source: paymentSource,
          receipt_upload_path: receiptUploadPath || null,
        },
      }),
    onSuccess: async () => {
      setRecipient("");
      setAmount("0,00");
      setReceiptUploadPath("");
      await qc.invalidateQueries({ queryKey: ["opex"] });
    },
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = list.data ?? [];
    if (!q) return all;
    return all.filter((e) => {
      const key = `${e.expense_date} ${e.recipient} ${e.category} ${e.payment_source} ${e.receipt_upload_path ?? ""}`.toLowerCase();
      return key.includes(q);
    });
  }, [list.data, search]);

  const totalCount = list.data?.length ?? 0;

  function openForm() {
    create.reset();
    upload.reset();
    setFormOpen(true);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function closeForm() {
    create.reset();
    upload.reset();
    setFormOpen(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-xl font-semibold">Betriebsausgaben</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Ausgaben erfassen, Belege ablegen und für die Steuer aufbereiten.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => list.refetch()} disabled={list.isFetching}>
            <RefreshCw className="h-4 w-4" />
            Aktualisieren
          </Button>
          <Button onClick={openForm}>
            <Plus className="h-4 w-4" />
            Ausgabe erfassen
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-col gap-1">
            <CardTitle>Historie</CardTitle>
            <CardDescription>
              {list.isPending ? "Lade…" : `${rows.length}${rows.length !== totalCount ? ` / ${totalCount}` : ""} Einträge`}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-1 items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
                <Input
                  placeholder="Suchen (Empfänger, Kategorie, Zahlungsquelle, …)"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              {search.trim() && (
                <Button type="button" variant="ghost" size="icon" onClick={() => setSearch("")} aria-label="Suche löschen">
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          {list.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
              {(list.error as Error).message}
            </div>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Datum</TableHead>
                <TableHead>Ausgabe</TableHead>
                <TableHead className="text-right">Betrag</TableHead>
                <TableHead className="text-right">Beleg</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e) => {
                const cat = optionLabel(CATEGORY_OPTIONS, e.category);
                const pay = optionLabel(PAYMENT_SOURCE_OPTIONS, e.payment_source);
                return (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap">{formatDateEuFromIso(e.expense_date)}</TableCell>
                    <TableCell>
                      <div className="font-medium text-gray-900 dark:text-gray-100">{e.recipient}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">{cat}</Badge>
                        <Badge variant="outline">{pay}</Badge>
                        {e.receipt_upload_path ? (
                          <span className="text-xs text-gray-500 dark:text-gray-400">{e.receipt_upload_path.split("/").pop()}</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-medium">{formatEur(e.amount_cents)} €</TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      {e.receipt_upload_path ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => api.download(e.receipt_upload_path!, e.receipt_upload_path!.split("/").pop()!)}
                        >
                          Öffnen
                        </Button>
                      ) : (
                        <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {!rows.length && (
                <TableRow>
                  <TableCell colSpan={4} className="text-sm text-gray-500 dark:text-gray-400">
                    Keine Daten.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {formOpen && (
        <div ref={formRef}>
          <Card>
            <CardHeader>
              <CardTitle>Erfassen</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-4">
                <div className="space-y-2">
                  <Label>Datum</Label>
                  <Input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Empfänger</Label>
                  <Input value={recipient} onChange={(e) => setRecipient(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Kategorie</Label>
                  <Select value={category} onValueChange={setCategory}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORY_OPTIONS.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Betrag (EUR)</Label>
                  <Input value={amount} onChange={(e) => setAmount(e.target.value)} />
                </div>
                <div className="space-y-2">
                  {vatEnabled ? (
                    <>
                      <Label>USt-Satz</Label>
                      <Select value={taxRateBp} onValueChange={setTaxRateBp}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="0">0%</SelectItem>
                          <SelectItem value="1000">10%</SelectItem>
                          <SelectItem value="2000">20%</SelectItem>
                        </SelectContent>
                      </Select>
                    </>
                  ) : (
                    <>
                      <Label>Umsatzsteuer</Label>
                      <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700 dark:border-gray-800 dark:bg-gray-900/50 dark:text-gray-200">
                        Kleinunternehmerregelung aktiv: keine USt-Berechnung.
                      </div>
                    </>
                  )}
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
                <div className="space-y-2 md:col-span-2">
                  <Label>Beleg-Upload (optional)</Label>
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

              <div className="flex items-center justify-between">
                <Button type="button" variant="secondary" onClick={closeForm} disabled={create.isPending}>
                  Schließen
                </Button>
                <Button onClick={() => create.mutate()} disabled={!recipient.trim() || create.isPending}>
                  Erstellen
                </Button>
              </div>

              {create.isError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                  {(create.error as Error).message}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
