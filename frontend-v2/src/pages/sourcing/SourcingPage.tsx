import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { useApi } from "../../api/api";
import { formatDateTimeLocal } from "../../lib/dates";
import { fmtEur } from "../../lib/money";
import { fmtBp } from "../../lib/units";
import { Button } from "../../ui/Button";
import { InlineAlert } from "../../ui/InlineAlert";
import { Pagination } from "../../ui/Pagination";

type SourcingStatus = "NEW" | "ANALYZING" | "READY" | "LOW_VALUE" | "CONVERTED" | "DISCARDED" | "ERROR";
type SourcingPlatform = "KLEINANZEIGEN" | "WILLHABEN" | "EBAY_KLEINANZEIGEN" | "EBAY_DE";

type SourcingHealthOut = {
  status: string;
  last_scrape_at: string | null;
  scraper_status: string;
  items_pending_analysis: number;
  last_error_type?: string | null;
  last_error_message?: string | null;
};

type SourcingStatsOut = {
  total_items_scraped: number;
  items_by_status: Record<string, number>;
  avg_profit_cents: number;
  conversion_rate_bp: number;
};

type SourcingItemListOut = {
  id: string;
  platform: SourcingPlatform;
  title: string;
  price_cents: number;
  location_city?: string | null;
  primary_image_url?: string | null;
  estimated_profit_cents?: number | null;
  estimated_roi_bp?: number | null;
  auction_end_at?: string | null;
  auction_current_price_cents?: number | null;
  auction_bid_count?: number | null;
  max_purchase_price_cents?: number | null;
  bidbag_sent_at?: string | null;
  status: SourcingStatus;
  scraped_at: string;
  posted_at?: string | null;
  url: string;
  match_count: number;
};

type SourcingItemListResponse = {
  items: SourcingItemListOut[];
  total: number;
  limit: number;
  offset: number;
};

type SourcingScrapeTriggerOut = {
  run_id: string;
  status: string;
  started_at: string;
  finished_at?: string | null;
  items_scraped: number;
  items_new: number;
  items_ready: number;
};

const STATUS_OPTIONS: Array<{ value: SourcingStatus | "ALL"; label: string }> = [
  { value: "READY", label: "Ready" },
  { value: "NEW", label: "Neu" },
  { value: "ANALYZING", label: "Analysiert…" },
  { value: "LOW_VALUE", label: "Low value" },
  { value: "ERROR", label: "Fehler" },
  { value: "CONVERTED", label: "Konvertiert" },
  { value: "DISCARDED", label: "Verworfen" },
  { value: "ALL", label: "Alle" },
];

const PLATFORM_OPTIONS: Array<{ value: SourcingPlatform | "ALL"; label: string }> = [
  { value: "ALL", label: "Alle Plattformen" },
  { value: "KLEINANZEIGEN", label: "Kleinanzeigen" },
  { value: "EBAY_DE", label: "eBay.de" },
  { value: "WILLHABEN", label: "willhaben" },
  { value: "EBAY_KLEINANZEIGEN", label: "eBay Kleinanzeigen (legacy)" },
];

const SORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "scraped_at", label: "Neueste (scraped)" },
  { value: "posted_at", label: "Neueste (posted)" },
  { value: "profit", label: "Profit (desc)" },
  { value: "roi", label: "ROI (desc)" },
];

function badgeClassForStatus(status: SourcingStatus): string {
  switch (status) {
    case "READY":
      return "badge badge--ok";
    case "NEW":
    case "ANALYZING":
      return "badge";
    case "LOW_VALUE":
    case "DISCARDED":
      return "badge";
    case "ERROR":
      return "badge badge--danger";
    case "CONVERTED":
      return "badge badge--ok";
    default:
      return "badge";
  }
}

export function SourcingPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const [message, setMessage] = useState<string | null>(null);

  const status = (params.get("status") as any) ?? "READY";
  const platform = (params.get("platform") as any) ?? "ALL";
  const sortBy = params.get("sort") ?? "scraped_at";
  const minProfitEur = params.get("min_profit_eur") ?? "";
  const page = Number(params.get("page") ?? "1") || 1;
  const limit = 50;
  const offset = (Math.max(1, page) - 1) * limit;

  const minProfitCents = useMemo(() => {
    const raw = minProfitEur.trim().replace(",", ".");
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return Math.round(n * 100);
  }, [minProfitEur]);

  const health = useQuery({
    queryKey: ["sourcing-health"],
    queryFn: () => api.request<SourcingHealthOut>("/sourcing/health"),
    refetchInterval: 30_000,
  });

  const stats = useQuery({
    queryKey: ["sourcing-stats"],
    queryFn: () => api.request<SourcingStatsOut>("/sourcing/stats"),
    refetchInterval: 30_000,
  });

  const list = useQuery({
    queryKey: ["sourcing-items", status, platform, sortBy, minProfitCents, limit, offset],
    queryFn: () => {
      const usp = new URLSearchParams();
      if (status && status !== "ALL") usp.set("status", String(status));
      if (platform && platform !== "ALL") usp.set("platform", String(platform));
      if (typeof minProfitCents === "number") usp.set("min_profit_cents", String(minProfitCents));
      usp.set("sort_by", sortBy);
      usp.set("limit", String(limit));
      usp.set("offset", String(offset));
      return api.request<SourcingItemListResponse>(`/sourcing/items?${usp.toString()}`);
    },
  });

  const scrape = useMutation({
    mutationFn: (payload: { platform?: SourcingPlatform | null; search_terms?: string[] | null; force?: boolean }) =>
      api.request<SourcingScrapeTriggerOut>("/sourcing/jobs/scrape", { method: "POST", json: payload }),
    onSuccess: (out) => {
      setMessage(`Scrape gestartet (${out.status}). Run: ${out.run_id}`);
      health.refetch();
      stats.refetch();
      list.refetch();
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Scrape fehlgeschlagen")),
  });

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  const counts = stats.data?.items_by_status ?? {};
  const readyCount = counts["READY"] ?? 0;
  const newCount = counts["NEW"] ?? 0;
  const analyzingCount = counts["ANALYZING"] ?? 0;
  const errorCount = counts["ERROR"] ?? 0;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Sourcing</div>
          <div className="page-subtitle">
            Ready: {readyCount} · Neu: {newCount} · Analyzing: {analyzingCount} · Fehler: {errorCount}
          </div>
        </div>
        <div className="page-actions">
          <Button asChild variant="secondary" size="sm">
            <Link to="/sourcing/settings">Einstellungen</Link>
          </Button>
          <Button asChild variant="secondary" size="sm">
            <Link to="/sourcing/agents">Agents</Link>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              health.refetch();
              stats.refetch();
              list.refetch();
            }}
          >
            <RefreshCw size={16} /> Aktualisieren
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => scrape.mutate({ force: true })}
            disabled={scrape.isPending}
          >
            Scrape jetzt
          </Button>
        </div>
      </div>

      {message ? (
        <InlineAlert tone="info" onDismiss={() => setMessage(null)}>
          {message}
        </InlineAlert>
      ) : null}

      {health.isError ? (
        <InlineAlert tone="error">Sourcing Health konnte nicht geladen werden.</InlineAlert>
      ) : health.data ? (
        <div className="panel">
          <div className="panel-title">Status</div>
          <div className="kv" style={{ marginTop: 10 }}>
            <div className="k">System</div>
            <div className="v">
              <span className={health.data.status === "healthy" ? "badge badge--ok" : "badge badge--warn"}>
                {health.data.status}
              </span>{" "}
              <span className="muted">·</span>{" "}
              <span className="muted">{health.data.scraper_status}</span>
            </div>
            <div className="k">Letzter Scrape</div>
            <div className="v">{formatDateTimeLocal(health.data.last_scrape_at)}</div>
            <div className="k">Pending Analysis</div>
            <div className="v">{health.data.items_pending_analysis}</div>
            {health.data.last_error_message ? (
              <>
                <div className="k">Letzter Fehler</div>
                <div className="v">{health.data.last_error_message}</div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="panel">
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <select
            className="input"
            value={status}
            onChange={(e) => {
              params.set("status", e.target.value);
              params.set("page", "1");
              setParams(params, { replace: true });
            }}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                Status: {o.label}
              </option>
            ))}
          </select>

          <select
            className="input"
            value={platform}
            onChange={(e) => {
              params.set("platform", e.target.value);
              params.set("page", "1");
              setParams(params, { replace: true });
            }}
          >
            {PLATFORM_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <select
            className="input"
            value={sortBy}
            onChange={(e) => {
              params.set("sort", e.target.value);
              params.set("page", "1");
              setParams(params, { replace: true });
            }}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                Sort: {o.label}
              </option>
            ))}
          </select>

          <input
            className="input"
            placeholder="Min Profit (EUR)"
            value={minProfitEur}
            onChange={(e) => {
              params.set("min_profit_eur", e.target.value);
              params.set("page", "1");
              setParams(params, { replace: true });
            }}
            inputMode="decimal"
          />

          <div className="toolbar-spacer" />

          <Pagination
            page={page}
            pageSize={limit}
            total={total}
            onPageChange={(p) => {
              params.set("page", String(p));
              setParams(params, { replace: true });
            }}
          />
        </div>

        {list.isError ? <InlineAlert tone="error">Sourcing Items konnten nicht geladen werden.</InlineAlert> : null}

        <table className="table">
          <thead>
            <tr>
              <th>Listing</th>
              <th className="numeric">Preis</th>
              <th className="numeric">Profit</th>
              <th className="numeric">ROI</th>
              <th>Meta</th>
              <th className="numeric">Matches</th>
              <th>Status</th>
              <th className="numeric">Max Buy</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <div
                      style={{
                        width: 52,
                        height: 52,
                        borderRadius: 10,
                        border: "1px solid var(--border)",
                        background: "var(--surface-2)",
                        overflow: "hidden",
                        flex: "0 0 auto",
                      }}
                    >
                      {item.primary_image_url ? (
                        <img src={item.primary_image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ) : null}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 650, letterSpacing: "-0.01em" }}>
                        <Link className="link" to={`/sourcing/${item.id}`}>
                          {item.title}
                        </Link>
                      </div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                        {item.location_city ?? "—"} · {item.platform}
                        {item.bidbag_sent_at ? (
                          <>
                            {" "}
                            · <span className="badge badge--ok">Bidbag</span>
                          </>
                        ) : null}
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <a className="link" href={item.url} target="_blank" rel="noreferrer">
                          <ExternalLink size={14} /> öffnen
                        </a>
                      </div>
                    </div>
                  </div>
                </td>
                <td className="numeric nowrap">{fmtEur(item.price_cents)}</td>
                <td className="numeric nowrap">{fmtEur(item.estimated_profit_cents)}</td>
                <td className="numeric nowrap">{fmtBp(item.estimated_roi_bp)}</td>
                <td>
                  <div className="muted" style={{ fontSize: 12 }}>
                    Posted: {formatDateTimeLocal(item.posted_at ?? null)}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    Scraped: {formatDateTimeLocal(item.scraped_at)}
                  </div>
                  {item.auction_end_at ? (
                    <div className="muted" style={{ fontSize: 12 }}>
                      Auktion: endet {formatDateTimeLocal(item.auction_end_at)} ({item.auction_bid_count ?? 0} Gebote)
                    </div>
                  ) : null}
                </td>
                <td className="numeric">{item.match_count}</td>
                <td>
                  <span className={badgeClassForStatus(item.status)}>{item.status}</span>
                </td>
                <td className="numeric nowrap">{fmtEur(item.max_purchase_price_cents)}</td>
              </tr>
            ))}
            {!items.length && !list.isLoading ? (
              <tr>
                <td colSpan={8} className="muted">
                  Keine Ergebnisse.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
