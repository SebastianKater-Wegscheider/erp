import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { formatEur } from "../lib/money";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

type InventoryItem = {
  id: string;
  master_product_id: string;
  condition: string;
  purchase_type: string;
  purchase_price_cents: number;
  allocated_costs_cents: number;
  storage_location?: string | null;
  status: string;
  acquired_date?: string | null;
};

type MasterProduct = { id: string; title: string; platform: string; region: string };

const INVENTORY_STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "DRAFT", label: "Entwurf" },
  { value: "AVAILABLE", label: "Verfügbar" },
  { value: "RESERVED", label: "Reserviert" },
  { value: "SOLD", label: "Verkauft" },
  { value: "RETURNED", label: "Retourniert" },
  { value: "LOST", label: "Verloren" },
];

const CONDITION_LABEL: Record<string, string> = {
  NEW: "Neu",
  LIKE_NEW: "Wie neu",
  GOOD: "Gut",
  ACCEPTABLE: "Akzeptabel",
  DEFECT: "Defekt",
};

const PURCHASE_TYPE_LABEL: Record<string, string> = {
  DIFF: "Differenz",
  REGULAR: "Regulär",
};

function inventoryStatusLabel(status: string): string {
  const opt = INVENTORY_STATUS_OPTIONS.find((o) => o.value === status);
  return opt?.label ?? status;
}

function conditionLabel(condition: string): string {
  return CONDITION_LABEL[condition] ?? condition;
}

function purchaseTypeLabel(purchaseType: string): string {
  return PURCHASE_TYPE_LABEL[purchaseType] ?? purchaseType;
}

function ageVariant(days: number | null) {
  if (days === null) return { variant: "secondary" as const, label: "k. A." };
  if (days < 30) return { variant: "success" as const, label: `${days}T` };
  if (days <= 90) return { variant: "warning" as const, label: `${days}T` };
  return { variant: "danger" as const, label: `${days}T` };
}

export function InventoryPage() {
  const api = useApi();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("ALL");

  const master = useQuery({
    queryKey: ["master-products"],
    queryFn: () => api.request<MasterProduct[]>("/master-products"),
  });

  const inv = useQuery({
    queryKey: ["inventory", q, status],
    queryFn: () =>
      api.request<InventoryItem[]>(
        `/inventory?limit=50&offset=0${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}${status !== "ALL" ? `&status=${status}` : ""}`,
      ),
  });

  const mpById = useMemo(() => {
    const map = new Map<string, MasterProduct>();
    (master.data ?? []).forEach((m) => map.set(m.id, m));
    return map;
  }, [master.data]);

  const rows = inv.data ?? [];
  const today = new Date();

  return (
    <div className="space-y-4">
      <div className="text-xl font-semibold">Lagerbestand</div>

      <Card>
        <CardHeader>
          <CardTitle>Suche</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 md:flex-row md:items-center">
          <Input placeholder="Titel oder Produktstamm-UUID…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="w-full md:w-56">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Alle</SelectItem>
                {INVENTORY_STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="secondary" onClick={() => inv.refetch()}>
            Aktualisieren
          </Button>
        </CardContent>
      </Card>

      {(inv.isError || master.isError) && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          {((inv.error ?? master.error) as Error).message}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Artikel</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produkt</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Alter</TableHead>
                <TableHead>Zustand</TableHead>
                <TableHead>Typ</TableHead>
                <TableHead className="text-right">Kosten (EUR)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((it) => {
                const mp = mpById.get(it.master_product_id);
                const acquired = it.acquired_date ? new Date(it.acquired_date) : null;
                const days =
                  acquired ? Math.max(0, Math.floor((today.getTime() - acquired.getTime()) / (1000 * 60 * 60 * 24))) : null;
                const av = ageVariant(days);
                return (
                  <TableRow key={it.id}>
                    <TableCell>
                      <div className="font-medium">{mp ? mp.title : it.master_product_id}</div>
                      {mp && <div className="text-xs text-gray-500">{mp.platform} · {mp.region}</div>}
                      <div className="text-xs text-gray-400 font-mono">{it.id}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{inventoryStatusLabel(it.status)}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={av.variant}>{av.label}</Badge>
                    </TableCell>
                    <TableCell>{conditionLabel(it.condition)}</TableCell>
                    <TableCell>{purchaseTypeLabel(it.purchase_type)}</TableCell>
                    <TableCell className="text-right">
                      {formatEur(it.purchase_price_cents + it.allocated_costs_cents)} €
                    </TableCell>
                  </TableRow>
                );
              })}
              {!rows.length && (
                <TableRow>
                  <TableCell colSpan={6} className="text-sm text-gray-500">
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
