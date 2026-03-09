import { ArrowLeft, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { InlineMessage } from "../components/ui/inline-message";
import { PageHeader } from "../components/ui/page-header";
import { useApi } from "../lib/api";
import { formatEur } from "../lib/money";


type EvaluationStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
type Recommendation = "BUY" | "WATCH" | "SKIP" | "NEEDS_REVIEW";

type DetailOut = {
  id: string;
  platform: string;
  title: string;
  description?: string | null;
  price_cents: number;
  image_urls: string[];
  location_zip?: string | null;
  location_city?: string | null;
  seller_type?: string | null;
  status: string;
  status_reason?: string | null;
  evaluation_status: EvaluationStatus;
  evaluation_queued_at?: string | null;
  evaluation_started_at?: string | null;
  evaluation_finished_at?: string | null;
  evaluation_attempt_count: number;
  evaluation_last_error?: string | null;
  evaluation_summary?: string | null;
  evaluation_prompt_version?: string | null;
  recommendation?: Recommendation | null;
  expected_profit_cents?: number | null;
  expected_roi_bp?: number | null;
  max_buy_price_cents?: number | null;
  evaluation_confidence?: number | null;
  amazon_source_used?: string | null;
  evaluation?: {
    summary?: string | null;
    recommendation?: Recommendation | null;
    expected_profit_cents?: number | null;
    expected_roi_bp?: number | null;
    max_buy_price_cents?: number | null;
    confidence?: number | null;
    amazon_source_used?: string | null;
    matched_products: Array<{
      master_product_id?: string | null;
      sku?: string | null;
      title?: string | null;
      asin?: string | null;
      confidence?: number | null;
      basis?: string | null;
    }>;
    risks: string[];
    reasoning_notes: string[];
  } | null;
  raw_data?: Record<string, unknown> | null;
  scraped_at: string;
  posted_at?: string | null;
  url: string;
};

function fmtDate(value?: string | null): string {
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

export function SourcingDetailPage() {
  const api = useApi();
  const qc = useQueryClient();
  const { id } = useParams<{ id: string }>();

  const detail = useQuery({
    queryKey: ["sourcing-item", id],
    enabled: !!id,
    queryFn: () => api.request<DetailOut>(`/sourcing/items/${id}`),
  });

  const requeue = useMutation({
    mutationFn: () =>
      api.request(`/sourcing/items/${id}/evaluate`, {
        method: "POST",
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sourcing-item", id] });
      await qc.invalidateQueries({ queryKey: ["sourcing-items"] });
      await qc.invalidateQueries({ queryKey: ["sourcing-health"] });
      await qc.invalidateQueries({ queryKey: ["sourcing-stats"] });
    },
  });

  const discard = useMutation({
    mutationFn: () =>
      api.request<void>(`/sourcing/items/${id}/discard`, {
        method: "POST",
        json: { reason: "Discarded from sourcing detail" },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sourcing-item", id] });
      await qc.invalidateQueries({ queryKey: ["sourcing-items"] });
      await qc.invalidateQueries({ queryKey: ["sourcing-health"] });
      await qc.invalidateQueries({ queryKey: ["sourcing-stats"] });
    },
  });

  const item = detail.data;

  if (!id) {
    return <InlineMessage tone="error">Ungültige Item-ID</InlineMessage>;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sourcing-Detail"
        description="Raw listing evidence plus Codex evaluation."
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
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <div>
                <CardTitle>{item.title}</CardTitle>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-[color:var(--app-text-muted)]">
                  <Badge variant={evaluationBadgeVariant(item.evaluation_status)}>{item.evaluation_status}</Badge>
                  <Badge variant={recommendationBadgeVariant(item.recommendation)}>{item.recommendation || "NO_VERDICT"}</Badge>
                  <span>{item.platform}</span>
                  <span>{item.location_city || "Ort unbekannt"}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={() => detail.refetch()}>
                  <RefreshCw className="h-4 w-4" />
                  Aktualisieren
                </Button>
                <Button type="button" variant="outline" onClick={() => requeue.mutate()} disabled={requeue.isPending}>
                  Erneut bewerten
                </Button>
                <Button type="button" variant="outline" onClick={() => discard.mutate()} disabled={discard.isPending}>
                  <Trash2 className="h-4 w-4" />
                  Verwerfen
                </Button>
                <Button type="button" variant="outline" onClick={() => window.open(item.url, "_blank", "noopener,noreferrer")}>
                  <ExternalLink className="h-4 w-4" />
                  Listing öffnen
                </Button>
              </div>
            </CardHeader>
            <CardContent className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="space-y-4">
                {item.image_urls.length > 0 ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {item.image_urls.slice(0, 6).map((url, idx) => (
                      <div key={`${url}-${idx}`} className="overflow-hidden rounded-md border border-[color:var(--app-border)] bg-[color:var(--app-surface-elevated)]">
                        <img
                          src={url}
                          alt={`Listingbild ${idx + 1}`}
                          className="h-40 w-full object-cover"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <InlineMessage tone="info">Keine Bilder verfügbar.</InlineMessage>
                )}

                <div className="space-y-2 text-sm">
                  <div>Preis: {formatEur(item.price_cents)}</div>
                  <div>Inseriert: {fmtDate(item.posted_at)}</div>
                  <div>Scraped: {fmtDate(item.scraped_at)}</div>
                  <div>Queued: {fmtDate(item.evaluation_queued_at)}</div>
                  <div>Gestartet: {fmtDate(item.evaluation_started_at)}</div>
                  <div>Bewertet: {fmtDate(item.evaluation_finished_at)}</div>
                  <div>Versuche: {item.evaluation_attempt_count}</div>
                  <div>Verkäufer: {item.seller_type || "—"}</div>
                  <div>Status: {item.status}</div>
                  <div>Status-Notiz: {item.status_reason || "—"}</div>
                </div>

                <div className="space-y-2">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-[color:var(--app-text-muted)]">Beschreibung</h3>
                  <p className="whitespace-pre-wrap text-sm text-[color:var(--app-text-muted)]">
                    {item.description || "Keine Beschreibung verfügbar."}
                  </p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="rounded-md border border-[color:var(--app-border)] bg-[color:var(--app-surface-elevated)] p-4">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-[color:var(--app-text-muted)]">Codex Urteil</h3>
                  <div className="mt-3 space-y-2 text-sm">
                    <div>Summary: {item.evaluation_summary || item.evaluation?.summary || "—"}</div>
                    <div>Empfehlung: {item.recommendation || item.evaluation?.recommendation || "—"}</div>
                    <div>Erwarteter Profit: {typeof item.expected_profit_cents === "number" ? formatEur(item.expected_profit_cents) : "—"}</div>
                    <div>ROI: {typeof item.expected_roi_bp === "number" ? `${(item.expected_roi_bp / 100).toFixed(0)}%` : "—"}</div>
                    <div>Max Buy: {typeof item.max_buy_price_cents === "number" ? formatEur(item.max_buy_price_cents) : "—"}</div>
                    <div>Confidence: {typeof item.evaluation_confidence === "number" ? `${item.evaluation_confidence}%` : "—"}</div>
                    <div>Amazon Source: {item.amazon_source_used || "—"}</div>
                    <div>Prompt Version: {item.evaluation_prompt_version || "—"}</div>
                  </div>
                </div>

                {item.evaluation_last_error ? (
                  <InlineMessage tone="error">Codex Fehler: {item.evaluation_last_error}</InlineMessage>
                ) : null}

                <div className="rounded-md border border-[color:var(--app-border)] bg-[color:var(--app-surface-elevated)] p-4">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-[color:var(--app-text-muted)]">ERP Kandidaten / Evidenz</h3>
                  {item.evaluation?.matched_products?.length ? (
                    <div className="mt-3 space-y-2 text-sm">
                      {item.evaluation.matched_products.map((product, idx) => (
                        <div key={`${product.master_product_id || product.sku || "match"}-${idx}`} className="rounded-md border border-[color:var(--app-border)] p-3">
                          <div className="font-medium">{product.title || "Unbenannter Match"}</div>
                          <div className="text-[color:var(--app-text-muted)]">
                            SKU {product.sku || "—"} • ASIN {product.asin || "—"} • Confidence {typeof product.confidence === "number" ? `${product.confidence}%` : "—"}
                          </div>
                          <div className="text-[color:var(--app-text-muted)]">Basis: {product.basis || "—"}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-[color:var(--app-text-muted)]">Keine strukturierten Kandidaten im Codex-Ergebnis.</p>
                  )}
                </div>

                <div className="rounded-md border border-[color:var(--app-border)] bg-[color:var(--app-surface-elevated)] p-4">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-[color:var(--app-text-muted)]">Risiken & Notizen</h3>
                  <div className="mt-3 space-y-3 text-sm text-[color:var(--app-text-muted)]">
                    <div>
                      <div className="font-medium text-[color:var(--app-text)]">Risiken</div>
                      {item.evaluation?.risks?.length ? (
                        <ul className="list-disc pl-5">
                          {item.evaluation.risks.map((risk) => (
                            <li key={risk}>{risk}</li>
                          ))}
                        </ul>
                      ) : (
                        <div>Keine Risiken gemeldet.</div>
                      )}
                    </div>
                    <div>
                      <div className="font-medium text-[color:var(--app-text)]">Reasoning Notes</div>
                      {item.evaluation?.reasoning_notes?.length ? (
                        <ul className="list-disc pl-5">
                          {item.evaluation.reasoning_notes.map((note) => (
                            <li key={note}>{note}</li>
                          ))}
                        </ul>
                      ) : (
                        <div>Keine zusätzlichen Notes.</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Raw Payload</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="overflow-x-auto rounded-md border border-[color:var(--app-border)] bg-[color:var(--app-surface-elevated)] p-3 text-xs">
                {JSON.stringify(item.raw_data ?? {}, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
