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

export function OpexPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().slice(0, 10));
  const [recipient, setRecipient] = useState("");
  const [category, setCategory] = useState("PACKAGING");
  const [amount, setAmount] = useState("0,00");
  const [taxRateBp, setTaxRateBp] = useState("2000");
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
          tax_rate_bp: Number(taxRateBp),
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
      <div className="text-xl font-semibold">OpEx</div>

      <Card>
        <CardHeader>
          <CardTitle>Create</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-4">
          <div className="space-y-2">
            <Label>Date</Label>
            <Input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Recipient</Label>
            <Input value={recipient} onChange={(e) => setRecipient(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["PACKAGING", "POSTAGE", "SOFTWARE", "OFFICE", "CONSULTING", "FEES", "OTHER"].map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Amount (EUR)</Label>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>VAT rate</Label>
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
          <div className="space-y-2 md:col-span-2">
            <Label>Receipt upload (optional)</Label>
            <div className="flex items-center gap-2">
              <Input value={receiptUploadPath} readOnly placeholder="Upload path…" />
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
              Create
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
          <CardTitle>List</CardTitle>
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
                <TableHead>Recipient</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{e.expense_date}</TableCell>
                  <TableCell>{e.recipient}</TableCell>
                  <TableCell>{e.category}</TableCell>
                  <TableCell className="text-right">{formatEur(e.amount_cents)} €</TableCell>
                </TableRow>
              ))}
              {!list.data?.length && (
                <TableRow>
                  <TableCell colSpan={4} className="text-sm text-gray-500">
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
