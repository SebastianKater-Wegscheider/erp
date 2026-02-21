import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, RefreshCw, Save, Trash2, UploadCloud, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useApi } from "../api/api";
import { formatDateTimeLocal } from "../lib/dates";
import { fmtEur } from "../lib/money";
import { amazonListingUrl, resolveReferenceImageSrc } from "../lib/referenceImages";
import { Button } from "../ui/Button";
import { InlineAlert } from "../ui/InlineAlert";

type MasterProductKind = "GAME" | "CONSOLE" | "ACCESSORY" | "OTHER";

type MasterProduct = {
  id: string;
  sku: string;
  kind: MasterProductKind;
  title: string;
  platform: string;
  region: string;
  variant: string;
  ean?: string | null;
  asin?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  genre?: string | null;
  release_year?: number | null;
  reference_image_url?: string | null;
  created_at: string;
  updated_at: string;

  amazon_last_attempt_at?: string | null;
  amazon_last_success_at?: string | null;
  amazon_last_run_id?: string | null;
  amazon_blocked_last?: boolean | null;
  amazon_block_reason_last?: string | null;
  amazon_last_error?: string | null;

  amazon_rank_overall?: number | null;
  amazon_rank_specific?: number | null;
  amazon_price_new_cents?: number | null;
  amazon_price_used_like_new_cents?: number | null;
  amazon_price_used_very_good_cents?: number | null;
  amazon_price_used_good_cents?: number | null;
  amazon_price_used_acceptable_cents?: number | null;
  amazon_buybox_total_cents?: number | null;
  amazon_offers_count_total?: number | null;
  amazon_offers_count_used_priced_total?: number | null;
  amazon_next_retry_at?: string | null;
  amazon_consecutive_failures?: number | null;
};

type AmazonHistoryPoint = {
  started_at: string;
  ok: boolean;
  blocked: boolean;
  used_best_cents?: number | null;
};

type MasterProductBulkImportRowError = {
  row_number: number;
  message: string;
  title?: string | null;
};

type MasterProductBulkImportOut = {
  total_rows: number;
  imported_count: number;
  failed_count: number;
  skipped_count: number;
  errors: MasterProductBulkImportRowError[];
};

const KIND_OPTIONS: Array<{ value: MasterProductKind; label: string }> = [
  { value: "GAME", label: "Spiel" },
  { value: "CONSOLE", label: "Konsole" },
  { value: "ACCESSORY", label: "Zubehör" },
  { value: "OTHER", label: "Sonstiges" },
];

function fmtMaybe(value?: number | null): string {
  if (value === null || value === undefined) return "—";
  return String(value);
}

function isStale(lastSuccessAt?: string | null): boolean {
  const s = (lastSuccessAt ?? "").trim();
  if (!s) return true;
  const ms = new Date(s).getTime();
  if (!Number.isFinite(ms)) return true;
  return Date.now() - ms > 24 * 60 * 60 * 1000;
}

export function MasterProductsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [message, setMessage] = useState<string | null>(null);

  const q = params.get("q") ?? "";
  const inStockOnly = params.get("in_stock_only") === "1";
  const selectedId = params.get("selected") ?? "";

  const list = useQuery({
    queryKey: ["master-products", inStockOnly],
    queryFn: () => api.request<MasterProduct[]>(`/master-products?in_stock_only=${inStockOnly ? "true" : "false"}`),
  });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = list.data ?? [];
    if (!needle) return rows;
    return rows.filter((m) => {
      const hay = [
        m.sku,
        m.title,
        m.platform,
        m.region,
        m.variant,
        m.asin ?? "",
        m.ean ?? "",
        m.manufacturer ?? "",
        m.model ?? "",
        m.genre ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [list.data, q]);

  const selected = filtered.find((m) => m.id === selectedId) ?? null;

  const [draft, setDraft] = useState<Omit<MasterProduct, "id" | "sku" | "created_at" | "updated_at">>({
    kind: "GAME",
    title: "",
    platform: "",
    region: "EU",
    variant: "",
    ean: "",
    asin: "",
    manufacturer: "",
    model: "",
    genre: "",
    release_year: null,
    reference_image_url: "",
  } as any);

  useEffect(() => {
    if (!selected) return;
    setDraft({
      kind: selected.kind,
      title: selected.title,
      platform: selected.platform,
      region: selected.region,
      variant: selected.variant,
      ean: selected.ean ?? "",
      asin: selected.asin ?? "",
      manufacturer: selected.manufacturer ?? "",
      model: selected.model ?? "",
      genre: selected.genre ?? "",
      release_year: selected.release_year ?? null,
      reference_image_url: selected.reference_image_url ?? "",
    } as any);
  }, [selected?.id]);

  const create = useMutation({
    mutationFn: () =>
      api.request<MasterProduct>("/master-products", {
        method: "POST",
        json: {
          kind: draft.kind,
          title: draft.title,
          platform: draft.platform,
          region: draft.region,
          variant: draft.variant,
          ean: draft.ean?.trim() ? draft.ean.trim() : null,
          asin: draft.asin?.trim() ? draft.asin.trim() : null,
          manufacturer: draft.manufacturer?.trim() ? draft.manufacturer.trim() : null,
          model: draft.model?.trim() ? draft.model.trim() : null,
          genre: draft.genre?.trim() ? draft.genre.trim() : null,
          release_year: typeof draft.release_year === "number" ? draft.release_year : null,
          reference_image_url: draft.reference_image_url?.trim() ? draft.reference_image_url.trim() : null,
        },
      }),
    onSuccess: async (mp) => {
      setMessage("Erstellt.");
      await qc.invalidateQueries({ queryKey: ["master-products"] });
      params.set("selected", mp.id);
      setParams(params, { replace: true });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Create fehlgeschlagen")),
  });

  const save = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error("Kein Master Product ausgewählt");
      return api.request<MasterProduct>(`/master-products/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        json: {
          kind: draft.kind,
          title: draft.title,
          platform: draft.platform,
          region: draft.region,
          variant: draft.variant,
          ean: draft.ean?.trim() ? draft.ean.trim() : null,
          asin: draft.asin?.trim() ? draft.asin.trim() : null,
          manufacturer: draft.manufacturer?.trim() ? draft.manufacturer.trim() : null,
          model: draft.model?.trim() ? draft.model.trim() : null,
          genre: draft.genre?.trim() ? draft.genre.trim() : null,
          release_year: typeof draft.release_year === "number" ? draft.release_year : null,
          reference_image_url: draft.reference_image_url?.trim() ? draft.reference_image_url.trim() : null,
        },
      });
    },
    onSuccess: async () => {
      setMessage("Gespeichert.");
      await qc.invalidateQueries({ queryKey: ["master-products"] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Save fehlgeschlagen")),
  });

  const del = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error("Kein Master Product ausgewählt");
      return api.request<void>(`/master-products/${encodeURIComponent(selected.id)}`, { method: "DELETE" });
    },
    onSuccess: async () => {
      setMessage("Gelöscht.");
      params.delete("selected");
      setParams(params, { replace: true });
      await qc.invalidateQueries({ queryKey: ["master-products"] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Delete fehlgeschlagen")),
  });

  const triggerAmazon = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error("Kein Master Product ausgewählt");
      return api.request<{ run_id: string; ok: boolean; blocked: boolean; error?: string | null }>(
        "/amazon-scrapes/trigger",
        { method: "POST", json: { master_product_id: selected.id } },
      );
    },
    onSuccess: async (out) => {
      setMessage(out.ok ? `Amazon scrape ok (${out.run_id})` : `Amazon scrape gestartet (${out.run_id})`);
      await qc.invalidateQueries({ queryKey: ["master-products"] });
      await qc.invalidateQueries({ queryKey: ["amazon-history", selected?.id] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Amazon scrape fehlgeschlagen")),
  });

  const history = useQuery({
    queryKey: ["amazon-history", selected?.id],
    enabled: Boolean(selected?.id),
    queryFn: () => api.request<AmazonHistoryPoint[]>(`/amazon-scrapes/history?master_product_id=${encodeURIComponent(selected!.id)}&limit=40`),
  });

  const [csvText, setCsvText] = useState("");
  const [delimiter, setDelimiter] = useState<string>("");
  const bulkImport = useMutation({
    mutationFn: () =>
      api.request<MasterProductBulkImportOut>("/master-products/bulk-import", {
        method: "POST",
        json: { csv_text: csvText, delimiter: delimiter.trim() ? delimiter.trim() : null },
      }),
    onSuccess: async (out) => {
      setMessage(`Import: ${out.imported_count} ok, ${out.failed_count} failed, ${out.skipped_count} skipped.`);
      await qc.invalidateQueries({ queryKey: ["master-products"] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Import fehlgeschlagen")),
  });

  const staleCount = useMemo(() => (list.data ?? []).filter((m) => m.asin && isStale(m.amazon_last_success_at)).length, [list.data]);
  const missingAsinCount = useMemo(() => (list.data ?? []).filter((m) => !(m.asin ?? "").trim()).length, [list.data]);

  const previewSrc = resolveReferenceImageSrc(draft.reference_image_url);
  const amazonUrl = amazonListingUrl(draft.asin);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Produktstamm</div>
          <div className="page-subtitle">
            {filtered.length} Produkte · fehlende ASIN: {missingAsinCount} · stale Amazon: {staleCount}
          </div>
        </div>
        <div className="page-actions">
          <Button variant="secondary" size="sm" onClick={() => list.refetch()}>
            <RefreshCw size={16} /> Aktualisieren
          </Button>
        </div>
      </div>

      {message ? (
        <InlineAlert tone="info" onDismiss={() => setMessage(null)}>
          {message}
        </InlineAlert>
      ) : null}

      <div className="split">
        <div className="panel">
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <input
              className="input"
              placeholder="Suche (Titel/SKU/ASIN/EAN)…"
              value={q}
              onChange={(e) => {
                params.set("q", e.target.value);
                setParams(params, { replace: true });
              }}
            />

            <label className="checkbox" style={{ marginLeft: 6 }}>
              <input
                type="checkbox"
                checked={inStockOnly}
                onChange={(e) => {
                  params.set("in_stock_only", e.target.checked ? "1" : "0");
                  setParams(params, { replace: true });
                }}
              />
              In-stock only
            </label>

            <div className="toolbar-spacer" />
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                params.delete("selected");
                setParams(params, { replace: true });
                setDraft({
                  kind: "GAME",
                  title: "",
                  platform: "",
                  region: "EU",
                  variant: "",
                  ean: "",
                  asin: "",
                  manufacturer: "",
                  model: "",
                  genre: "",
                  release_year: null,
                  reference_image_url: "",
                } as any);
              }}
            >
              Neu
            </Button>
          </div>

          {list.isError ? <InlineAlert tone="error">Master Products konnten nicht geladen werden.</InlineAlert> : null}

          <table className="table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Produkt</th>
                <th>ASIN</th>
                <th className="numeric">BSR</th>
                <th className="numeric">Used</th>
                <th>Amazon</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => {
                const stale = m.asin ? isStale(m.amazon_last_success_at) : false;
                return (
                  <tr
                    key={m.id}
                    onClick={() => {
                      params.set("selected", m.id);
                      setParams(params, { replace: true });
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <td className="mono">{m.sku}</td>
                    <td>
                      <div style={{ fontWeight: 650 }}>{m.title}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {m.platform} · {m.region}
                        {m.variant ? ` · ${m.variant}` : ""}
                      </div>
                    </td>
                    <td className="mono">{m.asin ?? "—"}</td>
                    <td className="numeric">{m.amazon_rank_specific ?? m.amazon_rank_overall ?? "—"}</td>
                    <td className="numeric nowrap">{fmtEur(m.amazon_price_used_good_cents ?? m.amazon_price_used_very_good_cents ?? m.amazon_price_used_like_new_cents ?? m.amazon_price_used_acceptable_cents)}</td>
                    <td>
                      {m.asin ? (
                        <span className={m.amazon_blocked_last ? "badge badge--danger" : stale ? "badge badge--warn" : "badge badge--ok"}>
                          {m.amazon_blocked_last ? "blocked" : stale ? "stale" : "fresh"}
                        </span>
                      ) : (
                        <span className="badge">no ASIN</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!filtered.length && !list.isLoading ? (
                <tr>
                  <td colSpan={6} className="muted">
                    Keine Treffer.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>

          <details style={{ marginTop: 12 }}>
            <summary className="muted" style={{ cursor: "pointer" }}>
              Bulk Import (CSV)
            </summary>
            <div className="stack" style={{ marginTop: 10 }}>
              <textarea className="input" rows={10} value={csvText} onChange={(e) => setCsvText(e.target.value)} placeholder="CSV Text…" />
              <div className="toolbar">
                <input className="input" style={{ width: 120 }} value={delimiter} onChange={(e) => setDelimiter(e.target.value)} placeholder="Delimiter" />
                <Button variant="secondary" onClick={() => bulkImport.mutate()} disabled={!csvText.trim() || bulkImport.isPending}>
                  <UploadCloud size={16} /> Import
                </Button>
              </div>
            </div>
          </details>
        </div>

        <div className="panel">
          <div className="panel-title">{selected ? "Bearbeiten" : "Neues Master Product"}</div>
          <div className="panel-sub">{selected ? selected.id : "Fülle die Felder aus und erstelle ein neues Produkt."}</div>

          <div className="stack" style={{ marginTop: 10 }}>
            <div className="toolbar">
              <select className="input" value={draft.kind} onChange={(e) => setDraft((p: any) => ({ ...p, kind: e.target.value }))}>
                {KIND_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input className="input" value={draft.platform} onChange={(e) => setDraft((p: any) => ({ ...p, platform: e.target.value }))} placeholder="Platform" />
              <input className="input" value={draft.region} onChange={(e) => setDraft((p: any) => ({ ...p, region: e.target.value }))} placeholder="Region" />
            </div>

            <input className="input" value={draft.title} onChange={(e) => setDraft((p: any) => ({ ...p, title: e.target.value }))} placeholder="Titel" />
            <input className="input" value={draft.variant} onChange={(e) => setDraft((p: any) => ({ ...p, variant: e.target.value }))} placeholder="Variante" />

            <div className="toolbar">
              <input className="input" value={draft.ean ?? ""} onChange={(e) => setDraft((p: any) => ({ ...p, ean: e.target.value }))} placeholder="EAN" />
              <input className="input" value={draft.asin ?? ""} onChange={(e) => setDraft((p: any) => ({ ...p, asin: e.target.value }))} placeholder="ASIN" />
              {amazonUrl ? (
                <Button asChild variant="secondary" size="sm">
                  <a href={amazonUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={16} /> Amazon
                  </a>
                </Button>
              ) : null}
            </div>

            <div className="toolbar">
              <input className="input" value={draft.manufacturer ?? ""} onChange={(e) => setDraft((p: any) => ({ ...p, manufacturer: e.target.value }))} placeholder="Hersteller" />
              <input className="input" value={draft.model ?? ""} onChange={(e) => setDraft((p: any) => ({ ...p, model: e.target.value }))} placeholder="Model" />
            </div>

            <div className="toolbar">
              <input className="input" value={draft.genre ?? ""} onChange={(e) => setDraft((p: any) => ({ ...p, genre: e.target.value }))} placeholder="Genre" />
              <input
                className="input"
                type="number"
                value={draft.release_year ?? ""}
                onChange={(e) => setDraft((p: any) => ({ ...p, release_year: e.target.value ? Number(e.target.value) : null }))}
                placeholder="Release year"
              />
            </div>

            <input
              className="input"
              value={draft.reference_image_url ?? ""}
              onChange={(e) => setDraft((p: any) => ({ ...p, reference_image_url: e.target.value }))}
              placeholder="Reference image URL"
            />

            {previewSrc ? (
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <img
                  src={previewSrc}
                  alt=""
                  style={{
                    width: 56,
                    height: 56,
                    objectFit: "cover",
                    borderRadius: 14,
                    border: "1px solid var(--border)",
                    background: "var(--surface-2)",
                  }}
                />
                <div className="muted" style={{ fontSize: 12 }}>
                  Referenzbild
                </div>
              </div>
            ) : null}

            <div className="toolbar">
              {selected ? (
                <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
                  <Save size={16} /> Speichern
                </Button>
              ) : (
                <Button variant="primary" onClick={() => create.mutate()} disabled={create.isPending || !draft.title.trim() || !draft.platform.trim()}>
                  <Save size={16} /> Erstellen
                </Button>
              )}

              {selected ? (
                <Button
                  variant="secondary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(selected.id);
                      setMessage("UUID kopiert.");
                    } catch {
                      setMessage("Kopieren fehlgeschlagen.");
                    }
                  }}
                >
                  <Copy size={16} /> UUID
                </Button>
              ) : null}

              {selected ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (!window.confirm("Master Product wirklich löschen?")) return;
                    del.mutate();
                  }}
                  disabled={del.isPending}
                >
                  <Trash2 size={16} /> Löschen
                </Button>
              ) : null}
            </div>

            {selected ? (
              <div className="card" style={{ boxShadow: "none" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <div style={{ fontWeight: 650 }}>Amazon Metrics</div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      Last success: {formatDateTimeLocal(selected.amazon_last_success_at ?? null)} · BSR:{" "}
                      {selected.amazon_rank_specific ?? selected.amazon_rank_overall ?? "—"} · Offers:{" "}
                      {selected.amazon_offers_count_used_priced_total ?? selected.amazon_offers_count_total ?? "—"}
                    </div>
                    {selected.amazon_last_error ? (
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                        Error: {selected.amazon_last_error}
                      </div>
                    ) : null}
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => triggerAmazon.mutate()} disabled={triggerAmazon.isPending || !selected.asin}>
                    <Zap size={16} /> Scrape
                  </Button>
                </div>

                {history.data?.length ? (
                  <table className="table" style={{ marginTop: 10 }}>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Status</th>
                        <th className="numeric">Used best</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.data.slice().reverse().map((p) => (
                        <tr key={p.started_at}>
                          <td className="muted">{formatDateTimeLocal(p.started_at)}</td>
                          <td>
                            <span className={p.blocked ? "badge badge--danger" : p.ok ? "badge badge--ok" : "badge badge--warn"}>
                              {p.blocked ? "blocked" : p.ok ? "ok" : "error"}
                            </span>
                          </td>
                          <td className="numeric nowrap">{fmtEur(p.used_best_cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                    Keine History.
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

