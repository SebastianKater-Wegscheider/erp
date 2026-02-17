import { ExternalLink, Play, RefreshCw, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { InlineMessage } from "../components/ui/inline-message";
import { Label } from "../components/ui/label";
import { PageHeader } from "../components/ui/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { useApi } from "../lib/api";
import { formatEur } from "../lib/money";


type SourcingItem = {
  id: string;
  platform: "KLEINANZEIGEN" | "WILLHABEN" | "EBAY_KLEINANZEIGEN";
  title: string;
  price_cents: number;
  location_city?: string | null;
  primary_image_url?: string | null;
  estimated_profit_cents?: number | null;
  estimated_roi_bp?: number | null;
  status: "NEW" | "ANALYZING" | "READY" | "LOW_VALUE" | "CONVERTED" | "DISCARDED" | "ERROR";
  scraped_at: string;
  posted_at?: string | null;
  url: string;
  match_count: number;
};

type SourcingListOut = {
  items: SourcingItem[];
  total: number;
  limit: number;
  offset: number;
};

type SourcingHealthOut = {
  status: string;
  last_scrape_at?: string | null;
  scraper_status: string;
  items_pending_analysis: number;
  last_error_type?: string | null;
  last_error_message?: string | null;
};

const STATUS_OPTIONS = ["ALL", "NEW", "ANALYZING", "READY", "LOW_VALUE", "CONVERTED", "DISCARDED", "ERROR"] as const;
const MIN_PROFIT_OPTIONS = ["ANY", "2000", "3000", "5000"] as const;
const SORT_OPTIONS = ["scraped_at", "posted_at", "profit", "roi"] as const;

function formatDateTime(value?: string | null): string {
  if (!value) return "—";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleString("de-AT", { dateStyle: "short", timeStyle: "short" });
}

export function SourcingPage() {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]>("ALL");
  const [minProfit, setMinProfit] = useState<(typeof MIN_PROFIT_OPTIONS)[number]>("ANY");
  const [sortBy, setSortBy] = useState<(typeof SORT_OPTIONS)[number]>("scraped_at");

  const list = useQuery({
    queryKey: ["sourcing-items", status, minProfit, sortBy],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("limit", "100");
      params.set("offset", "0");
      params.set("sort_by", sortBy);
      if (status !== "ALL") params.set("status", status);
      if (minProfit !== "ANY") params.set("min_profit_cents", minProfit);
      return api.request<SourcingListOut>(`/sourcing/items?${params.toString()}`);
    },
  });

  const health = useQuery({
    queryKey: ["sourcing-health"],
    queryFn: () => api.request<SourcingHealthOut>("/sourcing/health"),
    refetchInterval: 20_000,
  });

  const triggerScrape = useMutation({
    mutationFn: () =>
      api.request<{ status: string; run_id: string }>("/sourcing/jobs/scrape", {
        method: "POST",
        json: { force: true },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sourcing-items"] });
      await qc.invalidateQueries({ queryKey: ["sourcing-health"] });
    },
  });

  const items = list.data?.items ?? [];

  const readyCount = useMemo(() => items.filter((item) => item.status === "READY").length, [items]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sourcing"
        description="Automatisierte Opportunity-Suche mit Match-Review und Conversion in Einkäufe."
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>Scraper Status</CardTitle>
            <p className="text-sm text-[color:var(--app-text-muted)]">
              Status: {health.data?.status ?? "…"} • Scraper: {health.data?.scraper_status ?? "…"}
            </p>
            <p className="text-sm text-[color:var(--app-text-muted)]">
              Letzter Lauf: {formatDateTime(health.data?.last_scrape_at)} • Pending: {health.data?.items_pending_analysis ?? 0}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" asChild>
              <Link to="/sourcing/settings">
                <Settings2 className="h-4 w-4" />
                Settings
              </Link>
            </Button>
            <Button type="button" onClick={() => triggerScrape.mutate()} disabled={triggerScrape.isPending}>
              {triggerScrape.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Jetzt suchen
            </Button>
          </div>
        </CardHeader>
        {health.data?.last_error_type ? (
          <CardContent>
            <InlineMessage tone="info">
              Scraper Fehler: {health.data.last_error_type}
              {health.data.last_error_message ? ` — ${health.data.last_error_message}` : ""}
            </InlineMessage>
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Filter</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1">
            <Label>Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as (typeof STATUS_OPTIONS)[number])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Min Profit</Label>
            <Select value={minProfit} onValueChange={(v) => setMinProfit(v as (typeof MIN_PROFIT_OPTIONS)[number])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ANY">Any</SelectItem>
                <SelectItem value="2000">≥ 20 EUR</SelectItem>
                <SelectItem value="3000">≥ 30 EUR</SelectItem>
                <SelectItem value="5000">≥ 50 EUR</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Sortierung</Label>
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as (typeof SORT_OPTIONS)[number])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="scraped_at">Neueste</SelectItem>
                <SelectItem value="posted_at">Inseriert (neu)</SelectItem>
                <SelectItem value="profit">Profit</SelectItem>
                <SelectItem value="roi">ROI</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Summary</Label>
            <div className="rounded-md border border-[color:var(--app-border)] p-2 text-sm text-[color:var(--app-text-muted)]">
              Total: {list.data?.total ?? 0} • READY: {readyCount}
            </div>
          </div>
        </CardContent>
      </Card>

      {list.isLoading ? <InlineMessage>Lade Sourcing Feed…</InlineMessage> : null}
      {list.error ? <InlineMessage tone="error">Feed konnte nicht geladen werden</InlineMessage> : null}

      <div className="grid gap-4 md:grid-cols-2">
        {items.map((item) => (
          <Card key={item.id}>
            <CardHeader className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <Badge variant={item.status === "READY" ? "success" : "secondary"}>{item.status}</Badge>
                <span className="text-xs text-[color:var(--app-text-muted)]">Scraped: {formatDateTime(item.scraped_at)}</span>
              </div>
              <CardTitle className="text-base">{item.title}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="text-sm text-[color:var(--app-text-muted)]">Inseriert: {formatDateTime(item.posted_at)}</div>
              <div className="text-sm text-[color:var(--app-text-muted)]">{item.location_city || "Ort unbekannt"}</div>
              <div className="text-sm">Preis: {formatEur(item.price_cents)}</div>
              <div className="text-sm">Profit: {typeof item.estimated_profit_cents === "number" ? formatEur(item.estimated_profit_cents) : "—"}</div>
              <div className="text-sm">ROI: {typeof item.estimated_roi_bp === "number" ? `${(item.estimated_roi_bp / 100).toFixed(0)}%` : "—"}</div>
              <div className="text-sm">Matches: {item.match_count}</div>
              <div className="flex items-center gap-2 pt-1">
                <Button type="button" onClick={() => navigate(`/sourcing/${item.id}`)}>Details</Button>
                <Button type="button" variant="outline" onClick={() => window.open(item.url, "_blank", "noopener,noreferrer")}>
                  <ExternalLink className="h-4 w-4" />
                  Listing
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
