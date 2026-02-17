import { ArrowUpRight, Boxes, ChevronDown, ChevronUp, ExternalLink, PackagePlus, ReceiptText, RefreshCw, Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { useApi } from "../lib/api";
import { formatEur } from "../lib/money";
import { BarList } from "../components/charts/BarList";
import { MultiLineChart } from "../components/charts/MultiLineChart";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { InlineMessage } from "../components/ui/inline-message";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { TABLE_CELL_NUMERIC_CLASS, TABLE_ROW_COMPACT_CLASS } from "../components/ui/table-row-layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";

type CompanyDashboardOut = {
  inventory_value_cents: number;
  cash_balance_cents: Record<string, number>;
  gross_profit_month_cents: number;

  sales_revenue_30d_cents: number;
  gross_profit_30d_cents: number;
  sales_timeseries: Array<{
    date: string;
    revenue_cents: number;
    profit_cents: number;
    orders_count: number;
  }>;
  revenue_by_channel_30d_cents: Record<string, number>;

  inventory_status_counts: Record<string, number>;
  inventory_aging: Array<{ label: string; count: number; value_cents: number }>;

  sales_orders_draft_count: number;
  finalized_orders_missing_invoice_pdf_count: number;
  inventory_draft_count: number;
  inventory_reserved_count: number;
  inventory_returned_count: number;
  inventory_missing_photos_count: number;
  inventory_missing_storage_location_count: number;
  inventory_amazon_stale_count: number;
  inventory_old_stock_90d_count: number;
  negative_profit_orders_30d_count: number;
  master_products_missing_asin_count: number;
  amazon_inventory: {
    computed_at: string;
    in_stock_units_total: number;
    in_stock_units_priced: number;
    in_stock_market_gross_cents: number;
    in_stock_fba_payout_cents: number;
    in_stock_margin_cents: number;
    in_stock_units_missing_asin: number;
    in_stock_units_fresh: number;
    in_stock_units_stale_or_blocked: number;
    in_stock_units_blocked: number;
    in_stock_units_manual_priced: number;
    in_stock_units_auto_priced: number;
    in_stock_units_unpriced: number;
    in_stock_units_effective_priced: number;
    positive_margin_units: number;
    negative_margin_units: number;
    top_opportunities: Array<{
      master_product_id: string;
      sku: string;
      title: string;
      platform: string;
      region: string;
      variant: string;
      units_total: number;
      units_priced: number;
      market_gross_cents_total: number;
      fba_payout_cents_total: number;
      margin_cents_total: number;
      amazon_last_success_at?: string | null;
      amazon_blocked_last?: boolean | null;
      amazon_rank_overall?: number | null;
      amazon_rank_specific?: number | null;
      amazon_offers_count_total?: number | null;
      amazon_offers_count_used_priced_total?: number | null;
    }>;
  };
  accounting: {
    window_months: number;
    current_month: string;
    current_cash_inflow_cents: number;
    current_cash_outflow_cents: number;
    current_cash_net_cents: number;
    current_accrual_income_cents: number;
    current_accrual_expenses_cents: number;
    current_accrual_operating_result_cents: number;
    current_vat_payable_cents: number;
    average_cash_burn_3m_cents: number;
    estimated_runway_months: number | null;
    current_outflow_breakdown_cents: Record<string, number>;
    current_opex_by_category_cents: Record<string, number>;
    months: Array<{
      month: string;
      cash_inflow_cents: number;
      cash_outflow_cents: number;
      cash_net_cents: number;
      accrual_income_cents: number;
      accrual_expenses_cents: number;
      accrual_operating_result_cents: number;
    }>;
    insights: Array<{
      key: string;
      tone: "info" | "warning" | "danger";
      text: string;
    }>;
  };

  top_products_30d: Array<ProductAgg>;
  worst_products_30d: Array<ProductAgg>;
};

type ProductAgg = {
  master_product_id: string;
  sku: string;
  title: string;
  platform: string;
  region: string;
  variant: string;
  units_sold: number;
  revenue_cents: number;
  profit_cents: number;
};

const CHANNEL_LABEL: Record<string, string> = {
  AMAZON: "Amazon",
  EBAY: "eBay",
  WILLHABEN: "willhaben",
  OTHER: "Sonstiges",
};

const INVENTORY_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Entwurf",
  AVAILABLE: "Verfügbar",
  FBA_INBOUND: "FBA Unterwegs",
  FBA_WAREHOUSE: "FBA Lagernd",
  RESERVED: "Reserviert",
  SOLD: "Verkauft",
  RETURNED: "Retourniert",
  DISCREPANCY: "Abweichung",
  LOST: "Verloren",
};

const ACCOUNTING_OUTFLOW_LABEL: Record<string, string> = {
  purchase: "Einkauf",
  opex: "OpEx",
  cost_allocation: "Kostenallokation",
  sales_correction: "Refund/Korrektur",
  other: "Sonstiges",
};

const OPEX_CATEGORY_LABEL: Record<string, string> = {
  PACKAGING: "Verpackung",
  POSTAGE: "Versand",
  SOFTWARE: "Software",
  OFFICE: "Buero",
  CONSULTING: "Beratung",
  FEES: "Gebuehren",
  OTHER: "Sonstiges",
};

function kleinanzeigenSlug(q: string): string {
  const s = q
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "suche";
}

function ebayEndingSoonGermanyUrl(q: string): string {
  const kw = encodeURIComponent(q.trim() || "gamecube");
  return `https://www.ebay.de/sch/i.html?_nkw=${kw}&_sacat=0&_from=R40&LH_Auction=1&_sop=44&rt=nc&LH_PrefLoc=1`;
}

function ebayBuyNowGermanyUrl(q: string): string {
  const kw = encodeURIComponent(q.trim() || "gamecube");
  return `https://www.ebay.de/sch/i.html?_nkw=${kw}&_sacat=0&_from=R40&LH_BIN=1&_sop=15&rt=nc&LH_PrefLoc=1`;
}

function kleinanzeigenUrl(q: string): string {
  return `https://www.kleinanzeigen.de/s-${encodeURIComponent(kleinanzeigenSlug(q))}/k0`;
}

export function DashboardPage() {
  const api = useApi();
  const [sourcingQ, setSourcingQ] = useState("gamecube");
  const q = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.request<CompanyDashboardOut>("/reports/company-dashboard"),
  });

  const data = q.data;
  const [rangeDays, setRangeDays] = useState<7 | 30 | 90>(30);
  const [accountingView, setAccountingView] = useState<"cashflow" | "accrual">("cashflow");
  const [showAccountingDetails, setShowAccountingDetails] = useState(false);
  const ts = useMemo(() => {
    const all = data?.sales_timeseries ?? [];
    const slice = rangeDays >= all.length ? all : all.slice(all.length - rangeDays);
    return slice.map((p) => ({
      x: p.date,
      revenue_eur: p.revenue_cents / 100,
      profit_eur: p.profit_cents / 100,
      orders: p.orders_count,
    }));
  }, [data?.sales_timeseries, rangeDays]);

  const totals = useMemo(() => {
    const points = data?.sales_timeseries ?? [];
    const slice = rangeDays >= points.length ? points : points.slice(points.length - rangeDays);
    const revenue = slice.reduce((s, p) => s + p.revenue_cents, 0);
    const profit = slice.reduce((s, p) => s + p.profit_cents, 0);
    const orders = slice.reduce((s, p) => s + p.orders_count, 0);
    return { revenue, profit, orders };
  }, [data?.sales_timeseries, rangeDays]);

  const accountingMonths = useMemo(() => data?.accounting?.months ?? [], [data?.accounting?.months]);

  const accountingChartData = useMemo(
    () =>
      accountingMonths.map((month) => ({
        x: month.month,
        cash_income_eur: month.cash_inflow_cents / 100,
        cash_expenses_eur: month.cash_outflow_cents / 100,
        cash_net_eur: month.cash_net_cents / 100,
        accrual_income_eur: month.accrual_income_cents / 100,
        accrual_expenses_eur: month.accrual_expenses_cents / 100,
        accrual_operating_eur: month.accrual_operating_result_cents / 100,
      })),
    [accountingMonths],
  );

  const accountingOutflowBars = useMemo(() => {
    const rows = Object.entries(data?.accounting?.current_outflow_breakdown_cents ?? {}).map(([key, cents]) => ({
      key,
      label: ACCOUNTING_OUTFLOW_LABEL[key] ?? key,
      cents,
    }));
    rows.sort((a, b) => b.cents - a.cents);
    return rows;
  }, [data?.accounting?.current_outflow_breakdown_cents]);

  const accountingOpexRows = useMemo(() => {
    const rows = Object.entries(data?.accounting?.current_opex_by_category_cents ?? {}).map(([key, cents]) => ({
      key,
      label: OPEX_CATEGORY_LABEL[key] ?? key,
      cents,
    }));
    rows.sort((a, b) => b.cents - a.cents);
    return rows;
  }, [data?.accounting?.current_opex_by_category_cents]);

  const cashRows = useMemo(() => {
    const rows = Object.entries(data?.cash_balance_cents ?? {});
    rows.sort((a, b) => a[0].localeCompare(b[0]));
    return rows;
  }, [data?.cash_balance_cents]);

  const channelBars = useMemo(() => {
    const rows = Object.entries(data?.revenue_by_channel_30d_cents ?? {}).map(([channel, cents]) => ({
      channel,
      cents,
    }));
    rows.sort((a, b) => b.cents - a.cents);
    return rows.map((r) => ({
      key: r.channel,
      label: CHANNEL_LABEL[r.channel] ?? r.channel,
      value: r.cents,
      valueLabel: `${formatEur(r.cents)} €`,
      barClassName: r.channel === "AMAZON" ? "bg-amber-500 dark:bg-amber-400" : undefined,
    }));
  }, [data?.revenue_by_channel_30d_cents]);

  const inventoryStatusBadges = useMemo(() => {
    const entries = Object.entries(data?.inventory_status_counts ?? {});
    entries.sort((a, b) => (INVENTORY_STATUS_LABEL[a[0]] ?? a[0]).localeCompare(INVENTORY_STATUS_LABEL[b[0]] ?? b[0]));
    return entries.map(([status, count]) => ({
      status,
      count,
      label: INVENTORY_STATUS_LABEL[status] ?? status,
      variant:
        status === "AVAILABLE" || status === "FBA_WAREHOUSE"
          ? ("success" as const)
          : status === "RESERVED" || status === "FBA_INBOUND"
            ? ("warning" as const)
            : status === "RETURNED" || status === "LOST" || status === "DISCREPANCY"
              ? ("danger" as const)
              : ("secondary" as const),
    }));
  }, [data?.inventory_status_counts]);

  const amazonTopOpportunities = useMemo(
    () => data?.amazon_inventory?.top_opportunities ?? [],
    [data?.amazon_inventory?.top_opportunities],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Übersicht"
        description="Kennzahlen, Performance und nächste Schritte auf einen Blick."
        actions={
          <Button variant="secondary" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className="h-4 w-4" />
            Aktualisieren
          </Button>
        }
        actionsClassName="w-full sm:w-auto"
      />

      {q.isError && (
        <InlineMessage tone="error">
          {(q.error as Error).message}
        </InlineMessage>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Lagerwert</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{data ? `${formatEur(data.inventory_value_cents)} €` : "…"}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Umsatz (30T)</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{data ? `${formatEur(data.sales_revenue_30d_cents)} €` : "…"}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Gewinn (30T)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={["text-2xl font-semibold", data && data.gross_profit_30d_cents < 0 ? "text-red-700 dark:text-red-300" : ""].join(" ")}>
              {data ? `${formatEur(data.gross_profit_30d_cents)} €` : "…"}
            </div>
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Bruttogewinn (Monat): {data ? `${formatEur(data.gross_profit_month_cents)} €` : "…"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Kasse/Bank</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {data ? (
              cashRows.length ? (
                cashRows.map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-3">
                    <div className="min-w-0 truncate text-gray-600 dark:text-gray-300">{k}</div>
                    <div className="shrink-0 font-medium">{formatEur(v)} €</div>
                  </div>
                ))
              ) : (
                <div className="text-gray-500 dark:text-gray-400">Keine Einträge</div>
              )
            ) : (
              <div>…</div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-12">
        <div className="space-y-4 md:col-span-8">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle>Performance</CardTitle>
                <div className="flex items-center gap-2">
                  <Button variant={rangeDays === 7 ? "default" : "outline"} size="sm" onClick={() => setRangeDays(7)}>
                    7T
                  </Button>
                  <Button variant={rangeDays === 30 ? "default" : "outline"} size="sm" onClick={() => setRangeDays(30)}>
                    30T
                  </Button>
                  <Button variant={rangeDays === 90 ? "default" : "outline"} size="sm" onClick={() => setRangeDays(90)}>
                    90T
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {data ? (
                <>
                  <MultiLineChart
                    data={ts}
                    series={[
                      { key: "revenue_eur", label: "Umsatz (EUR)", stroke: "#2563eb" },
                      { key: "profit_eur", label: "Gewinn (EUR)", stroke: "#f59e0b" },
                    ]}
                    height={190}
                    ariaLabel="Umsatz und Gewinn"
                    xFormatter={(x) => x}
                    valueFormatter={(v) => `${Math.round(v)} EUR`}
                    className="text-gray-900 dark:text-gray-100"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="inline-block h-2 w-2 rounded-sm bg-blue-600 dark:bg-blue-400" />
                      <span className="text-gray-600 dark:text-gray-300">Umsatz</span>
                      <span className="font-medium text-gray-900 dark:text-gray-100">{formatEur(totals.revenue)} €</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="inline-block h-2 w-2 rounded-sm bg-amber-500 dark:bg-amber-400" />
                      <span className="text-gray-600 dark:text-gray-300">Gewinn</span>
                      <span className={["font-medium", totals.profit < 0 ? "text-red-700 dark:text-red-300" : "text-gray-900 dark:text-gray-100"].join(" ")}>
                        {formatEur(totals.profit)} €
                      </span>
                    </div>
                    <div className="text-gray-600 dark:text-gray-300">Aufträge: <span className="font-medium text-gray-900 dark:text-gray-100">{totals.orders}</span></div>
                  </div>
                </>
              ) : (
                <div className="text-sm text-gray-500 dark:text-gray-400">…</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle>Accounting (6M)</CardTitle>
                <Button variant="outline" size="sm" onClick={() => setShowAccountingDetails((v) => !v)}>
                  {showAccountingDetails ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  {showAccountingDetails ? "Details ausblenden" : "Details anzeigen"}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {data ? (
                <>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
                      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Income (Monat)</div>
                      <div className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
                        {formatEur(data.accounting.current_accrual_income_cents)} €
                      </div>
                    </div>
                    <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
                      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Expenses (Monat)</div>
                      <div className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
                        {formatEur(data.accounting.current_accrual_expenses_cents)} €
                      </div>
                    </div>
                    <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
                      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Net Cash (Monat)</div>
                      <div
                        className={[
                          "mt-1 text-lg font-semibold",
                          data.accounting.current_cash_net_cents < 0 ? "text-red-700 dark:text-red-300" : "text-gray-900 dark:text-gray-100",
                        ].join(" ")}
                      >
                        {formatEur(data.accounting.current_cash_net_cents)} €
                      </div>
                    </div>
                    <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
                      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Operating Result</div>
                      <div
                        className={[
                          "mt-1 text-lg font-semibold",
                          data.accounting.current_accrual_operating_result_cents < 0
                            ? "text-red-700 dark:text-red-300"
                            : "text-gray-900 dark:text-gray-100",
                        ].join(" ")}
                      >
                        {formatEur(data.accounting.current_accrual_operating_result_cents)} €
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
                    <span>Monat {data.accounting.current_month}</span>
                    <span>VAT: {formatEur(data.accounting.current_vat_payable_cents)} €</span>
                    <span>Burn (3M): {formatEur(data.accounting.average_cash_burn_3m_cents)} €/Monat</span>
                    <span>
                      Runway:{" "}
                      {data.accounting.estimated_runway_months === null
                        ? "keine Burn-Rate"
                        : `${data.accounting.estimated_runway_months} Monate`}
                    </span>
                  </div>

                  {!!data.accounting.insights.length && (
                    <div className="flex flex-wrap gap-2">
                      {data.accounting.insights.map((insight) => (
                        <Badge
                          key={insight.key}
                          variant={insight.tone === "danger" ? "danger" : insight.tone === "warning" ? "warning" : "secondary"}
                        >
                          {insight.text}
                        </Badge>
                      ))}
                    </div>
                  )}

                  <Tabs
                    value={accountingView}
                    onValueChange={(value) => setAccountingView(value as "cashflow" | "accrual")}
                    className="space-y-0"
                  >
                    <TabsList>
                      <TabsTrigger value="cashflow">Cashflow</TabsTrigger>
                      <TabsTrigger value="accrual">Accrual</TabsTrigger>
                    </TabsList>
                    <TabsContent value="cashflow">
                      <MultiLineChart
                        data={accountingChartData}
                        series={[
                          { key: "cash_income_eur", label: "Cash In (EUR)", stroke: "#2563eb" },
                          { key: "cash_expenses_eur", label: "Cash Out (EUR)", stroke: "#ef4444" },
                          { key: "cash_net_eur", label: "Cash Net (EUR)", stroke: "#059669" },
                        ]}
                        height={190}
                        ariaLabel="Cashflow Monatsverlauf"
                        xFormatter={(x) => x}
                        valueFormatter={(v) => `${Math.round(v)} EUR`}
                        className="text-gray-900 dark:text-gray-100"
                      />
                    </TabsContent>
                    <TabsContent value="accrual">
                      <MultiLineChart
                        data={accountingChartData}
                        series={[
                          { key: "accrual_income_eur", label: "Accrual Income (EUR)", stroke: "#2563eb" },
                          { key: "accrual_expenses_eur", label: "Accrual Expenses (EUR)", stroke: "#ef4444" },
                          { key: "accrual_operating_eur", label: "Operatives Ergebnis (EUR)", stroke: "#f59e0b" },
                        ]}
                        height={190}
                        ariaLabel="Accrual Monatsverlauf"
                        xFormatter={(x) => x}
                        valueFormatter={(v) => `${Math.round(v)} EUR`}
                        className="text-gray-900 dark:text-gray-100"
                      />
                    </TabsContent>
                  </Tabs>

                  {showAccountingDetails && (
                    <div className="space-y-4 rounded-md border border-gray-200 p-3 dark:border-gray-800">
                      <div className="text-sm font-medium text-gray-700 dark:text-gray-200">Monatliche Details</div>
                      <div className="rounded-md border border-gray-200 dark:border-gray-800">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Monat</TableHead>
                              <TableHead className="text-right">Cash In</TableHead>
                              <TableHead className="text-right">Cash Out</TableHead>
                              <TableHead className="text-right">Cash Net</TableHead>
                              <TableHead className="text-right">Income</TableHead>
                              <TableHead className="text-right">Expenses</TableHead>
                              <TableHead className="text-right">Operating</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {accountingMonths.map((month) => (
                              <TableRow key={month.month} className={TABLE_ROW_COMPACT_CLASS}>
                                <TableCell>{month.month}</TableCell>
                                <TableCell className={TABLE_CELL_NUMERIC_CLASS}>{formatEur(month.cash_inflow_cents)} €</TableCell>
                                <TableCell className={TABLE_CELL_NUMERIC_CLASS}>{formatEur(month.cash_outflow_cents)} €</TableCell>
                                <TableCell
                                  className={[
                                    TABLE_CELL_NUMERIC_CLASS,
                                    month.cash_net_cents < 0 ? "text-red-700 dark:text-red-300" : "",
                                  ].join(" ")}
                                >
                                  {formatEur(month.cash_net_cents)} €
                                </TableCell>
                                <TableCell className={TABLE_CELL_NUMERIC_CLASS}>{formatEur(month.accrual_income_cents)} €</TableCell>
                                <TableCell className={TABLE_CELL_NUMERIC_CLASS}>{formatEur(month.accrual_expenses_cents)} €</TableCell>
                                <TableCell
                                  className={[
                                    TABLE_CELL_NUMERIC_CLASS,
                                    month.accrual_operating_result_cents < 0 ? "text-red-700 dark:text-red-300" : "",
                                  ].join(" ")}
                                >
                                  {formatEur(month.accrual_operating_result_cents)} €
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <div className="text-sm font-medium text-gray-700 dark:text-gray-200">Outflow Breakdown (Monat)</div>
                          {accountingOutflowBars.filter((row) => row.cents > 0).length ? (
                            <BarList
                              items={accountingOutflowBars
                                .filter((row) => row.cents > 0)
                                .map((row) => ({
                                  key: row.key,
                                  label: row.label,
                                  value: row.cents,
                                  valueLabel: `${formatEur(row.cents)} €`,
                                }))}
                            />
                          ) : (
                            <div className="text-sm text-gray-500 dark:text-gray-400">Keine Outflows im aktuellen Monat.</div>
                          )}
                        </div>

                        <div className="space-y-2">
                          <div className="text-sm font-medium text-gray-700 dark:text-gray-200">OpEx Kategorien (Monat)</div>
                          {accountingOpexRows.length ? (
                            <div className="flex flex-wrap gap-2">
                              {accountingOpexRows.map((row) => (
                                <Badge key={row.key} variant="outline">
                                  {row.label}: {formatEur(row.cents)} €
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <div className="text-sm text-gray-500 dark:text-gray-400">Keine OpEx im aktuellen Monat.</div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="text-sm text-gray-500 dark:text-gray-400">…</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Top / Flops (30T)</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-sm font-medium text-gray-700 dark:text-gray-200">Top</div>
                <div className="rounded-md border border-gray-200 dark:border-gray-800">
                  <div className="md:hidden divide-y divide-gray-200 dark:divide-gray-800">
                    {(data?.top_products_30d ?? []).map((p) => (
                      <div key={p.master_product_id} className="flex items-start justify-between gap-3 p-3">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-gray-900 dark:text-gray-100">{p.title}</div>
                          <div className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
                            <span className="font-mono">{p.sku}</span> · {p.platform} · {p.region}{p.variant ? ` · ${p.variant}` : ""}
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Badge variant="outline">{p.units_sold} Stk</Badge>
                            <Badge variant="secondary">{formatEur(p.revenue_cents)} € Umsatz</Badge>
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-xs text-gray-500 dark:text-gray-400">Gewinn</div>
                          <div className={["text-sm font-semibold", p.profit_cents < 0 ? "text-red-700 dark:text-red-300" : "text-gray-900 dark:text-gray-100"].join(" ")}>
                            {formatEur(p.profit_cents)} €
                          </div>
                        </div>
                      </div>
                    ))}
                    {!data?.top_products_30d?.length && (
                      <div className="p-3 text-sm text-gray-500 dark:text-gray-400">Keine Verkäufe im Zeitraum.</div>
                    )}
                  </div>

                  <div className="hidden md:block">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Produkt</TableHead>
                          <TableHead className="text-right">Stk</TableHead>
                          <TableHead className="text-right">Umsatz</TableHead>
                          <TableHead className="text-right">Gewinn</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(data?.top_products_30d ?? []).map((p) => (
                          <TableRow key={p.master_product_id} className={TABLE_ROW_COMPACT_CLASS}>
                            <TableCell className="max-w-[260px]">
                              <div className="truncate font-medium text-gray-900 dark:text-gray-100">{p.title}</div>
                              <div className="truncate text-xs text-gray-500 dark:text-gray-400">
                                <span className="font-mono">{p.sku}</span> · {p.platform} · {p.region}{p.variant ? ` · ${p.variant}` : ""}
                              </div>
                            </TableCell>
                            <TableCell className={TABLE_CELL_NUMERIC_CLASS}>{p.units_sold}</TableCell>
                            <TableCell className={TABLE_CELL_NUMERIC_CLASS}>{formatEur(p.revenue_cents)} €</TableCell>
                            <TableCell className={TABLE_CELL_NUMERIC_CLASS}>{formatEur(p.profit_cents)} €</TableCell>
                          </TableRow>
                        ))}
                        {!data?.top_products_30d?.length && (
                          <TableRow>
                            <TableCell colSpan={4} className="text-sm text-gray-500 dark:text-gray-400">
                              Keine Verkäufe im Zeitraum.
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium text-gray-700 dark:text-gray-200">Flops</div>
                <div className="rounded-md border border-gray-200 dark:border-gray-800">
                  <div className="md:hidden divide-y divide-gray-200 dark:divide-gray-800">
                    {(data?.worst_products_30d ?? []).map((p) => (
                      <div key={p.master_product_id} className="flex items-start justify-between gap-3 p-3">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-gray-900 dark:text-gray-100">{p.title}</div>
                          <div className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
                            <span className="font-mono">{p.sku}</span> · {p.platform} · {p.region}{p.variant ? ` · ${p.variant}` : ""}
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Badge variant="outline">{p.units_sold} Stk</Badge>
                            <Badge variant="secondary">{formatEur(p.revenue_cents)} € Umsatz</Badge>
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-xs text-gray-500 dark:text-gray-400">Gewinn</div>
                          <div className={["text-sm font-semibold", p.profit_cents < 0 ? "text-red-700 dark:text-red-300" : "text-gray-900 dark:text-gray-100"].join(" ")}>
                            {formatEur(p.profit_cents)} €
                          </div>
                        </div>
                      </div>
                    ))}
                    {!data?.worst_products_30d?.length && (
                      <div className="p-3 text-sm text-gray-500 dark:text-gray-400">Keine Verkäufe im Zeitraum.</div>
                    )}
                  </div>

                  <div className="hidden md:block">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Produkt</TableHead>
                          <TableHead className="text-right">Stk</TableHead>
                          <TableHead className="text-right">Umsatz</TableHead>
                          <TableHead className="text-right">Gewinn</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(data?.worst_products_30d ?? []).map((p) => (
                          <TableRow key={p.master_product_id} className={TABLE_ROW_COMPACT_CLASS}>
                            <TableCell className="max-w-[260px]">
                              <div className="truncate font-medium text-gray-900 dark:text-gray-100">{p.title}</div>
                              <div className="truncate text-xs text-gray-500 dark:text-gray-400">
                                <span className="font-mono">{p.sku}</span> · {p.platform} · {p.region}{p.variant ? ` · ${p.variant}` : ""}
                              </div>
                            </TableCell>
                            <TableCell className={TABLE_CELL_NUMERIC_CLASS}>{p.units_sold}</TableCell>
                            <TableCell className={TABLE_CELL_NUMERIC_CLASS}>{formatEur(p.revenue_cents)} €</TableCell>
                            <TableCell className={[TABLE_CELL_NUMERIC_CLASS, p.profit_cents < 0 ? "text-red-700 dark:text-red-300" : ""].join(" ")}>
                              {formatEur(p.profit_cents)} €
                            </TableCell>
                          </TableRow>
                        ))}
                        {!data?.worst_products_30d?.length && (
                          <TableRow>
                            <TableCell colSpan={4} className="text-sm text-gray-500 dark:text-gray-400">
                              Keine Verkäufe im Zeitraum.
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4 md:col-span-4">
          <Card>
            <CardHeader>
              <CardTitle>Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <ActionLink to="/purchases" icon={<ReceiptText className="h-4 w-4" />} label="Einkauf erfassen" />
              <ActionLink to="/sales" icon={<ArrowUpRight className="h-4 w-4" />} label="Verkauf erfassen" />
              <ActionLink to="/inventory" icon={<Boxes className="h-4 w-4" />} label="Lager durchsuchen" />
              <ActionLink to="/master-products?create=1" icon={<PackagePlus className="h-4 w-4" />} label="Produkt anlegen" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Amazon (Seller Central)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <ExternalLinkButton href="https://sellercentral.amazon.de/" label="Seller Central öffnen" />
              <ExternalLinkButton href="https://sellercentral.amazon.de/orders-v3" label="Bestellungen" />
              <ExternalLinkButton href="https://sellercentral.amazon.de/inventory/" label="Inventar" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Amazon Intelligence</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {data ? (
                <>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Sell Value (net)</div>
                    <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                      {formatEur(data.amazon_inventory.in_stock_fba_payout_cents)} €
                    </div>
                    <div
                      className={[
                        "text-xs",
                        data.amazon_inventory.in_stock_margin_cents < 0
                          ? "text-red-700 dark:text-red-300"
                          : "text-emerald-700 dark:text-emerald-300",
                      ].join(" ")}
                    >
                      Brutto {formatEur(data.amazon_inventory.in_stock_market_gross_cents)} € · Marge{" "}
                      {formatEur(data.amazon_inventory.in_stock_margin_cents)} €
                    </div>
                  </div>

                  <div className="text-xs text-gray-600 dark:text-gray-300">
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      <span>
                        Bepreist: <strong>{data.amazon_inventory.in_stock_units_effective_priced}</strong> /{" "}
                        {data.amazon_inventory.in_stock_units_total}
                      </span>
                      <span className="text-gray-400">
                        (Auto {data.amazon_inventory.in_stock_units_auto_priced} · Manuell{" "}
                        {data.amazon_inventory.in_stock_units_manual_priced})
                      </span>
                      {data.amazon_inventory.in_stock_units_unpriced > 0 && (
                        <span className="text-amber-600 dark:text-amber-400">
                          Unpriced: {data.amazon_inventory.in_stock_units_unpriced}
                        </span>
                      )}
                    </div>
                    <div className="mt-1">
                      Fresh {data.amazon_inventory.in_stock_units_fresh} · Stale/blocked{" "}
                      {data.amazon_inventory.in_stock_units_stale_or_blocked}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-gray-700 dark:text-gray-200">Top Chancen</div>
                    {amazonTopOpportunities.length ? (
                      amazonTopOpportunities.map((o) => {
                        const rank =
                          typeof o.amazon_rank_overall === "number"
                            ? o.amazon_rank_overall
                            : typeof o.amazon_rank_specific === "number"
                              ? o.amazon_rank_specific
                              : null;
                        const offers =
                          typeof o.amazon_offers_count_used_priced_total === "number"
                            ? `${o.amazon_offers_count_used_priced_total} used`
                            : typeof o.amazon_offers_count_total === "number"
                              ? `${o.amazon_offers_count_total}`
                              : null;
                        return (
                          <Link
                            key={o.master_product_id}
                            to={`/inventory?q=${encodeURIComponent(o.master_product_id)}&view=overview`}
                            className="block rounded-md border border-gray-200 px-2.5 py-2 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900/50"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0 truncate text-sm text-gray-900 dark:text-gray-100">{o.title}</div>
                              <div className="shrink-0 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                                +{formatEur(o.margin_cents_total)} €
                              </div>
                            </div>
                            <div className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
                              {o.units_total} Stk · {o.platform}
                              {rank !== null ? ` · BSR #${rank}` : ""}
                              {offers ? ` · Offers ${offers}` : ""}
                            </div>
                          </Link>
                        );
                      })
                    ) : (
                      <div className="text-xs text-gray-500 dark:text-gray-400">Keine direkten Chancen mit positiver Marge.</div>
                    )}
                  </div>

                  <div className="grid gap-2">
                    <Button asChild variant="outline" className="w-full justify-start">
                      <Link to="/inventory?queue=AMAZON_STALE&view=overview">
                        Amazon stale Queue
                        <Badge variant="warning">{data.inventory_amazon_stale_count}</Badge>
                      </Link>
                    </Button>
                    <Button asChild variant="outline" className="w-full justify-start">
                      <Link to="/master-products?view=amazon">Produktstamm: Amazon View</Link>
                    </Button>
                  </div>
                </>
              ) : (
                <div className="text-sm text-gray-500 dark:text-gray-400">…</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle>Sourcing</CardTitle>
                <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <Search className="h-3.5 w-3.5" />
                  Keyword
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input value={sourcingQ} onChange={(e) => setSourcingQ(e.target.value)} placeholder="z.B. gamecube, gameboy, ps2 bundle" />

              <div className="grid gap-2">
                <ExternalLinkButton href={ebayEndingSoonGermanyUrl(sourcingQ)} label="eBay: Auktionen enden bald (DE)" />
                <ExternalLinkButton href={ebayBuyNowGermanyUrl(sourcingQ)} label="eBay: Sofortkauf (DE)" />
                <ExternalLinkButton href={kleinanzeigenUrl(sourcingQ)} label="Kleinanzeigen: Suche" />
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Tipp: Filter in den Links sind Startwerte, Feintuning passiert auf der Plattform.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-12">
        <Card className="md:col-span-7">
          <CardHeader>
            <CardTitle>Bestand</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {data ? (
                inventoryStatusBadges.map((s) => (
                  <Badge key={s.status} variant={s.variant}>
                    {s.label}: {s.count}
                  </Badge>
                ))
              ) : (
                <div className="text-sm text-gray-500 dark:text-gray-400">…</div>
              )}
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-gray-700 dark:text-gray-200">Aging</div>
              {data ? (
                <BarList
                  items={data.inventory_aging.map((b) => ({
                    key: b.label,
                    label: `${b.label} (${b.count})`,
                    value: b.value_cents,
                    valueLabel: `${formatEur(b.value_cents)} €`,
                    barClassName: b.label === ">90T" ? "bg-red-600 dark:bg-red-400" : b.label === "31-90T" ? "bg-amber-500 dark:bg-amber-400" : undefined,
                  }))}
                />
              ) : (
                <div className="text-sm text-gray-500 dark:text-gray-400">…</div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="md:col-span-5">
          <CardHeader>
            <CardTitle>Kanäle (30T)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {data ? (
              <BarList items={channelBars} />
            ) : (
              <div className="text-sm text-gray-500 dark:text-gray-400">…</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ActionLink({
  to,
  icon,
  label,
}: {
  to: string;
  icon: ReactNode;
  label: string;
}) {
  return (
    <Button asChild variant="secondary" className="w-full justify-start">
      <Link to={to}>
        {icon}
        {label}
      </Link>
    </Button>
  );
}

function ExternalLinkButton({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild variant="outline" className="w-full justify-start">
      <a href={href} target="_blank" rel="noreferrer">
        <ExternalLink className="h-4 w-4" />
        {label}
      </a>
    </Button>
  );
}
