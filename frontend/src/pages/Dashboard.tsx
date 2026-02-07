import { useQuery } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { formatEur } from "../lib/money";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

type DashboardOut = {
  inventory_value_cents: number;
  cash_balance_cents: Record<string, number>;
  gross_profit_month_cents: number;
};

export function DashboardPage() {
  const api = useApi();
  const q = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.request<DashboardOut>("/reports/dashboard"),
  });

  const data = q.data;
  return (
    <div className="space-y-4">
      <div className="text-xl font-semibold">Übersicht</div>

      {q.isError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
          {(q.error as Error).message}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Lagerwert</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{data ? `${formatEur(data.inventory_value_cents)} €` : "…"}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Bruttogewinn (Monat)</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{data ? `${formatEur(data.gross_profit_month_cents)} €` : "…"}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Kasse/Bank</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {data ? (
              Object.entries(data.cash_balance_cents).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between">
                  <div className="text-gray-600 dark:text-gray-300">{k}</div>
                  <div className="font-medium">{formatEur(v)} €</div>
                </div>
              ))
            ) : (
              <div>…</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
