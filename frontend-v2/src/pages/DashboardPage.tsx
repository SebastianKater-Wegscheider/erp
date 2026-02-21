import { useQuery } from "@tanstack/react-query";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useApi } from "../api/api";
import { fmtEur } from "../lib/money";
import { Button } from "../ui/Button";
import { InlineAlert } from "../ui/InlineAlert";

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

type CompanyDashboardOut = {
  inventory_value_cents: number;
  cash_balance_cents: Record<string, number>;
  gross_profit_month_cents: number;

  sales_revenue_30d_cents: number;
  gross_profit_30d_cents: number;

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
      accrual_operating_result_cents: number;
    }>;
    insights: Array<{ key: string; tone: "info" | "warning" | "danger"; text: string }>;
  };

  top_products_30d: Array<ProductAgg>;
  worst_products_30d: Array<ProductAgg>;
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

function kleinanzeigenUrl(q: string): string {
  return `https://www.kleinanzeigen.de/s-${encodeURIComponent(kleinanzeigenSlug(q))}/k0`;
}

function ebayEndingSoonGermanyUrl(q: string): string {
  const kw = encodeURIComponent(q.trim() || "gamecube");
  return `https://www.ebay.de/sch/i.html?_nkw=${kw}&_sacat=0&_from=R40&LH_Auction=1&_sop=44&rt=nc&LH_PrefLoc=1`;
}

function ebayBuyNowGermanyUrl(q: string): string {
  const kw = encodeURIComponent(q.trim() || "gamecube");
  return `https://www.ebay.de/sch/i.html?_nkw=${kw}&_sacat=0&_from=R40&LH_BIN=1&_sop=15&rt=nc&LH_PrefLoc=1`;
}

function sortedEntries(map: Record<string, number>): Array<{ key: string; cents: number }> {
  const rows = Object.entries(map ?? {}).map(([key, cents]) => ({ key, cents: Number(cents) || 0 }));
  rows.sort((a, b) => b.cents - a.cents);
  return rows;
}

export function DashboardPage() {
  const api = useApi();
  const [sourcingQ, setSourcingQ] = useState("gamecube");

  const q = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.request<CompanyDashboardOut>("/reports/company-dashboard"),
  });

  const data = q.data;

  const cashRows = useMemo(() => {
    const rows = Object.entries(data?.cash_balance_cents ?? {}).map(([k, cents]) => ({ key: k, cents }));
    rows.sort((a, b) => a.key.localeCompare(b.key));
    return rows;
  }, [data?.cash_balance_cents]);

  const outflowRows = useMemo(
    () => sortedEntries(data?.accounting?.current_outflow_breakdown_cents ?? {}),
    [data?.accounting?.current_outflow_breakdown_cents],
  );
  const opexRows = useMemo(
    () => sortedEntries(data?.accounting?.current_opex_by_category_cents ?? {}),
    [data?.accounting?.current_opex_by_category_cents],
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Übersicht</div>
          <div className="page-subtitle">Heute: Queues abarbeiten, Drafts schließen, Cashflow im Blick.</div>
        </div>
        <div className="page-actions">
          <Button variant="secondary" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw size={16} /> Aktualisieren
          </Button>
        </div>
      </div>

      {q.isError ? <InlineAlert tone="error">{(q.error as Error).message}</InlineAlert> : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
        <div className="card">
          <div className="muted" style={{ fontSize: 12 }}>
            Lagerwert
          </div>
          <div className="h1">{data ? fmtEur(data.inventory_value_cents) : "—"}</div>
        </div>
        <div className="card">
          <div className="muted" style={{ fontSize: 12 }}>
            Gewinn (Monat)
          </div>
          <div className="h1">{data ? fmtEur(data.gross_profit_month_cents) : "—"}</div>
        </div>
        <div className="card">
          <div className="muted" style={{ fontSize: 12 }}>
            Umsatz (30T)
          </div>
          <div className="h1">{data ? fmtEur(data.sales_revenue_30d_cents) : "—"}</div>
        </div>
        <div className="card">
          <div className="muted" style={{ fontSize: 12 }}>
            Gewinn (30T)
          </div>
          <div className="h1">{data ? fmtEur(data.gross_profit_30d_cents) : "—"}</div>
        </div>
      </div>

      <div className="split" style={{ gridTemplateColumns: "1fr 420px" }}>
        <div className="panel">
          <div className="panel-title">Nächste Schritte</div>
          <div className="panel-sub">Links führen direkt in die jeweiligen Arbeits-Queues.</div>

          <div className="stack" style={{ marginTop: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
              <Link className="card link" to="/sales?status=DRAFT" style={{ padding: 12 }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  Sales Drafts
                </div>
                <div className="h1">{data ? data.sales_orders_draft_count : "—"}</div>
              </Link>

              <Link className="card link" to="/inventory?queue=PHOTOS_MISSING" style={{ padding: 12 }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  Fotos fehlen
                </div>
                <div className="h1">{data ? data.inventory_missing_photos_count : "—"}</div>
              </Link>

              <Link className="card link" to="/inventory?queue=STORAGE_MISSING" style={{ padding: 12 }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  Lagerplatz fehlt
                </div>
                <div className="h1">{data ? data.inventory_missing_storage_location_count : "—"}</div>
              </Link>

              <Link className="card link" to="/inventory?queue=OLD_STOCK_90D" style={{ padding: 12 }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  Altbestand &gt;90T
                </div>
                <div className="h1">{data ? data.inventory_old_stock_90d_count : "—"}</div>
              </Link>
            </div>

            <details>
              <summary className="panel-title" style={{ cursor: "pointer" }}>
                Weitere Queues
              </summary>
              <div className="stack" style={{ marginTop: 10 }}>
                <div className="kv">
                  <div className="k">Inventory Draft</div>
                  <div className="v">
                    <Link className="link" to="/inventory?status=DRAFT">
                      {data ? data.inventory_draft_count : "—"}
                    </Link>
                  </div>
                  <div className="k">Inventory Reserved</div>
                  <div className="v mono">{data ? data.inventory_reserved_count : "—"}</div>
                  <div className="k">Inventory Returned</div>
                  <div className="v mono">{data ? data.inventory_returned_count : "—"}</div>
                  <div className="k">Amazon stale</div>
                  <div className="v">
                    <Link className="link" to="/inventory?queue=AMAZON_STALE">
                      {data ? data.inventory_amazon_stale_count : "—"}
                    </Link>
                  </div>
                  <div className="k">Missing ASIN</div>
                  <div className="v mono">{data ? data.master_products_missing_asin_count : "—"}</div>
                  <div className="k">Missing invoice PDF</div>
                  <div className="v mono">{data ? data.finalized_orders_missing_invoice_pdf_count : "—"}</div>
                  <div className="k">Neg. Profit Orders (30T)</div>
                  <div className="v mono">{data ? data.negative_profit_orders_30d_count : "—"}</div>
                </div>
              </div>
            </details>

            <details>
              <summary className="panel-title" style={{ cursor: "pointer" }}>
                Amazon Pricing Snapshot
              </summary>
              <div className="stack" style={{ marginTop: 10 }}>
                <div className="kv">
                  <div className="k">Units in Stock</div>
                  <div className="v mono">{data ? data.amazon_inventory.in_stock_units_total : "—"}</div>
                  <div className="k">Priced</div>
                  <div className="v mono">{data ? data.amazon_inventory.in_stock_units_effective_priced : "—"}</div>
                  <div className="k">Market Gross</div>
                  <div className="v mono">{data ? fmtEur(data.amazon_inventory.in_stock_market_gross_cents) : "—"}</div>
                  <div className="k">FBA Payout</div>
                  <div className="v mono">{data ? fmtEur(data.amazon_inventory.in_stock_fba_payout_cents) : "—"}</div>
                  <div className="k">Margin</div>
                  <div className="v mono">{data ? fmtEur(data.amazon_inventory.in_stock_margin_cents) : "—"}</div>
                </div>

                <div className="panel" style={{ padding: 12 }}>
                  <div className="panel-title" style={{ fontSize: 13 }}>
                    Top Opportunities
                  </div>
                  <table className="table" style={{ marginTop: 10 }}>
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th>Produkt</th>
                        <th className="numeric">Units</th>
                        <th className="numeric">Margin</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data?.amazon_inventory.top_opportunities ?? []).slice(0, 10).map((o) => (
                        <tr key={o.master_product_id}>
                          <td className="mono">{o.sku}</td>
                          <td>
                            <Link className="link" to={`/master-products?selected=${encodeURIComponent(o.master_product_id)}`}>
                              {o.title}
                            </Link>
                            <div className="muted" style={{ fontSize: 12 }}>
                              {o.platform} · {o.region}
                              {o.variant ? ` · ${o.variant}` : ""}
                            </div>
                          </td>
                          <td className="numeric mono">{o.units_total}</td>
                          <td className="numeric mono">{fmtEur(o.margin_cents_total)}</td>
                        </tr>
                      ))}
                      {!data?.amazon_inventory.top_opportunities?.length ? (
                        <tr>
                          <td colSpan={4} className="muted">
                            Keine Daten.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Cash & Accounting</div>
          <div className="panel-sub">Kurzüberblick für den aktuellen Monat.</div>

          <div className="stack" style={{ marginTop: 12 }}>
            <div className="kv">
              <div className="k">Monat</div>
              <div className="v mono">{data?.accounting.current_month ?? "—"}</div>
              <div className="k">Cash In</div>
              <div className="v mono">{data ? fmtEur(data.accounting.current_cash_inflow_cents) : "—"}</div>
              <div className="k">Cash Out</div>
              <div className="v mono">{data ? fmtEur(data.accounting.current_cash_outflow_cents) : "—"}</div>
              <div className="k">Cash Net</div>
              <div className="v mono">{data ? fmtEur(data.accounting.current_cash_net_cents) : "—"}</div>
              <div className="k">Operatives Ergebnis</div>
              <div className="v mono">{data ? fmtEur(data.accounting.current_accrual_operating_result_cents) : "—"}</div>
              <div className="k">USt Zahllast</div>
              <div className="v mono">{data ? fmtEur(data.accounting.current_vat_payable_cents) : "—"}</div>
              <div className="k">Runway</div>
              <div className="v mono">{data?.accounting.estimated_runway_months ?? "—"} m</div>
            </div>

            <details>
              <summary className="panel-title" style={{ cursor: "pointer" }}>
                Cash Konten
              </summary>
              <table className="table" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Konto</th>
                    <th className="numeric">Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {cashRows.map((r) => (
                    <tr key={r.key}>
                      <td className="mono">{r.key}</td>
                      <td className="numeric mono">{fmtEur(r.cents)}</td>
                    </tr>
                  ))}
                  {!cashRows.length ? (
                    <tr>
                      <td colSpan={2} className="muted">
                        —
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </details>

            <details>
              <summary className="panel-title" style={{ cursor: "pointer" }}>
                Insights
              </summary>
              <div className="stack" style={{ marginTop: 10 }}>
                {(data?.accounting.insights ?? []).map((i) => (
                  <InlineAlert key={i.key} tone={i.tone === "danger" ? "error" : "info"}>
                    {i.text}
                  </InlineAlert>
                ))}
                {!data?.accounting.insights?.length ? (
                  <div className="muted" style={{ fontSize: 13 }}>
                    —
                  </div>
                ) : null}
              </div>
            </details>

            <details>
              <summary className="panel-title" style={{ cursor: "pointer" }}>
                Outflow Breakdown
              </summary>
              <table className="table" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Key</th>
                    <th className="numeric">Betrag</th>
                  </tr>
                </thead>
                <tbody>
                  {outflowRows.slice(0, 10).map((r) => (
                    <tr key={r.key}>
                      <td className="mono">{r.key}</td>
                      <td className="numeric mono">{fmtEur(r.cents)}</td>
                    </tr>
                  ))}
                  {!outflowRows.length ? (
                    <tr>
                      <td colSpan={2} className="muted">
                        —
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </details>

            <details>
              <summary className="panel-title" style={{ cursor: "pointer" }}>
                OpEx Kategorien
              </summary>
              <table className="table" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Key</th>
                    <th className="numeric">Betrag</th>
                  </tr>
                </thead>
                <tbody>
                  {opexRows.slice(0, 10).map((r) => (
                    <tr key={r.key}>
                      <td className="mono">{r.key}</td>
                      <td className="numeric mono">{fmtEur(r.cents)}</td>
                    </tr>
                  ))}
                  {!opexRows.length ? (
                    <tr>
                      <td colSpan={2} className="muted">
                        —
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </details>
          </div>
        </div>
      </div>

      <div className="split" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="panel-title">Top Produkte (30T)</div>
          <table className="table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Produkt</th>
                <th className="numeric">Units</th>
                <th className="numeric">Profit</th>
              </tr>
            </thead>
            <tbody>
              {(data?.top_products_30d ?? []).slice(0, 10).map((p) => (
                <tr key={p.master_product_id}>
                  <td className="mono">{p.sku}</td>
                  <td>
                    <Link className="link" to={`/master-products?selected=${encodeURIComponent(p.master_product_id)}`}>
                      {p.title}
                    </Link>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {p.platform} · {p.region}
                      {p.variant ? ` · ${p.variant}` : ""}
                    </div>
                  </td>
                  <td className="numeric mono">{p.units_sold}</td>
                  <td className="numeric mono">{fmtEur(p.profit_cents)}</td>
                </tr>
              ))}
              {!data?.top_products_30d?.length ? (
                <tr>
                  <td colSpan={4} className="muted">
                    —
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <div className="panel-title">Worst Produkte (30T)</div>
          <table className="table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Produkt</th>
                <th className="numeric">Units</th>
                <th className="numeric">Profit</th>
              </tr>
            </thead>
            <tbody>
              {(data?.worst_products_30d ?? []).slice(0, 10).map((p) => (
                <tr key={p.master_product_id}>
                  <td className="mono">{p.sku}</td>
                  <td>
                    <Link className="link" to={`/master-products?selected=${encodeURIComponent(p.master_product_id)}`}>
                      {p.title}
                    </Link>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {p.platform} · {p.region}
                      {p.variant ? ` · ${p.variant}` : ""}
                    </div>
                  </td>
                  <td className="numeric mono">{p.units_sold}</td>
                  <td className="numeric mono">{fmtEur(p.profit_cents)}</td>
                </tr>
              ))}
              {!data?.worst_products_30d?.length ? (
                <tr>
                  <td colSpan={4} className="muted">
                    —
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Sourcing Shortcuts</div>
        <div className="panel-sub">Externe Suche für schnelle Checks.</div>
        <div className="toolbar" style={{ marginTop: 10 }}>
          <input className="input" value={sourcingQ} onChange={(e) => setSourcingQ(e.target.value)} placeholder="Search…" />
          <a className="btn btn--secondary btn--sm" href={kleinanzeigenUrl(sourcingQ)} target="_blank" rel="noreferrer">
            <ExternalLink size={16} /> Kleinanzeigen
          </a>
          <a className="btn btn--secondary btn--sm" href={ebayEndingSoonGermanyUrl(sourcingQ)} target="_blank" rel="noreferrer">
            <ExternalLink size={16} /> eBay Auktion
          </a>
          <a className="btn btn--secondary btn--sm" href={ebayBuyNowGermanyUrl(sourcingQ)} target="_blank" rel="noreferrer">
            <ExternalLink size={16} /> eBay Sofort
          </a>
          <div className="toolbar-spacer" />
          <Link className="btn btn--primary btn--sm" to="/sourcing">
            Sourcing öffnen
          </Link>
        </div>
      </div>
    </div>
  );
}
