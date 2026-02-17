import { ExternalLink, Play, RefreshCw, Settings2, UsersRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { InlineMessage } from "../components/ui/inline-message";
import { Label } from "../components/ui/label";
import { PageHeader } from "../components/ui/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { useApi } from "../lib/api";
import { formatEur } from "../lib/money";


type SourcingItem = {
  id: string;
  platform: "KLEINANZEIGEN" | "WILLHABEN" | "EBAY_KLEINANZEIGEN" | "EBAY_DE";
  agent_id?: string | null;
  agent_query_id?: string | null;
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
const PLATFORM_OPTIONS = ["ALL", "KLEINANZEIGEN", "EBAY_DE", "WILLHABEN", "EBAY_KLEINANZEIGEN"] as const;
const PAGE_SIZE = 40;

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
  const [platform, setPlatform] = useState<(typeof PLATFORM_OPTIONS)[number]>("ALL");
  const [minProfit, setMinProfit] = useState<(typeof MIN_PROFIT_OPTIONS)[number]>("ANY");
  const [sortBy, setSortBy] = useState<(typeof SORT_OPTIONS)[number]>("scraped_at");
  const [currentPage, setCurrentPage] = useState(0);
  const [pendingDiscardId, setPendingDiscardId] = useState<string | null>(null);

  useEffect(() => {
    setCurrentPage(0);
  }, [status, platform, minProfit, sortBy]);

  const list = useQuery({
    queryKey: ["sourcing-items", status, platform, minProfit, sortBy, currentPage],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(currentPage * PAGE_SIZE));
      params.set("sort_by", sortBy);
      if (status !== "ALL") params.set("status", status);
      if (platform !== "ALL") params.set("platform", platform);
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
      setCurrentPage(0);
      await qc.invalidateQueries({ queryKey: ["sourcing-items"] });
      await qc.invalidateQueries({ queryKey: ["sourcing-health"] });
    },
  });

  const markUninteresting = useMutation({
    mutationFn: (itemId: string) =>
      api.request<void>(`/sourcing/items/${itemId}/discard`, {
        method: "POST",
        json: { reason: "Marked uninteresting from sourcing list" },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sourcing-items"] });
      await qc.invalidateQueries({ queryKey: ["sourcing-health"] });
    },
    onSettled: () => {
      setPendingDiscardId(null);
    },
  });

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const canGoPrev = currentPage > 0;
  const canGoNext = currentPage + 1 < totalPages;

  const readyCount = useMemo(() => items.filter((item) => item.status === "READY").length, [items]);

  useEffect(() => {
    if (currentPage >= totalPages) {
      setCurrentPage(Math.max(totalPages - 1, 0));
    }
  }, [currentPage, totalPages]);

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
            <Button type="button" variant="outline" asChild>
              <Link to="/sourcing/agents">
                <UsersRound className="h-4 w-4" />
                Agents
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
        <CardContent className="grid gap-3 md:grid-cols-5">
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
            <Label>Plattform</Label>
            <Select value={platform} onValueChange={(v) => setPlatform(v as (typeof PLATFORM_OPTIONS)[number])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {PLATFORM_OPTIONS.map((opt) => (
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
              Seite {currentPage + 1}/{totalPages} • Total: {total} • READY (Seite): {readyCount}
            </div>
          </div>
        </CardContent>
      </Card>

      {list.isLoading ? <InlineMessage>Lade Sourcing Feed…</InlineMessage> : null}
      {list.error ? <InlineMessage tone="error">Feed konnte nicht geladen werden</InlineMessage> : null}

      <Card>
        <CardHeader>
          <CardTitle>Listings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="overflow-x-auto rounded-md border border-[color:var(--app-border)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bild</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Titel</TableHead>
                  <TableHead>Plattform</TableHead>
                  <TableHead>Ort</TableHead>
                  <TableHead>Preis</TableHead>
                  <TableHead>Profit</TableHead>
                  <TableHead>ROI</TableHead>
                  <TableHead>Matches</TableHead>
                  <TableHead>Scraped</TableHead>
                  <TableHead>Aktionen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const canMarkUninteresting = item.status !== "DISCARDED" && item.status !== "CONVERTED";
                  const discardPending = markUninteresting.isPending && pendingDiscardId === item.id;
                  return (
                    <TableRow key={item.id}>
                      <TableCell>
                        {item.primary_image_url ? (
                          <img
                            src={item.primary_image_url}
                            alt={`Listingbild von ${item.title}`}
                            className="h-12 w-12 rounded-md object-cover"
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="flex h-12 w-12 items-center justify-center rounded-md border border-dashed border-[color:var(--app-border)] bg-[color:var(--app-surface-elevated)] text-[10px] text-[color:var(--app-text-muted)]">
                            Kein Bild
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={item.status === "READY" ? "success" : "secondary"}>{item.status}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{item.title}</div>
                        {item.platform === "EBAY_DE" ? (
                          <div className="text-xs text-[color:var(--app-text-muted)]">
                            Gebot {typeof item.auction_current_price_cents === "number" ? formatEur(item.auction_current_price_cents) : "—"}
                            {" • "}
                            Max {typeof item.max_purchase_price_cents === "number" ? formatEur(item.max_purchase_price_cents) : "—"}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>{item.platform}</TableCell>
                      <TableCell>{item.location_city || "—"}</TableCell>
                      <TableCell>{formatEur(item.price_cents)}</TableCell>
                      <TableCell>{typeof item.estimated_profit_cents === "number" ? formatEur(item.estimated_profit_cents) : "—"}</TableCell>
                      <TableCell>{typeof item.estimated_roi_bp === "number" ? `${(item.estimated_roi_bp / 100).toFixed(0)}%` : "—"}</TableCell>
                      <TableCell>{item.match_count}</TableCell>
                      <TableCell>{formatDateTime(item.scraped_at)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Button type="button" size="sm" onClick={() => navigate(`/sourcing/${item.id}`)}>Details</Button>
                          <Button type="button" size="sm" variant="outline" onClick={() => window.open(item.url, "_blank", "noopener,noreferrer")}>
                            <ExternalLink className="h-4 w-4" />
                            Listing
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={!canMarkUninteresting || markUninteresting.isPending}
                            onClick={() => {
                              setPendingDiscardId(item.id);
                              markUninteresting.mutate(item.id);
                            }}
                          >
                            {discardPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
                            Uninteressant
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11} className="text-sm text-[color:var(--app-text-muted)]">
                      Keine Listings für die aktuelle Filterung.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
          {markUninteresting.error ? <InlineMessage tone="error">Uninteressant-Markierung fehlgeschlagen.</InlineMessage> : null}
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm text-[color:var(--app-text-muted)]">Seite {currentPage + 1} von {totalPages}</div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => setCurrentPage((p) => Math.max(0, p - 1))} disabled={!canGoPrev || list.isFetching}>
                Zurück
              </Button>
              <Button type="button" variant="outline" onClick={() => setCurrentPage((p) => p + 1)} disabled={!canGoNext || list.isFetching}>
                Weiter
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
