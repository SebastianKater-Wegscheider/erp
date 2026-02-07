import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { useTaxProfile } from "../lib/taxProfile";
import { formatEur } from "../lib/money";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
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
  const taxProfile = useTaxProfile();
  const vatEnabled = taxProfile.data?.vat_enabled ?? true;
  const today = useMemo(() => new Date(), []);
  const [yearInput, setYearInput] = useState(String(today.getFullYear()));
  const [monthInput, setMonthInput] = useState(String(today.getMonth() + 1).padStart(2, "0"));
  const [year, setYear] = useState<number>(today.getFullYear());
  const [month, setMonth] = useState<number>(today.getMonth() + 1);

  const q = useQuery({
    queryKey: ["vat-report", year, month],
    queryFn: () =>
      api.request<VatReportOut>("/reports/vat", {
        method: "POST",
        json: { year, month },
      }),
  });

  const data = q.data;
  const parsedYear = Number(yearInput);
  const parsedMonth = Number(monthInput);
  const periodValid =
    Number.isInteger(parsedYear) &&
    Number.isInteger(parsedMonth) &&
    parsedYear >= 1900 &&
    parsedYear <= 2100 &&
    parsedMonth >= 1 &&
    parsedMonth <= 12;

  function applyPeriod() {
    if (!periodValid) return;
    const changed = parsedYear !== year || parsedMonth !== month;
    setYear(parsedYear);
    setMonth(parsedMonth);
    if (!changed) void q.refetch();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-xl font-semibold">Umsatzsteuer</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Monatsauswertung für Regelbesteuerung und Differenzbesteuerung.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={applyPeriod} disabled={!periodValid || q.isFetching}>
            <RefreshCw className="h-4 w-4" />
            Berechnen
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-col gap-1">
            <CardTitle>Zeitraum</CardTitle>
            <CardDescription>
              {data ? `${data.period_start} → ${data.period_end}` : "Wählen Sie Jahr und Monat."}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-4">
          <div className="space-y-2">
            <Label>Jahr</Label>
            <Input inputMode="numeric" value={yearInput} onChange={(e) => setYearInput(e.target.value)} placeholder="YYYY" />
          </div>
          <div className="space-y-2">
            <Label>Monat</Label>
            <Input inputMode="numeric" value={monthInput} onChange={(e) => setMonthInput(e.target.value)} placeholder="1-12" />
          </div>
          <div className="flex items-end text-sm text-gray-600 dark:text-gray-300">
            {periodValid ? (
              <span>
                Aktiv: {String(month).padStart(2, "0")}.{year}
              </span>
            ) : (
              <span className="text-red-700 dark:text-red-300">Ungültiger Zeitraum</span>
            )}
          </div>
        </CardContent>
      </Card>

      {!vatEnabled && (
        <Card>
          <CardHeader className="space-y-2">
            <div className="flex flex-col gap-1">
              <CardTitle>Kleinunternehmerregelung aktiv</CardTitle>
              <CardDescription>
                Umsatzsteuer/Vorsteuer wird aktuell nicht berechnet.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="text-sm text-gray-700 dark:text-gray-200">
            {taxProfile.data?.small_business_notice ? (
              <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-gray-800 dark:border-gray-800 dark:bg-gray-900/50 dark:text-gray-100">
                {taxProfile.data.small_business_notice}
              </div>
            ) : (
              <div className="text-gray-600 dark:text-gray-300">Hinweis: Kleinunternehmerregelung ist aktiv.</div>
            )}
          </CardContent>
        </Card>
      )}

      {q.isError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
          {(q.error as Error).message}
        </div>
      )}

      {vatEnabled && (
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
      )}
    </div>
  );
}
