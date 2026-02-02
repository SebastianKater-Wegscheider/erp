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
      <div className="text-xl font-semibold">Mileage</div>

      <Card>
        <CardHeader>
          <CardTitle>Create</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-4">
          <div className="space-y-2">
            <Label>Date</Label>
            <Input type="date" value={logDate} onChange={(e) => setLogDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Start</Label>
            <Input value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Destination</Label>
            <Input value={destination} onChange={(e) => setDestination(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Purpose</Label>
            <Select value={purpose} onValueChange={setPurpose}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["BUYING", "POST", "MATERIAL", "OTHER"].map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>KM</Label>
            <Input value={km} onChange={(e) => setKm(e.target.value)} placeholder="e.g. 12.3" />
          </div>
          <div className="flex items-end">
            <Button onClick={() => create.mutate()} disabled={!start.trim() || !destination.trim() || create.isPending}>
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
                <TableHead>Route</TableHead>
                <TableHead>Purpose</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{m.log_date}</TableCell>
                  <TableCell>
                    <div className="font-medium">{m.start_location} → {m.destination}</div>
                    <div className="text-xs text-gray-500">{(m.distance_meters / 1000).toFixed(2)} km</div>
                  </TableCell>
                  <TableCell>{m.purpose}</TableCell>
                  <TableCell className="text-right">{formatEur(m.amount_cents)} €</TableCell>
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

