import { Plus, RefreshCw, Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { formatDateEuFromIso } from "../lib/dates";
import { formatEur, parseEurToCents } from "../lib/money";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

type AllocationOut = {
  id: string;
  allocation_date: string;
  description: string;
  amount_cents: number;
  payment_source: string;
};

type Line = { inventory_item_id: string; amount: string };

const PAYMENT_SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "CASH", label: "Bar" },
  { value: "BANK", label: "Bank" },
];

export function CostAllocationsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const formRef = useRef<HTMLDivElement | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [allocationDate, setAllocationDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [taxRateBp, setTaxRateBp] = useState("2000");
  const [paymentSource, setPaymentSource] = useState("CASH");
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState("");

  const sumCents = useMemo(() => {
    let sum = 0;
    for (const l of lines) {
      if (!l.inventory_item_id.trim()) continue;
      sum += parseEurToCents(l.amount || "0");
    }
    return sum;
  }, [lines]);

  const list = useQuery({
    queryKey: ["cost-allocations"],
    queryFn: () => api.request<AllocationOut[]>("/cost-allocations"),
  });

  const create = useMutation({
    mutationFn: () =>
      api.request<AllocationOut>("/cost-allocations", {
        method: "POST",
        json: {
          allocation_date: allocationDate,
          description,
          amount_cents: sumCents,
          tax_rate_bp: Number(taxRateBp),
          payment_source: paymentSource,
          receipt_upload_path: null,
          lines: lines
            .filter((l) => l.inventory_item_id.trim())
            .map((l) => ({
              inventory_item_id: l.inventory_item_id.trim(),
              amount_cents: parseEurToCents(l.amount || "0"),
            })),
        },
      }),
    onSuccess: async () => {
      setDescription("");
      setLines([]);
      await qc.invalidateQueries({ queryKey: ["cost-allocations"] });
    },
  });

  const canSubmit = description.trim() && lines.some((l) => l.inventory_item_id.trim()) && sumCents > 0;

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = list.data ?? [];
    if (!q) return all;
    return all.filter((a) => `${a.allocation_date} ${a.description} ${a.payment_source} ${formatEur(a.amount_cents)}`.toLowerCase().includes(q));
  }, [list.data, search]);

  const totalCount = list.data?.length ?? 0;

  function openForm() {
    create.reset();
    setFormOpen(true);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function closeForm() {
    create.reset();
    setFormOpen(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-xl font-semibold">Kostenverteilung</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Zusätzliche Kosten (Reinigung, Versand, Gebühren) anteilig auf Lagerartikel verteilen.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => list.refetch()} disabled={list.isFetching}>
            <RefreshCw className="h-4 w-4" />
            Aktualisieren
          </Button>
          <Button onClick={openForm}>
            <Plus className="h-4 w-4" />
            Kosten verteilen
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
                  placeholder="Suchen (Beschreibung, Quelle, Betrag, …)"
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
                <TableHead>Beschreibung</TableHead>
                <TableHead>Quelle</TableHead>
                <TableHead className="text-right">Betrag</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="whitespace-nowrap">{formatDateEuFromIso(a.allocation_date)}</TableCell>
                  <TableCell>{a.description}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{a.payment_source === "CASH" ? "Bar" : "Bank"}</Badge>
                  </TableCell>
                  <TableCell className="text-right">{formatEur(a.amount_cents)} €</TableCell>
                </TableRow>
              ))}
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
                  <Input type="date" value={allocationDate} onChange={(e) => setAllocationDate(e.target.value)} />
                </div>
                <div className="space-y-2">
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
                <div className="space-y-2">
                  <Label>Summe (berechnet)</Label>
                  <Input value={`${formatEur(sumCents)} €`} readOnly />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Beschreibung</Label>
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="z. B. Disc-Reinigung / FBA-Inbound-Versand"
                />
              </div>

              <div className="flex items-center justify-between">
                <Badge variant={sumCents > 0 ? "success" : "secondary"}>Summe: {formatEur(sumCents)} €</Badge>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="secondary" onClick={closeForm} disabled={create.isPending}>
                    Schließen
                  </Button>
                  <Button onClick={() => create.mutate()} disabled={!canSubmit || create.isPending}>
                    Erstellen
                  </Button>
                </div>
              </div>

              {create.isError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                  {(create.error as Error).message}
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="font-medium">Positionen</div>
                  <Button variant="secondary" onClick={() => setLines((s) => [...s, { inventory_item_id: "", amount: "0,00" }])}>
                    Position hinzufügen
                  </Button>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Lagerartikel-UUID</TableHead>
                      <TableHead className="text-right">Betrag (EUR)</TableHead>
                      <TableHead className="text-right"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map((l, idx) => (
                      <TableRow key={idx}>
                        <TableCell>
                          <Input
                            value={l.inventory_item_id}
                            onChange={(e) => setLines((s) => s.map((x, i) => (i === idx ? { ...x, inventory_item_id: e.target.value } : x)))}
                            placeholder="UUID…"
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            className="text-right"
                            value={l.amount}
                            onChange={(e) => setLines((s) => s.map((x, i) => (i === idx ? { ...x, amount: e.target.value } : x)))}
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
                        <TableCell colSpan={3} className="text-sm text-gray-500 dark:text-gray-400">
                          Noch keine Positionen.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
