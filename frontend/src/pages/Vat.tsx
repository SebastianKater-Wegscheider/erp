import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { formatEur } from "../lib/money";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

type VatReportOut = {
  period_start: string;
  period_end: string;
  output_vat_regular_cents: number;
  output_vat_margin_cents: number;
  output_vat_adjustments_regular_cents: number;
  output_vat_adjustments_margin_cents: number;
  input_vat_cents: number;
  vat_payable_cents: number;
};

export function VatPage() {
  const api = useApi();
  const today = useMemo(() => new Date(), []);
  const [year, setYear] = useState(String(today.getFullYear()));
  const [month, setMonth] = useState(String(today.getMonth() + 1).padStart(2, "0"));

  const q = useQuery({
    queryKey: ["vat-report", year, month],
    queryFn: () =>
      api.request<VatReportOut>("/reports/vat", {
        method: "POST",
        json: { year: Number(year), month: Number(month) },
      }),
  });

  const data = q.data;
  return (
    <div className="space-y-4">
      <div className="text-xl font-semibold">Umsatzsteuer</div>

      <Card>
        <CardHeader>
          <CardTitle>Zeitraum</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-4">
          <div className="space-y-2">
            <Label>Jahr</Label>
            <Input value={year} onChange={(e) => setYear(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Monat</Label>
            <Input value={month} onChange={(e) => setMonth(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button variant="secondary" onClick={() => q.refetch()} disabled={q.isFetching}>
              Aktualisieren
            </Button>
          </div>
          {data && (
            <div className="flex items-end text-sm text-gray-600">
              {data.period_start} → {data.period_end}
            </div>
          )}
        </CardContent>
      </Card>

      {q.isError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          {(q.error as Error).message}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>USt (Regelbesteuerung)</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {data ? `${formatEur(data.output_vat_regular_cents - data.output_vat_adjustments_regular_cents)} €` : "…"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>USt (Differenzbesteuerung)</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {data ? `${formatEur(data.output_vat_margin_cents - data.output_vat_adjustments_margin_cents)} €` : "…"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Vorsteuer</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{data ? `${formatEur(data.input_vat_cents)} €` : "…"}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Zahllast</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{data ? `${formatEur(data.vat_payable_cents)} €` : "…"}</CardContent>
        </Card>
      </div>
    </div>
  );
}
