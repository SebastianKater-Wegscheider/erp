import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { formatEur, parseEurToCents } from "../lib/money";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
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
  const [allocationDate, setAllocationDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [paymentSource, setPaymentSource] = useState("CASH");
  const [lines, setLines] = useState<Line[]>([]);

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

  return (
    <div className="space-y-4">
      <div className="text-xl font-semibold">Kostenverteilung</div>

      <Card>
        <CardHeader>
          <CardTitle>Erfassen</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label>Datum</Label>
              <Input type="date" value={allocationDate} onChange={(e) => setAllocationDate(e.target.value)} />
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
              placeholder="z. B. Disc-Reinigung / FBA-Inbound-Versand"
            />
          </div>

          <div className="flex items-center justify-between">
            <Badge variant={sumCents > 0 ? "success" : "secondary"}>Summe: {formatEur(sumCents)} €</Badge>
            <Button onClick={() => create.mutate()} disabled={!canSubmit || create.isPending}>
              Erstellen
            </Button>
          </div>

          {create.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
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
                    <TableCell colSpan={3} className="text-sm text-gray-500">
                      Noch keine Positionen.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
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
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {(list.error as Error).message}
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Datum</TableHead>
                <TableHead>Beschreibung</TableHead>
                <TableHead className="text-right">Betrag</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{a.allocation_date}</TableCell>
                  <TableCell>{a.description}</TableCell>
                  <TableCell className="text-right">{formatEur(a.amount_cents)} €</TableCell>
                </TableRow>
              ))}
              {!list.data?.length && (
                <TableRow>
                  <TableCell colSpan={3} className="text-sm text-gray-500">
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
