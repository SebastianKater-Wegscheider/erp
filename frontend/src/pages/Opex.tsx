import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { formatEur, parseEurToCents } from "../lib/money";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
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
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().slice(0, 10));
  const [recipient, setRecipient] = useState("");
  const [category, setCategory] = useState("PACKAGING");
  const [amount, setAmount] = useState("0,00");
  const [paymentSource, setPaymentSource] = useState("CASH");
  const [receiptUploadPath, setReceiptUploadPath] = useState("");

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

  return (
    <div className="space-y-4">
      <div className="text-xl font-semibold">Betriebsausgaben</div>

      <Card>
        <CardHeader>
          <CardTitle>Erfassen</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-4">
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
              <Input value={receiptUploadPath} readOnly placeholder="Upload-Pfad…" />
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
          <div className="flex items-end">
            <Button onClick={() => create.mutate()} disabled={!recipient.trim() || create.isPending}>
              Erstellen
            </Button>
          </div>
          {create.isError && (
            <div className="md:col-span-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {(create.error as Error).message}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Liste</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="secondary" onClick={() => list.refetch()}>
            Aktualisieren
          </Button>
          {list.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {(list.error as Error).message}
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Datum</TableHead>
                <TableHead>Empfänger</TableHead>
                <TableHead>Kategorie</TableHead>
                <TableHead className="text-right">Betrag</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{e.expense_date}</TableCell>
                  <TableCell>{e.recipient}</TableCell>
                  <TableCell>{optionLabel(CATEGORY_OPTIONS, e.category)}</TableCell>
                  <TableCell className="text-right">{formatEur(e.amount_cents)} €</TableCell>
                </TableRow>
              ))}
              {!list.data?.length && (
                <TableRow>
                  <TableCell colSpan={4} className="text-sm text-gray-500">
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
