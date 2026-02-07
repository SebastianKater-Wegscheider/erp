import { AlertTriangle, ArrowUpRight, Boxes, ExternalLink, PackagePlus, ReceiptText, RefreshCw, Search } from "lucide-react";
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
import { Input } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

type ResellerDashboardOut = {
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
  negative_profit_orders_30d_count: number;
  master_products_missing_asin_count: number;

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
  RESERVED: "Reserviert",
  SOLD: "Verkauft",
  RETURNED: "Retourniert",
  LOST: "Verloren",
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
  const kw = encodeURIComponent(q.trim() || "nintendo");
  return `https://www.ebay.de/sch/i.html?_nkw=${kw}&_sacat=0&_from=R40&LH_Auction=1&_sop=44&rt=nc&LH_PrefLoc=1`;
}

function ebayBuyNowGermanyUrl(q: string): string {
  const kw = encodeURIComponent(q.trim() || "nintendo");
  return `https://www.ebay.de/sch/i.html?_nkw=${kw}&_sacat=0&_from=R40&LH_BIN=1&_sop=15&rt=nc&LH_PrefLoc=1`;
}

function kleinanzeigenUrl(q: string): string {
  return `https://www.kleinanzeigen.de/s-${encodeURIComponent(kleinanzeigenSlug(q))}/k0`;
}

export function DashboardPage() {
  const api = useApi();
  const [sourcingQ, setSourcingQ] = useState("nintendo");
  const q = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.request<ResellerDashboardOut>("/reports/reseller-dashboard"),
  });

  const data = q.data;
  const [rangeDays, setRangeDays] = useState<7 | 30 | 90>(30);
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
        status === "AVAILABLE"
          ? ("success" as const)
          : status === "RESERVED"
            ? ("warning" as const)
            : status === "RETURNED" || status === "LOST"
              ? ("danger" as const)
              : ("secondary" as const),
    }));
  }, [data?.inventory_status_counts]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xl font-semibold">Übersicht</div>
        <Button variant="secondary" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className="h-4 w-4" />
          Aktualisieren
        </Button>
      </div>

      {q.isError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
          {(q.error as Error).message}
        </div>
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
              <CardTitle>Top / Flops (30T)</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-sm font-medium text-gray-700 dark:text-gray-200">Top</div>
                <div className="rounded-md border border-gray-200 dark:border-gray-800">
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
                        <TableRow key={p.master_product_id}>
                          <TableCell className="max-w-[260px]">
                            <div className="truncate font-medium text-gray-900 dark:text-gray-100">{p.title}</div>
                            <div className="truncate text-xs text-gray-500 dark:text-gray-400">
                              <span className="font-mono">{p.sku}</span> · {p.platform} · {p.region}{p.variant ? ` · ${p.variant}` : ""}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">{p.units_sold}</TableCell>
                          <TableCell className="text-right">{formatEur(p.revenue_cents)} €</TableCell>
                          <TableCell className="text-right">{formatEur(p.profit_cents)} €</TableCell>
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

              <div className="space-y-2">
                <div className="text-sm font-medium text-gray-700 dark:text-gray-200">Flops</div>
                <div className="rounded-md border border-gray-200 dark:border-gray-800">
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
                        <TableRow key={p.master_product_id}>
                          <TableCell className="max-w-[260px]">
                            <div className="truncate font-medium text-gray-900 dark:text-gray-100">{p.title}</div>
                            <div className="truncate text-xs text-gray-500 dark:text-gray-400">
                              <span className="font-mono">{p.sku}</span> · {p.platform} · {p.region}{p.variant ? ` · ${p.variant}` : ""}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">{p.units_sold}</TableCell>
                          <TableCell className="text-right">{formatEur(p.revenue_cents)} €</TableCell>
                          <TableCell className={["text-right", p.profit_cents < 0 ? "text-red-700 dark:text-red-300" : ""].join(" ")}>
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
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4 md:col-span-4">
          <Card>
            <CardHeader>
              <CardTitle>Heute / Inbox</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {data ? (
                <>
                  <InboxRow to="/sales" label="Verkäufe: Entwürfe" count={data.sales_orders_draft_count} />
                  <InboxRow
                    to="/sales"
                    label="Rechnung-PDF fehlt"
                    count={data.finalized_orders_missing_invoice_pdf_count}
                    warn={data.finalized_orders_missing_invoice_pdf_count > 0}
                  />
                  <InboxRow to="/inventory?status=DRAFT" label="Lager: Entwürfe" count={data.inventory_draft_count} />
                  <InboxRow to="/inventory?status=RESERVED" label="Lager: Reserviert" count={data.inventory_reserved_count} warn={data.inventory_reserved_count > 0} />
                  <InboxRow to="/inventory?status=RETURNED" label="Lager: Retouren" count={data.inventory_returned_count} warn={data.inventory_returned_count > 0} />
                  <InboxRow to="/master-products" label="Produkte ohne ASIN" count={data.master_products_missing_asin_count} warn={data.master_products_missing_asin_count > 0} />
                  <InboxRow
                    to="/sales"
                    label="Negative Marge (30T)"
                    count={data.negative_profit_orders_30d_count}
                    warn={data.negative_profit_orders_30d_count > 0}
                  />
                </>
              ) : (
                <div className="text-gray-500 dark:text-gray-400">…</div>
              )}
            </CardContent>
          </Card>

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
              <div className="flex items-center justify-between gap-3">
                <CardTitle>Sourcing</CardTitle>
                <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <Search className="h-3.5 w-3.5" />
                  Keyword
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input value={sourcingQ} onChange={(e) => setSourcingQ(e.target.value)} placeholder="z.B. nintendo, gameboy, ps2 bundle" />

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

function InboxRow({
  to,
  label,
  count,
  warn,
}: {
  to: string;
  label: string;
  count: number;
  warn?: boolean;
}) {
  return (
    <Link
      to={to}
      className={[
        "flex items-center justify-between gap-3 rounded-md border border-gray-200 bg-white px-3 py-2 transition-colors hover:bg-gray-50",
        "dark:border-gray-800 dark:bg-transparent dark:hover:bg-gray-900",
      ].join(" ")}
    >
      <div className="min-w-0 truncate text-gray-700 dark:text-gray-200">{label}</div>
      <div className="flex items-center gap-2">
        {warn && <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-label="Achtung" />}
        <div className="shrink-0 rounded-md bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-900 dark:bg-gray-800 dark:text-gray-100">
          {count}
        </div>
        <ArrowUpRight className="h-4 w-4 opacity-60" />
      </div>
    </Link>
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
