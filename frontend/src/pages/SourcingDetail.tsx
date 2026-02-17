import { ArrowLeft, Check, ExternalLink, RefreshCw, Send, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { InlineMessage } from "../components/ui/inline-message";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { useApi } from "../lib/api";
import { formatEur } from "../lib/money";


type MatchRow = {
  id: string;
  master_product: {
    id: string;
    title: string;
    platform: string;
    asin?: string | null;
  };
  confidence_score: number;
  match_method: string;
  matched_substring?: string | null;
  snapshot_bsr?: number | null;
  snapshot_new_price_cents?: number | null;
  snapshot_used_price_cents?: number | null;
  snapshot_fba_payout_cents?: number | null;
  user_confirmed: boolean;
  user_rejected: boolean;
  user_adjusted_condition?: string | null;
};

type SourcingDetailOut = {
  id: string;
  platform: string;
  agent_id?: string | null;
  agent_query_id?: string | null;
  title: string;
  description?: string | null;
  price_cents: number;
  image_urls: string[];
  location_zip?: string | null;
  location_city?: string | null;
  status: string;
  status_reason?: string | null;
  estimated_revenue_cents?: number | null;
  estimated_profit_cents?: number | null;
  estimated_roi_bp?: number | null;
  auction_end_at?: string | null;
  auction_current_price_cents?: number | null;
  auction_bid_count?: number | null;
  max_purchase_price_cents?: number | null;
  bidbag_sent_at?: string | null;
  bidbag_last_payload?: Record<string, unknown> | null;
  scraped_at: string;
  posted_at?: string | null;
  analyzed_at?: string | null;
  url: string;
  matches: MatchRow[];
};

type BidbagHandoffOut = {
  item_id: string;
  deep_link_url?: string | null;
  payload: Record<string, unknown>;
  sent_at: string;
};

type ConversionPreviewOut = {
  purchase_kind: string;
  payment_source: string;
  total_amount_cents: number;
  shipping_cost_cents: number;
  lines: Array<{
    master_product_id: string;
    condition: string;
    purchase_price_cents: number;
    estimated_margin_cents?: number | null;
  }>;
};

type ConvertOut = {
  purchase_id: string;
};

type ManualCandidateRow = {
  id: string;
  title: string;
  platform: string;
  region: string;
  variant: string;
  asin?: string | null;
  rank_overall?: number | null;
  price_used_good_cents?: number | null;
  price_new_cents?: number | null;
};

function fmtDate(value?: string | null): string {
  if (!value) return "—";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleString("de-AT", { dateStyle: "short", timeStyle: "short" });
}

export function SourcingDetailPage() {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [bidbagMessage, setBidbagMessage] = useState<string | null>(null);
  const [manualSearch, setManualSearch] = useState("");
  const [pendingManualProductId, setPendingManualProductId] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ["sourcing-item", id],
    enabled: !!id,
    queryFn: () => api.request<SourcingDetailOut>(`/sourcing/items/${id}`),
  });
  const manualSearchTrimmed = manualSearch.trim();

  const confirmedMatchIds = useMemo(() => {
    const rows = detail.data?.matches ?? [];
    return rows.filter((m) => m.user_confirmed && !m.user_rejected).map((m) => m.id);
  }, [detail.data?.matches]);

  const manualCandidates = useQuery({
    queryKey: ["sourcing-manual-candidates", id, manualSearchTrimmed],
    enabled: !!id && manualSearchTrimmed.length >= 2,
    queryFn: () =>
      api.request<ManualCandidateRow[]>(
        `/sourcing/items/${id}/manual-candidates?q=${encodeURIComponent(manualSearchTrimmed)}&limit=20`,
      ),
  });

  const preview = useMutation({
    mutationFn: () =>
      api.request<ConversionPreviewOut>(`/sourcing/items/${id}/conversion-preview`, {
        method: "POST",
        json: { confirmed_match_ids: confirmedMatchIds },
      }),
  });

  const patchMatch = useMutation({
    mutationFn: (payload: { matchId: string; body: Record<string, unknown> }) =>
      api.request(`/sourcing/items/${id}/matches/${payload.matchId}`, {
        method: "PATCH",
        json: payload.body,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sourcing-item", id] });
      await qc.invalidateQueries({ queryKey: ["sourcing-items"] });
    },
  });

  const addManualMatch = useMutation({
    mutationFn: (masterProductId: string) =>
      api.request(`/sourcing/items/${id}/matches/manual`, {
        method: "POST",
        json: { master_product_id: masterProductId, user_confirmed: true },
      }),
    onMutate: (masterProductId) => {
      setPendingManualProductId(masterProductId);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sourcing-item", id] });
      await qc.invalidateQueries({ queryKey: ["sourcing-items"] });
      await qc.invalidateQueries({ queryKey: ["sourcing-manual-candidates", id] });
    },
    onSettled: () => {
      setPendingManualProductId(null);
    },
  });

  const convert = useMutation({
    mutationFn: () =>
      api.request<ConvertOut>(`/sourcing/items/${id}/convert`, {
        method: "POST",
        json: { confirmed_match_ids: confirmedMatchIds },
      }),
    onSuccess: async (out) => {
      await qc.invalidateQueries({ queryKey: ["sourcing-item", id] });
      await qc.invalidateQueries({ queryKey: ["sourcing-items"] });
      await qc.invalidateQueries({ queryKey: ["purchases"] });
      navigate(`/purchases`);
      console.info("Created purchase", out.purchase_id);
    },
  });

  const discard = useMutation({
    mutationFn: () =>
      api.request<void>(`/sourcing/items/${id}/discard`, {
        method: "POST",
        json: { reason: "Discarded in sourcing UI" },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sourcing-item", id] });
      await qc.invalidateQueries({ queryKey: ["sourcing-items"] });
    },
  });

  const bidbag = useMutation({
    mutationFn: () =>
      api.request<BidbagHandoffOut>(`/sourcing/items/${id}/bidbag-handoff`, {
        method: "POST",
      }),
    onSuccess: async (out) => {
      await qc.invalidateQueries({ queryKey: ["sourcing-item", id] });
      await qc.invalidateQueries({ queryKey: ["sourcing-items"] });
      if (out.deep_link_url) {
        window.open(out.deep_link_url, "_blank", "noopener,noreferrer");
        setBidbagMessage("Bidbag-Link geöffnet.");
        return;
      }
      const text = JSON.stringify(out.payload, null, 2);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setBidbagMessage("Bidbag-Payload in die Zwischenablage kopiert.");
      } else {
        setBidbagMessage("Bidbag-Payload erstellt (Copy nicht verfügbar).");
      }
    },
  });

  const item = detail.data;
  const canConvert = item?.status === "READY" && confirmedMatchIds.length > 0;
  const canDiscard = item ? item.status !== "DISCARDED" && item.status !== "CONVERTED" : false;

  if (!id) {
    return <InlineMessage tone="error">Ungültige Item-ID</InlineMessage>;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sourcing Detail"
        description="Match-Review, Kalkulation und Conversion in Einkauf"
        actions={
          <Button type="button" variant="outline" asChild>
            <Link to="/sourcing">
              <ArrowLeft className="h-4 w-4" />
              Zurück
            </Link>
          </Button>
        }
      />

      {detail.isLoading ? <InlineMessage>Lade Detailansicht…</InlineMessage> : null}
      {detail.error ? <InlineMessage tone="error">Detailansicht konnte nicht geladen werden</InlineMessage> : null}

      {item ? (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle>{item.title}</CardTitle>
                <Badge variant={item.status === "READY" ? "success" : "secondary"}>{item.status}</Badge>
              </div>
              <div className="text-sm text-[color:var(--app-text-muted)]">
                Inseriert: {fmtDate(item.posted_at)} • Scraped: {fmtDate(item.scraped_at)} • Analyzed: {fmtDate(item.analyzed_at)} • {item.location_city || "Ort unbekannt"}
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {item.image_urls.length > 0 ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {item.image_urls.slice(0, 4).map((url, idx) => (
                    <div key={`${url}-${idx}`} className="overflow-hidden rounded-md border border-[color:var(--app-border)] bg-[color:var(--app-surface-elevated)]">
                      <img
                        src={url}
                        alt={`Listingbild ${idx + 1} von ${item.title}`}
                        className="h-40 w-full object-cover"
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <InlineMessage tone="info">Keine Listing-Bilder verfügbar.</InlineMessage>
              )}
              <div>Preis: {formatEur(item.price_cents)}</div>
              <div>Geschätzter Umsatz: {typeof item.estimated_revenue_cents === "number" ? formatEur(item.estimated_revenue_cents) : "—"}</div>
              <div>Geschätzter Profit: {typeof item.estimated_profit_cents === "number" ? formatEur(item.estimated_profit_cents) : "—"}</div>
              <div>ROI: {typeof item.estimated_roi_bp === "number" ? `${(item.estimated_roi_bp / 100).toFixed(0)}%` : "—"}</div>
              {item.platform === "EBAY_DE" ? (
                <>
                  <div>Aktuelles Gebot: {typeof item.auction_current_price_cents === "number" ? formatEur(item.auction_current_price_cents) : "—"}</div>
                  <div>Auktionsende: {fmtDate(item.auction_end_at)}</div>
                  <div>Gebote: {typeof item.auction_bid_count === "number" ? item.auction_bid_count : "—"}</div>
                  <div>Max. Kaufpreis: {typeof item.max_purchase_price_cents === "number" ? formatEur(item.max_purchase_price_cents) : "—"}</div>
                  <div>
                    Headroom: {typeof item.max_purchase_price_cents === "number" && typeof item.auction_current_price_cents === "number" ? formatEur(item.max_purchase_price_cents - item.auction_current_price_cents) : "—"}
                  </div>
                </>
              ) : null}
              <div className="flex items-center gap-2 pt-1">
                <Button type="button" variant="outline" onClick={() => window.open(item.url, "_blank", "noopener,noreferrer")}>
                  <ExternalLink className="h-4 w-4" />
                  Listing öffnen
                </Button>
                <Button type="button" variant="outline" onClick={() => preview.mutate()} disabled={preview.isPending}>
                  {preview.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
                  Conversion Preview
                </Button>
                <Button
                  type="button"
                  onClick={() => convert.mutate()}
                  disabled={convert.isPending || !canConvert}
                >
                  Purchase erstellen
                </Button>
                {canDiscard ? (
                  <Button type="button" variant="outline" onClick={() => discard.mutate()} disabled={discard.isPending}>
                    Verwerfen
                  </Button>
                ) : null}
                {item.platform === "EBAY_DE" ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => bidbag.mutate()}
                    disabled={bidbag.isPending || !item.max_purchase_price_cents}
                  >
                    {bidbag.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    Send to bidbag
                  </Button>
                ) : null}
              </div>
              {bidbagMessage ? <InlineMessage tone="info">{bidbagMessage}</InlineMessage> : null}
              {bidbag.error ? <InlineMessage tone="error">{String((bidbag.error as Error).message)}</InlineMessage> : null}
              {convert.error ? <InlineMessage tone="error">{String((convert.error as Error).message)}</InlineMessage> : null}
              {discard.error ? <InlineMessage tone="error">{String((discard.error as Error).message)}</InlineMessage> : null}
            </CardContent>
          </Card>

          {preview.data ? (
            <Card>
              <CardHeader>
                <CardTitle>Conversion Preview</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div>Kind: {preview.data.purchase_kind}</div>
                <div>Payment: {preview.data.payment_source}</div>
                <div>Total: {formatEur(preview.data.total_amount_cents)} + Versand {formatEur(preview.data.shipping_cost_cents)}</div>
                {preview.data.lines.map((line, idx) => (
                  <div key={`${line.master_product_id}-${idx}`}>
                    {line.master_product_id}: {line.condition} • {formatEur(line.purchase_price_cents)}
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Matches ({item.matches.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Produkt</TableHead>
                    <TableHead>Confidence</TableHead>
                    <TableHead>BSR</TableHead>
                    <TableHead>Payout</TableHead>
                    <TableHead>Aktionen</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {item.matches.map((match) => (
                    <TableRow key={match.id}>
                      <TableCell>
                        <div className="font-medium">{match.master_product.title}</div>
                        <div className="text-xs text-[color:var(--app-text-muted)]">{match.master_product.platform}</div>
                      </TableCell>
                      <TableCell>{match.confidence_score}%</TableCell>
                      <TableCell>{typeof match.snapshot_bsr === "number" ? match.snapshot_bsr.toLocaleString("de-AT") : "—"}</TableCell>
                      <TableCell>{typeof match.snapshot_fba_payout_cents === "number" ? formatEur(match.snapshot_fba_payout_cents) : "—"}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant={match.user_confirmed ? "default" : "outline"}
                            aria-label={`Match bestätigen: ${match.master_product.title}`}
                            onClick={() => patchMatch.mutate({ matchId: match.id, body: { user_confirmed: !match.user_confirmed } })}
                          >
                            <Check className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant={match.user_rejected ? "default" : "outline"}
                            aria-label={`Match ablehnen: ${match.master_product.title}`}
                            onClick={() => patchMatch.mutate({ matchId: match.id, body: { user_rejected: !match.user_rejected } })}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Manuelles Matching</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                value={manualSearch}
                onChange={(event) => setManualSearch(event.target.value)}
                placeholder="Produkt suchen (Titel, Plattform, SKU, ASIN, EAN)…"
                aria-label="Manuelle Match-Suche"
              />
              {manualSearchTrimmed.length < 2 ? (
                <InlineMessage tone="info">Bitte mindestens 2 Zeichen eingeben.</InlineMessage>
              ) : null}
              {manualCandidates.isLoading ? <InlineMessage>Lade Kandidaten…</InlineMessage> : null}
              {manualCandidates.error ? <InlineMessage tone="error">Kandidaten konnten nicht geladen werden.</InlineMessage> : null}
              {manualSearchTrimmed.length >= 2 &&
              !manualCandidates.isLoading &&
              !manualCandidates.error &&
              (manualCandidates.data?.length ?? 0) === 0 ? (
                <InlineMessage tone="info">Keine Kandidaten gefunden.</InlineMessage>
              ) : null}
              {(manualCandidates.data?.length ?? 0) > 0 ? (
                <div className="overflow-x-auto rounded-md border border-[color:var(--app-border)]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Produkt</TableHead>
                        <TableHead>Plattform</TableHead>
                        <TableHead>BSR</TableHead>
                        <TableHead>Used/New</TableHead>
                        <TableHead>Aktion</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(manualCandidates.data ?? []).map((candidate) => {
                        const isPending = addManualMatch.isPending && pendingManualProductId === candidate.id;
                        return (
                          <TableRow key={candidate.id}>
                            <TableCell>
                              <div className="font-medium">{candidate.title}</div>
                              <div className="text-xs text-[color:var(--app-text-muted)]">
                                {candidate.region} {candidate.variant ? `• ${candidate.variant}` : ""}
                              </div>
                            </TableCell>
                            <TableCell>{candidate.platform}</TableCell>
                            <TableCell>
                              {typeof candidate.rank_overall === "number"
                                ? candidate.rank_overall.toLocaleString("de-AT")
                                : "—"}
                            </TableCell>
                            <TableCell>
                              {typeof candidate.price_used_good_cents === "number"
                                ? formatEur(candidate.price_used_good_cents)
                                : "—"}
                              {" / "}
                              {typeof candidate.price_new_cents === "number" ? formatEur(candidate.price_new_cents) : "—"}
                            </TableCell>
                            <TableCell>
                              <Button
                                type="button"
                                size="sm"
                                disabled={isPending}
                                onClick={() => addManualMatch.mutate(candidate.id)}
                              >
                                {isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
                                Als Match hinzufügen
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              ) : null}
              {addManualMatch.error ? (
                <InlineMessage tone="error">{String((addManualMatch.error as Error).message)}</InlineMessage>
              ) : null}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
