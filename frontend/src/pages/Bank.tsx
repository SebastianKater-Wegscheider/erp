import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { formatEur } from "../lib/money";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

type BankAccountOut = {
  id: string;
  provider: string;
  external_id: string;
  iban?: string | null;
  name?: string | null;
  currency?: string | null;
  last_synced_at?: string | null;
};

type BankTransactionOut = {
  id: string;
  bank_account_id: string;
  booked_date: string;
  value_date?: string | null;
  amount_cents: number;
  currency: string;
  counterparty_name?: string | null;
  remittance_information?: string | null;
  is_pending: boolean;
  purchase_ids: string[];
};

type PurchaseRefOut = {
  id: string;
  purchase_date: string;
  counterparty_name: string;
  total_amount_cents: number;
  document_number?: string | null;
};

type BankSyncOut = {
  accounts_seen: number;
  accounts_created: number;
  transactions_seen: number;
  transactions_created: number;
  transactions_updated: number;
};

function accountLabel(a: BankAccountOut): string {
  const iban = a.iban ? a.iban : a.external_id;
  const name = a.name ? `${a.name} · ` : "";
  return `${name}${iban}`;
}

function purchaseLabel(p: PurchaseRefOut): string {
  const doc = p.document_number ? `${p.document_number} · ` : "";
  return `${doc}${p.purchase_date} · ${p.counterparty_name} · ${formatEur(p.total_amount_cents)}`;
}

export function BankPage() {
  const api = useApi();
  const qc = useQueryClient();

  const [accountId, setAccountId] = useState<string>("ALL");
  const [scope, setScope] = useState<"ALL" | "UNLINKED">("ALL");
  const [q, setQ] = useState("");

  const [linkOpen, setLinkOpen] = useState(false);
  const [linkTxId, setLinkTxId] = useState<string | null>(null);
  const [purchaseId, setPurchaseId] = useState<string>("");

  const accounts = useQuery({
    queryKey: ["bank", "accounts"],
    queryFn: () => api.request<BankAccountOut[]>("/bank/accounts"),
  });

  const purchases = useQuery({
    queryKey: ["bank", "purchaseRefs"],
    queryFn: () => api.request<PurchaseRefOut[]>("/purchases/refs"),
  });

  const transactions = useQuery({
    queryKey: ["bank", "transactions", accountId, scope, q],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("limit", "300");
      if (accountId !== "ALL") params.set("account_id", accountId);
      if (scope === "UNLINKED") params.set("unlinked_only", "true");
      if (q.trim()) params.set("q", q.trim());
      const qs = params.toString();
      return api.request<BankTransactionOut[]>(`/bank/transactions${qs ? `?${qs}` : ""}`);
    },
  });

  const sync = useMutation({
    mutationFn: () => api.request<BankSyncOut>("/bank/sync", { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["bank"] });
    },
  });

  const link = useMutation({
    mutationFn: ({ txId, purchaseIds }: { txId: string; purchaseIds: string[] }) =>
      api.request<BankTransactionOut>(`/bank/transactions/${txId}/purchases`, {
        method: "POST",
        json: { purchase_ids: purchaseIds },
      }),
    onSuccess: async () => {
      setLinkOpen(false);
      setLinkTxId(null);
      setPurchaseId("");
      await qc.invalidateQueries({ queryKey: ["bank", "transactions"] });
    },
  });

  const accountOptions = accounts.data ?? [];
  const purchaseOptions = purchases.data ?? [];

  const accountSelectItems = useMemo(() => {
    const items = [{ value: "ALL", label: "Alle Konten" }];
    for (const a of accountOptions) items.push({ value: a.id, label: accountLabel(a) });
    return items;
  }, [accountOptions]);

  const purchaseSelectItems = useMemo(() => {
    return purchaseOptions.map((p) => ({ value: p.id, label: purchaseLabel(p) }));
  }, [purchaseOptions]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xl font-semibold">Banktransaktionen</div>
        <Button type="button" onClick={() => sync.mutate()} disabled={sync.isPending}>
          Sync
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filter</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label>Konto</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accountSelectItems.map((it) => (
                  <SelectItem key={it.value} value={it.value}>
                    {it.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Zuordnung</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as "ALL" | "UNLINKED")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Alle</SelectItem>
                <SelectItem value="UNLINKED">Nur unzugeordnet</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Suche</Label>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Gegenpartei oder Verwendungszweck..." />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Liste</CardTitle>
        </CardHeader>
        <CardContent>
          {transactions.isLoading ? (
            <div className="text-sm text-gray-500">Lade...</div>
          ) : transactions.error ? (
            <div className="text-sm text-red-600">Fehler: {(transactions.error as any)?.message ?? "Unbekannt"}</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Datum</TableHead>
                  <TableHead>Betrag</TableHead>
                  <TableHead>Gegenpartei</TableHead>
                  <TableHead>Verwendungszweck</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Zuordnung</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(transactions.data ?? []).map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="whitespace-nowrap">{t.booked_date}</TableCell>
                    <TableCell className="whitespace-nowrap font-medium">{formatEur(t.amount_cents)}</TableCell>
                    <TableCell className="max-w-[220px] truncate">{t.counterparty_name ?? ""}</TableCell>
                    <TableCell className="max-w-[420px] truncate">{t.remittance_information ?? ""}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {t.is_pending ? <Badge variant="secondary">Pending</Badge> : <Badge>Booked</Badge>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {t.purchase_ids.length ? (
                          <Badge variant="secondary">{t.purchase_ids.length} Einkauf(e)</Badge>
                        ) : (
                          <Badge variant="outline">Kein</Badge>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setLinkTxId(t.id);
                            setLinkOpen(true);
                          }}
                        >
                          Zuordnen
                        </Button>
                        {t.purchase_ids.length ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => link.mutate({ txId: t.id, purchaseIds: [] })}
                            disabled={link.isPending}
                          >
                            Entfernen
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transaktion zuordnen</DialogTitle>
            <DialogDescription>Verknüpfen Sie eine Banktransaktion mit einem Einkauf (Purchase).</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label>Einkauf</Label>
            <Select value={purchaseId} onValueChange={setPurchaseId}>
              <SelectTrigger>
                <SelectValue placeholder="Einkauf auswählen" />
              </SelectTrigger>
              <SelectContent>
                {purchaseSelectItems.map((it) => (
                  <SelectItem key={it.value} value={it.value}>
                    {it.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                if (!linkTxId || !purchaseId) return;
                link.mutate({ txId: linkTxId, purchaseIds: [purchaseId] });
              }}
              disabled={link.isPending || !linkTxId || !purchaseId}
            >
              Speichern
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

