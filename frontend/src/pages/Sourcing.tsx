import { Play, RefreshCw, Settings2, Trash2, UsersRound } from "lucide-react";
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


type SourcingStatus = "NEW" | "ANALYZING" | "READY" | "LOW_VALUE" | "CONVERTED" | "DISCARDED" | "ERROR";
type EvaluationStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
type Recommendation = "BUY" | "WATCH" | "SKIP" | "NEEDS_REVIEW";

type SourcingItem = {
  id: string;
  platform: "KLEINANZEIGEN" | "EBAY_DE";
  agent_id?: string | null;
  agent_query_id?: string | null;
  title: string;
  price_cents: number;
  location_city?: string | null;
  primary_image_url?: string | null;
  status: SourcingStatus;
  evaluation_status: EvaluationStatus;
  recommendation?: Recommendation | null;
  evaluation_summary?: string | null;
  expected_profit_cents?: number | null;
  expected_roi_bp?: number | null;
  max_buy_price_cents?: number | null;
  evaluation_finished_at?: string | null;
  evaluation_last_error?: string | null;
  scraped_at: string;
  posted_at?: string | null;
  url: string;
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
  items_pending_evaluation: number;
  items_failed_evaluation: number;
  last_error_type?: string | null;
  last_error_message?: string | null;
};

type SourcingStatsOut = {
  total_items_scraped: number;
  items_by_status: Record<string, number>;
  items_by_evaluation_status: Record<string, number>;
  items_by_recommendation: Record<string, number>;
};

type SourcingScrapeOut = {
  status: string;
  run_id: string;
  items_new: number;
  items_queued: number;
};

const STATUS_OPTIONS = ["ALL", "NEW", "DISCARDED", "ERROR", "CONVERTED"] as const;
const EVALUATION_STATUS_OPTIONS = ["ALL", "PENDING", "RUNNING", "COMPLETED", "FAILED"] as const;
const RECOMMENDATION_OPTIONS = ["ALL", "BUY", "WATCH", "SKIP", "NEEDS_REVIEW"] as const;
const SORT_OPTIONS = ["scraped_at", "posted_at", "evaluation_finished_at", "expected_profit"] as const;
const PLATFORM_OPTIONS = ["ALL", "KLEINANZEIGEN", "EBAY_DE"] as const;
const PAGE_SIZE = 40;

function formatDateTime(value?: string | null): string {
  if (!value) return "—";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleString("de-AT", { dateStyle: "short", timeStyle: "short" });
}

function evaluationBadgeVariant(value: EvaluationStatus): "secondary" | "success" | "danger" {
  if (value === "COMPLETED") return "success";
  if (value === "FAILED") return "danger";
  return "secondary";
}

function recommendationBadgeVariant(value?: Recommendation | null): "secondary" | "success" | "danger" {
  if (value === "BUY") return "success";
  if (value === "SKIP") return "danger";
  return "secondary";
}

export function SourcingPage() {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]>("ALL");
  const [evaluationStatus, setEvaluationStatus] = useState<(typeof EVALUATION_STATUS_OPTIONS)[number]>("ALL");
  const [recommendation, setRecommendation] = useState<(typeof RECOMMENDATION_OPTIONS)[number]>("ALL");
  const [platform, setPlatform] = useState<(typeof PLATFORM_OPTIONS)[number]>("ALL");
  const [sortBy, setSortBy] = useState<(typeof SORT_OPTIONS)[number]>("scraped_at");
  const [currentPage, setCurrentPage] = useState(0);
  const [pendingDiscardId, setPendingDiscardId] = useState<string | null>(null);

  useEffect(() => {
    setCurrentPage(0);
  }, [status, evaluationStatus, recommendation, platform, sortBy]);

  const list = useQuery({
    queryKey: ["sourcing-items", status, evaluationStatus, recommendation, platform, sortBy, currentPage],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(currentPage * PAGE_SIZE));
      params.set("sort_by", sortBy);
      if (status !== "ALL") params.set("status", status);
      if (evaluationStatus !== "ALL") params.set("evaluation_status", evaluationStatus);
      if (recommendation !== "ALL") params.set("recommendation", recommendation);
      if (platform !== "ALL") params.set("platform", platform);
      return api.request<SourcingListOut>(`/sourcing/items?${params.toString()}`);
    },
    placeholderData: (previousData) => previousData,
  });

  const health = useQuery({
    queryKey: ["sourcing-health"],
    queryFn: () => api.request<SourcingHealthOut>("/sourcing/health"),
    refetchInterval: 20_000,
  });

  const stats = useQuery({
    queryKey: ["sourcing-stats"],
    queryFn: () => api.request<SourcingStatsOut>("/sourcing/stats"),
    refetchInterval: 20_000,
  });

  const triggerScrape = useMutation({
    mutationFn: () =>
      api.request<SourcingScrapeOut>("/sourcing/jobs/scrape", {
        method: "POST",
        json: { force: true },
      }),
    onSuccess: async () => {
      setCurrentPage(0);
      await qc.invalidateQueries({ queryKey: ["sourcing-items"] });
      await qc.invalidateQueries({ queryKey: ["sourcing-health"] });
      await qc.invalidateQueries({ queryKey: ["sourcing-stats"] });
    },
  });

  const markDiscarded = useMutation({
    mutationFn: (itemId: string) =>
      api.request<void>(`/sourcing/items/${itemId}/discard`, {
        method: "POST",
        json: { reason: "Discarded from sourcing inbox" },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sourcing-items"] });
      await qc.invalidateQueries({ queryKey: ["sourcing-health"] });
      await qc.invalidateQueries({ queryKey: ["sourcing-stats"] });
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
  const recommendationCounts = stats.data?.items_by_recommendation ?? {};

  useEffect(() => {
    if (list.data && currentPage >= totalPages) {
      setCurrentPage(Math.max(totalPages - 1, 0));
    }
  }, [currentPage, totalPages, list.data]);

  const headline = useMemo(() => {
    const buy = recommendationCounts.BUY ?? 0;
    const watch = recommendationCounts.WATCH ?? 0;
    const review = recommendationCounts.NEEDS_REVIEW ?? 0;
    return `BUY: ${buy} • WATCH: ${watch} • REVIEW: ${review}`;
  }, [recommendationCounts]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sourcing"
        description="Scraped listings with Codex evaluation. The ERP stores the evidence; Codex decides the opportunity quality."
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>Queue Status</CardTitle>
            <p className="text-sm text-[color:var(--app-text-muted)]">
              System: {health.data?.status ?? "…"} • Scraper: {health.data?.scraper_status ?? "…"}
            </p>
            <p className="text-sm text-[color:var(--app-text-muted)]">
              Letzter Lauf: {formatDateTime(health.data?.last_scrape_at)} • Pending: {health.data?.items_pending_evaluation ?? 0} • Failed: {health.data?.items_failed_evaluation ?? 0}
            </p>
            <p className="text-sm text-[color:var(--app-text-muted)]">{headline}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" asChild>
              <Link to="/sourcing/settings">
                <Settings2 className="h-4 w-4" />
                Einstellungen
              </Link>
            </Button>
            <Button type="button" variant="outline" asChild>
              <Link to="/sourcing/agents">
                <UsersRound className="h-4 w-4" />
                Agenten
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
        <CardContent className="grid gap-3 md:grid-cols-6">
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
            <Label>Evaluation</Label>
            <Select value={evaluationStatus} onValueChange={(v) => setEvaluationStatus(v as (typeof EVALUATION_STATUS_OPTIONS)[number])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {EVALUATION_STATUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Codex Empfehlung</Label>
            <Select value={recommendation} onValueChange={(v) => setRecommendation(v as (typeof RECOMMENDATION_OPTIONS)[number])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {RECOMMENDATION_OPTIONS.map((opt) => (
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
            <Label>Sortierung</Label>
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as (typeof SORT_OPTIONS)[number])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="scraped_at">Neueste</SelectItem>
                <SelectItem value="posted_at">Inseriert</SelectItem>
                <SelectItem value="evaluation_finished_at">Zuletzt bewertet</SelectItem>
                <SelectItem value="expected_profit">Erwarteter Profit</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Summary</Label>
            <div className="rounded-md border border-[color:var(--app-border)] p-2 text-sm text-[color:var(--app-text-muted)]">
              Seite {currentPage + 1}/{totalPages} • Total: {total}
            </div>
          </div>
        </CardContent>
      </Card>

      {list.isLoading ? <InlineMessage>Lade Sourcing Feed…</InlineMessage> : null}
      {list.error ? <InlineMessage tone="error">Feed konnte nicht geladen werden</InlineMessage> : null}

      <Card>
        <CardHeader>
          <CardTitle>Inbox</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Listing</TableHead>
                <TableHead>Eval</TableHead>
                <TableHead>Empfehlung</TableHead>
                <TableHead>Codex Summary</TableHead>
                <TableHead>Profit</TableHead>
                <TableHead>Zuletzt</TableHead>
                <TableHead className="text-right">Aktionen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-[color:var(--app-text-muted)]">
                    Keine Listings für die aktuellen Filter.
                  </TableCell>
                </TableRow>
              ) : null}
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <button
                      type="button"
                      className="flex items-start gap-3 text-left"
                      onClick={() => navigate(`/sourcing/${item.id}`)}
                    >
                      {item.primary_image_url ? (
                        <img
                          src={item.primary_image_url}
                          alt=""
                          className="h-14 w-14 rounded-md object-cover"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="h-14 w-14 rounded-md border border-[color:var(--app-border)] bg-[color:var(--app-surface-elevated)]" />
                      )}
                      <div className="space-y-1">
                        <div className="font-medium">{item.title}</div>
                        <div className="text-sm text-[color:var(--app-text-muted)]">
                          {item.platform} • {item.location_city || "Ort unbekannt"}
                        </div>
                        <div className="text-sm text-[color:var(--app-text-muted)]">{formatEur(item.price_cents)}</div>
                      </div>
                    </button>
                  </TableCell>
                  <TableCell>
                    <Badge variant={evaluationBadgeVariant(item.evaluation_status)}>{item.evaluation_status}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={recommendationBadgeVariant(item.recommendation)}>{item.recommendation || "—"}</Badge>
                  </TableCell>
                  <TableCell className="max-w-[24rem] text-sm text-[color:var(--app-text-muted)]">
                    {item.evaluation_summary || item.evaluation_last_error || "Noch keine Codex-Auswertung"}
                  </TableCell>
                  <TableCell>
                    {typeof item.expected_profit_cents === "number" ? formatEur(item.expected_profit_cents) : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-[color:var(--app-text-muted)]">
                    Bewertet: {formatDateTime(item.evaluation_finished_at)}
                    <br />
                    Scraped: {formatDateTime(item.scraped_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="outline" onClick={() => navigate(`/sourcing/${item.id}`)}>
                        Öffnen
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={markDiscarded.isPending && pendingDiscardId === item.id}
                        onClick={() => {
                          setPendingDiscardId(item.id);
                          markDiscarded.mutate(item.id);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                        Verwerfen
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="mt-4 flex items-center justify-between">
            <Button type="button" variant="outline" disabled={!canGoPrev} onClick={() => setCurrentPage((page) => Math.max(page - 1, 0))}>
              Zurück
            </Button>
            <span className="text-sm text-[color:var(--app-text-muted)]">
              Seite {currentPage + 1} von {totalPages}
            </span>
            <Button type="button" variant="outline" disabled={!canGoNext} onClick={() => setCurrentPage((page) => page + 1)}>
              Weiter
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
