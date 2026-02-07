import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { formatEur } from "../lib/money";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

type MileageOut = {
  id: string;
  log_date: string;
  start_location: string;
  destination: string;
  purpose: string;
  distance_meters: number;
  rate_cents_per_km: number;
  amount_cents: number;
};

const PURPOSE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "BUYING", label: "Einkauf" },
  { value: "POST", label: "Post" },
  { value: "MATERIAL", label: "Material" },
  { value: "OTHER", label: "Sonstiges" },
];

function optionLabel(options: Array<{ value: string; label: string }>, value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

export function MileagePage() {
  const api = useApi();
  const qc = useQueryClient();
  const [logDate, setLogDate] = useState(new Date().toISOString().slice(0, 10));
  const [start, setStart] = useState("");
  const [destination, setDestination] = useState("");
  const [purpose, setPurpose] = useState("BUYING");
  const [km, setKm] = useState("0");

  const list = useQuery({
    queryKey: ["mileage"],
    queryFn: () => api.request<MileageOut[]>("/mileage"),
  });

  const create = useMutation({
    mutationFn: () =>
      api.request<MileageOut>("/mileage", {
        method: "POST",
        json: {
          log_date: logDate,
          start_location: start,
          destination,
          purpose,
          km,
          purchase_id: null,
        },
      }),
    onSuccess: async () => {
      setStart("");
      setDestination("");
      setKm("0");
      await qc.invalidateQueries({ queryKey: ["mileage"] });
    },
  });

  return (
    <div className="space-y-4">
      <div className="text-xl font-semibold">Fahrtenbuch</div>

      <Card>
        <CardHeader>
          <CardTitle>Erfassen</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-4">
          <div className="space-y-2">
            <Label>Datum</Label>
            <Input type="date" value={logDate} onChange={(e) => setLogDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Start</Label>
            <Input value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Ziel</Label>
            <Input value={destination} onChange={(e) => setDestination(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Zweck</Label>
            <Select value={purpose} onValueChange={setPurpose}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PURPOSE_OPTIONS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>km</Label>
            <Input value={km} onChange={(e) => setKm(e.target.value)} placeholder="z. B. 12.3" />
          </div>
          <div className="flex items-end">
            <Button onClick={() => create.mutate()} disabled={!start.trim() || !destination.trim() || create.isPending}>
              Erstellen
            </Button>
          </div>
          {create.isError && (
            <div className="md:col-span-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
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
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
              {(list.error as Error).message}
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Datum</TableHead>
                <TableHead>Strecke</TableHead>
                <TableHead>Zweck</TableHead>
                <TableHead className="text-right">Betrag</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{m.log_date}</TableCell>
                  <TableCell>
                    <div className="font-medium">{m.start_location} → {m.destination}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{(m.distance_meters / 1000).toFixed(2)} km</div>
                  </TableCell>
                  <TableCell>{optionLabel(PURPOSE_OPTIONS, m.purpose)}</TableCell>
                  <TableCell className="text-right">{formatEur(m.amount_cents)} €</TableCell>
                </TableRow>
              ))}
              {!list.data?.length && (
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
    </div>
  );
}
