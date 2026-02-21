import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { useApi } from "../../api/api";
import { formatDateLocal, formatDateTimeLocal } from "../../lib/dates";
import { fmtEur } from "../../lib/money";
import { fmtBp } from "../../lib/units";
import { Button } from "../../ui/Button";
import { InlineAlert } from "../../ui/InlineAlert";

type SourcingStatus = "NEW" | "ANALYZING" | "READY" | "LOW_VALUE" | "CONVERTED" | "DISCARDED" | "ERROR";
type SourcingPlatform = "KLEINANZEIGEN" | "WILLHABEN" | "EBAY_KLEINANZEIGEN" | "EBAY_DE";
type Condition = "NEW" | "LIKE_NEW" | "GOOD" | "ACCEPTABLE" | "DEFECT";

type SourcingMatch = {
  id: string;
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
  master_product: {
    id: string;
    title: string;
    platform: string;
    asin?: string | null;
  };
};

type SourcingItemDetail = {
  id: string;
  platform: SourcingPlatform;
  title: string;
  description?: string | null;
  price_cents: number;
  image_urls: string[];
  location_zip?: string | null;
  location_city?: string | null;
  status: SourcingStatus;
  status_reason?: string | null;
  estimated_revenue_cents?: number | null;
  estimated_profit_cents?: number | null;
  estimated_roi_bp?: number | null;
  auction_end_at?: string | null;
  auction_current_price_cents?: number | null;
  auction_bid_count?: number | null;
  max_purchase_price_cents?: number | null;
  bidbag_sent_at?: string | null;
  bidbag_last_payload?: Record<string, any> | null;
  scraped_at: string;
  posted_at?: string | null;
  analyzed_at?: string | null;
  url: string;
  matches: SourcingMatch[];
};

type SourcingMatchPatchOut = {
  item_id: string;
  match_id: string;
  status: SourcingStatus;
  estimated_revenue_cents?: number | null;
  estimated_profit_cents?: number | null;
  estimated_roi_bp?: number | null;
};

type ManualCandidate = {
  id: string;
  sku: string;
  title: string;
  platform: string;
  region: string;
  variant: string;
  asin?: string | null;
  rank_overall?: number | null;
  price_used_good_cents?: number | null;
  price_new_cents?: number | null;
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
  purchase_kind: string;
  total_amount_cents: number;
  shipping_cost_cents: number;
  lines: ConversionPreviewOut["lines"];
};

type BidbagHandoffOut = {
  item_id: string;
  deep_link_url?: string | null;
  payload: Record<string, any>;
  sent_at: string;
};

const CONDITION_OPTIONS: Array<{ value: Condition; label: string }> = [
  { value: "NEW", label: "Neu" },
  { value: "LIKE_NEW", label: "Wie neu" },
  { value: "GOOD", label: "Gut" },
  { value: "ACCEPTABLE", label: "Akzeptabel" },
  { value: "DEFECT", label: "Defekt" },
];

function conditionLabel(value: string | null | undefined): string {
  const v = (value ?? "").trim() as any;
  return CONDITION_OPTIONS.find((o) => o.value === v)?.label ?? (v || "—");
}

export function SourcingDetailPage() {
  const { id } = useParams();
  const api = useApi();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [message, setMessage] = useState<string | null>(null);

  const itemId = String(id || "");

  const detail = useQuery({
    queryKey: ["sourcing-item", itemId],
    enabled: Boolean(itemId),
    queryFn: () => api.request<SourcingItemDetail>(`/sourcing/items/${encodeURIComponent(itemId)}`),
  });

  const confirmedMatchIds = useMemo(() => {
    const matches = detail.data?.matches ?? [];
    return matches.filter((m) => m.user_confirmed && !m.user_rejected).map((m) => m.id);
  }, [detail.data?.matches]);

  const patchMatch = useMutation({
    mutationFn: (payload: { match_id: string; patch: Record<string, any> }) =>
      api.request<SourcingMatchPatchOut>(
        `/sourcing/items/${encodeURIComponent(itemId)}/matches/${encodeURIComponent(payload.match_id)}`,
        { method: "PATCH", json: payload.patch },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sourcing-item", itemId] });
      qc.invalidateQueries({ queryKey: ["sourcing-items"] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Update fehlgeschlagen")),
  });

  const [manualQ, setManualQ] = useState("");
  const manualCandidates = useQuery({
    queryKey: ["sourcing-manual-candidates", itemId, manualQ],
    enabled: manualQ.trim().length >= 2 && Boolean(itemId),
    queryFn: () =>
      api.request<ManualCandidate[]>(
        `/sourcing/items/${encodeURIComponent(itemId)}/manual-candidates?q=${encodeURIComponent(manualQ.trim())}&limit=30`,
      ),
  });

  const createManualMatch = useMutation({
    mutationFn: (payload: { master_product_id: string; user_adjusted_condition?: string | null }) =>
      api.request<SourcingMatchPatchOut>(`/sourcing/items/${encodeURIComponent(itemId)}/matches/manual`, {
        method: "POST",
        json: { master_product_id: payload.master_product_id, user_confirmed: true, user_adjusted_condition: payload.user_adjusted_condition ?? null },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sourcing-item", itemId] });
      manualCandidates.refetch();
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Match konnte nicht gesetzt werden")),
  });

  const preview = useMutation({
    mutationFn: () =>
      api.request<ConversionPreviewOut>(`/sourcing/items/${encodeURIComponent(itemId)}/conversion-preview`, {
        method: "POST",
        json: { confirmed_match_ids: confirmedMatchIds.length ? confirmedMatchIds : null },
      }),
    onError: (e: any) => setMessage(String(e?.message ?? "Preview fehlgeschlagen")),
  });

  const convert = useMutation({
    mutationFn: () =>
      api.request<ConvertOut>(`/sourcing/items/${encodeURIComponent(itemId)}/convert`, {
        method: "POST",
        json: { confirmed_match_ids: confirmedMatchIds },
      }),
    onSuccess: (out) => {
      setMessage(`Konvertiert: Purchase ${out.purchase_id}`);
      qc.invalidateQueries({ queryKey: ["sourcing-item", itemId] });
      qc.invalidateQueries({ queryKey: ["sourcing-items"] });
      nav(`/purchases`, { replace: false });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Konvertierung fehlgeschlagen")),
  });

  const discard = useMutation({
    mutationFn: (reason: string | null) =>
      api.request<void>(`/sourcing/items/${encodeURIComponent(itemId)}/discard`, {
        method: "POST",
        json: { reason: reason || null },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sourcing-item", itemId] });
      qc.invalidateQueries({ queryKey: ["sourcing-items"] });
      setMessage("Item verworfen.");
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Discard fehlgeschlagen")),
  });

  const bidbag = useMutation({
    mutationFn: () =>
      api.request<BidbagHandoffOut>(`/sourcing/items/${encodeURIComponent(itemId)}/bidbag-handoff`, { method: "POST" }),
    onSuccess: (out) => {
      setMessage(`Bidbag Payload generiert (${formatDateTimeLocal(out.sent_at)})`);
      qc.invalidateQueries({ queryKey: ["sourcing-item", itemId] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Bidbag fehlgeschlagen")),
  });

  const item = detail.data;
  const primaryImage = item?.image_urls?.[0] ?? item?.image_urls?.[1] ?? null;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Sourcing Detail</div>
          <div className="page-subtitle">
            <Link className="link" to="/sourcing">
              ← Zur Liste
            </Link>
          </div>
        </div>
        <div className="page-actions">
          <Button variant="secondary" size="sm" onClick={() => detail.refetch()}>
            <RefreshCw size={16} /> Aktualisieren
          </Button>
          {item?.url ? (
            <Button asChild variant="secondary" size="sm">
              <a href={item.url} target="_blank" rel="noreferrer">
                <ExternalLink size={16} /> Listing
              </a>
            </Button>
          ) : null}
        </div>
      </div>

      {message ? (
        <InlineAlert tone="info" onDismiss={() => setMessage(null)}>
          {message}
        </InlineAlert>
      ) : null}

      {detail.isError ? <InlineAlert tone="error">Detail konnte nicht geladen werden.</InlineAlert> : null}

      {item ? (
        <div className="split">
          <div className="panel">
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: 14,
                  border: "1px solid var(--border)",
                  background: "var(--surface-2)",
                  overflow: "hidden",
                  flex: "0 0 auto",
                }}
              >
                {primaryImage ? (
                  <img src={primaryImage} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : null}
              </div>
              <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                <div style={{ fontWeight: 750, fontSize: 16, letterSpacing: "-0.01em" }}>{item.title}</div>
                <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                  {item.platform} · {item.location_city ?? "—"} · Status:{" "}
                  <span className={item.status === "READY" ? "badge badge--ok" : item.status === "ERROR" ? "badge badge--danger" : "badge"}>
                    {item.status}
                  </span>
                </div>
                <div className="kv" style={{ marginTop: 10 }}>
                  <div className="k">Preis</div>
                  <div className="v">{fmtEur(item.price_cents)}</div>
                  <div className="k">Profit</div>
                  <div className="v">{fmtEur(item.estimated_profit_cents)}</div>
                  <div className="k">ROI</div>
                  <div className="v">{fmtBp(item.estimated_roi_bp)}</div>
                  <div className="k">Max Buy</div>
                  <div className="v">{fmtEur(item.max_purchase_price_cents)}</div>
                  <div className="k">Posted</div>
                  <div className="v">{formatDateTimeLocal(item.posted_at ?? null)}</div>
                  <div className="k">Scraped</div>
                  <div className="v">{formatDateTimeLocal(item.scraped_at)}</div>
                  {item.auction_end_at ? (
                    <>
                      <div className="k">Auktion</div>
                      <div className="v">
                        endet {formatDateTimeLocal(item.auction_end_at)} · {item.auction_bid_count ?? 0} Gebote ·{" "}
                        {fmtEur(item.auction_current_price_cents)}
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            {item.description ? (
              <div style={{ marginTop: 14 }}>
                <div className="panel-title">Beschreibung</div>
                <pre
                  style={{
                    marginTop: 8,
                    whiteSpace: "pre-wrap",
                    fontFamily: "inherit",
                    fontSize: 13,
                    padding: 10,
                    borderRadius: 10,
                    background: "var(--surface-2)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {item.description}
                </pre>
              </div>
            ) : null}

            <div style={{ marginTop: 14 }}>
              <div className="panel-title">Matches</div>
              <div className="panel-sub">Bestätige passende Master-Products oder füge manuell hinzu.</div>

              <table className="table" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Master Product</th>
                    <th className="numeric">Score</th>
                    <th className="numeric">BSR</th>
                    <th className="numeric">Used</th>
                    <th className="numeric">New</th>
                    <th>Condition</th>
                    <th className="numeric">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {item.matches.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <div style={{ fontWeight: 650 }}>
                          {m.master_product.title}{" "}
                          {m.master_product.asin ? (
                            <a className="link" href={`https://www.amazon.de/dp/${String(m.master_product.asin).trim()}`} target="_blank" rel="noreferrer">
                              <ExternalLink size={14} />
                            </a>
                          ) : null}
                        </div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {m.master_product.platform} · {m.match_method}
                          {m.matched_substring ? ` · "${m.matched_substring}"` : ""}
                        </div>
                      </td>
                      <td className="numeric">{m.confidence_score}</td>
                      <td className="numeric">{m.snapshot_bsr ?? "—"}</td>
                      <td className="numeric nowrap">{fmtEur(m.snapshot_used_price_cents)}</td>
                      <td className="numeric nowrap">{fmtEur(m.snapshot_new_price_cents)}</td>
                      <td className="nowrap">
                        <select
                          className="input"
                          value={(m.user_adjusted_condition as any) ?? ""}
                          onChange={(e) =>
                            patchMatch.mutate({
                              match_id: m.id,
                              patch: { user_adjusted_condition: e.target.value || null },
                            })
                          }
                        >
                          <option value="">(auto)</option>
                          {CONDITION_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="numeric nowrap">
                        <div className="toolbar" style={{ justifyContent: "flex-end" }}>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => patchMatch.mutate({ match_id: m.id, patch: { user_confirmed: true } })}
                            disabled={patchMatch.isPending}
                          >
                            {m.user_confirmed && !m.user_rejected ? "✓ bestätigt" : "Bestätigen"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => patchMatch.mutate({ match_id: m.id, patch: { user_rejected: true } })}
                            disabled={patchMatch.isPending}
                          >
                            {m.user_rejected ? "✕ abgelehnt" : "Ablehnen"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              patchMatch.mutate({
                                match_id: m.id,
                                patch: { user_confirmed: false, user_rejected: false },
                              })
                            }
                            disabled={patchMatch.isPending}
                          >
                            Reset
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!item.matches.length ? (
                    <tr>
                      <td colSpan={7} className="muted">
                        Keine Matches vorhanden.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 14 }}>
              <div className="panel-title">Manuell zuordnen</div>
              <div className="toolbar" style={{ marginTop: 8 }}>
                <input
                  className="input"
                  placeholder="Suche Master Product (Titel / SKU / ASIN / EAN)…"
                  value={manualQ}
                  onChange={(e) => setManualQ(e.target.value)}
                />
                <Button variant="secondary" size="sm" onClick={() => manualCandidates.refetch()} disabled={manualQ.trim().length < 2}>
                  Suchen
                </Button>
              </div>

              {manualCandidates.isError ? <InlineAlert tone="error">Suche fehlgeschlagen.</InlineAlert> : null}

              {manualCandidates.data?.length ? (
                <table className="table" style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>Master Product</th>
                      <th className="numeric">BSR</th>
                      <th className="numeric">Used</th>
                      <th className="numeric">New</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {manualCandidates.data.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <div style={{ fontWeight: 650 }}>
                            {c.title} <span className="muted">·</span> <span className="muted">{c.platform}</span>
                          </div>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {c.sku} · {c.region} · {c.variant}
                          </div>
                        </td>
                        <td className="numeric">{c.rank_overall ?? "—"}</td>
                        <td className="numeric nowrap">{fmtEur(c.price_used_good_cents)}</td>
                        <td className="numeric nowrap">{fmtEur(c.price_new_cents)}</td>
                        <td className="nowrap" style={{ textAlign: "right" }}>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => createManualMatch.mutate({ master_product_id: c.id })}
                            disabled={createManualMatch.isPending}
                          >
                            Zuordnen
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : manualQ.trim().length >= 2 && !manualCandidates.isLoading ? (
                <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
                  Keine Treffer.
                </div>
              ) : null}
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">Aktionen</div>
            <div className="panel-sub">Konvertieren, verwerfen oder Bidbag Payload erzeugen.</div>

            <div className="stack" style={{ marginTop: 10 }}>
              <div className="kv">
                <div className="k">Bestätigte Matches</div>
                <div className="v">{confirmedMatchIds.length}</div>
              </div>

              <Button
                variant="secondary"
                onClick={() => preview.mutate()}
                disabled={preview.isPending}
              >
                Preview Conversion
              </Button>

              {preview.data ? (
                <div className="card" style={{ boxShadow: "none" }}>
                  <div style={{ fontWeight: 650 }}>Preview</div>
                  <div className="kv" style={{ marginTop: 10 }}>
                    <div className="k">Purchase kind</div>
                    <div className="v">{preview.data.purchase_kind}</div>
                    <div className="k">Payment</div>
                    <div className="v">{preview.data.payment_source}</div>
                    <div className="k">Shipping</div>
                    <div className="v">{fmtEur(preview.data.shipping_cost_cents)}</div>
                    <div className="k">Total</div>
                    <div className="v">{fmtEur(preview.data.total_amount_cents)}</div>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                      Lines
                    </div>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Master</th>
                          <th>Cond</th>
                          <th className="numeric">Price</th>
                          <th className="numeric">Margin</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.data.lines.map((l, idx) => (
                          <tr key={`${l.master_product_id}-${idx}`}>
                            <td className="mono">{String(l.master_product_id).slice(0, 8)}…</td>
                            <td>{conditionLabel(l.condition)}</td>
                            <td className="numeric nowrap">{fmtEur(l.purchase_price_cents)}</td>
                            <td className="numeric nowrap">{fmtEur(l.estimated_margin_cents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              <Button
                variant="primary"
                onClick={() => convert.mutate()}
                disabled={confirmedMatchIds.length === 0 || convert.isPending}
              >
                Konvertieren (Purchase)
              </Button>

              <Button
                variant="secondary"
                onClick={() => {
                  const reason = window.prompt("Grund (optional):", "");
                  discard.mutate(reason);
                }}
                disabled={discard.isPending}
              >
                Verwerfen…
              </Button>

              <Button variant="secondary" onClick={() => bidbag.mutate()} disabled={bidbag.isPending}>
                Bidbag Payload
              </Button>

              {item.bidbag_last_payload ? (
                <div className="card" style={{ boxShadow: "none" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ fontWeight: 650 }}>Bidbag</div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Payload kopieren"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(JSON.stringify(item.bidbag_last_payload, null, 2));
                          setMessage("Payload kopiert.");
                        } catch {
                          setMessage("Kopieren fehlgeschlagen.");
                        }
                      }}
                    >
                      <Copy size={16} />
                    </Button>
                  </div>
                  <pre
                    style={{
                      marginTop: 10,
                      whiteSpace: "pre-wrap",
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                      fontSize: 12,
                      padding: 10,
                      borderRadius: 10,
                      background: "var(--surface-2)",
                      border: "1px solid var(--border)",
                      maxHeight: 280,
                      overflow: "auto",
                    }}
                  >
                    {JSON.stringify(item.bidbag_last_payload, null, 2)}
                  </pre>
                </div>
              ) : null}
            </div>

            <div style={{ marginTop: 14 }}>
              <div className="panel-title">Bilder</div>
              <div className="panel-sub">Alle verfügbaren Listing-Bilder.</div>
              <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                {(item.image_urls ?? []).slice(0, 12).map((src, idx) => (
                  <a key={`${src}-${idx}`} href={src} target="_blank" rel="noreferrer" style={{ display: "block" }}>
                    <img
                      src={src}
                      alt=""
                      style={{
                        width: "100%",
                        aspectRatio: "1 / 1",
                        objectFit: "cover",
                        borderRadius: 10,
                        border: "1px solid var(--border)",
                        background: "var(--surface-2)",
                      }}
                    />
                  </a>
                ))}
                {!item.image_urls?.length ? (
                  <div className="muted" style={{ fontSize: 13 }}>
                    Keine Bilder.
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

