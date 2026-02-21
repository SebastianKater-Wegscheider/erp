import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ImagePlus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useApi } from "../api/api";
import { formatDateLocal, formatDateTimeLocal } from "../lib/dates";
import { fmtEur } from "../lib/money";
import { resolveReferenceImageSrc } from "../lib/referenceImages";
import { Button } from "../ui/Button";
import { InlineAlert } from "../ui/InlineAlert";

type InventoryStatus =
  | "DRAFT"
  | "AVAILABLE"
  | "FBA_INBOUND"
  | "FBA_WAREHOUSE"
  | "RESERVED"
  | "SOLD"
  | "RETURNED"
  | "DISCREPANCY"
  | "LOST";

type InventoryQueue = "PHOTOS_MISSING" | "STORAGE_MISSING" | "AMAZON_STALE" | "OLD_STOCK_90D";

type TargetPriceMode = "AUTO" | "MANUAL";
type EffectiveTargetPriceSource = "MANUAL" | "AUTO_AMAZON" | "AUTO_COST_FLOOR" | "UNPRICED";

type InventoryItem = {
  id: string;
  item_code: string;
  master_product_id: string;
  purchase_line_id?: string | null;
  condition: string;
  purchase_type: string;
  purchase_price_cents: number;
  allocated_costs_cents: number;
  storage_location?: string | null;
  serial_number?: string | null;
  status: InventoryStatus;
  acquired_date?: string | null;
  created_at: string;
  updated_at: string;
  target_price_mode: TargetPriceMode;
  manual_target_sell_price_cents?: number | null;
  recommended_target_sell_price_cents?: number | null;
  effective_target_sell_price_cents?: number | null;
  effective_target_price_source: EffectiveTargetPriceSource;
  target_price_recommendation?: {
    strategy: string;
    recommended_target_sell_price_cents: number;
    anchor_price_cents?: number | null;
    anchor_source: string;
    rank?: number | null;
    offers_count?: number | null;
    adjustment_bp: number;
    margin_floor_net_cents: number;
    margin_floor_price_cents: number;
    summary: string;
  } | null;
};

type InventoryCondition = "NEW" | "LIKE_NEW" | "GOOD" | "ACCEPTABLE" | "DEFECT";

type MasterProduct = {
  id: string;
  sku: string;
  kind: string;
  title: string;
  platform: string;
  region: string;
  variant: string;
  ean?: string | null;
  asin?: string | null;
  reference_image_url?: string | null;
  amazon_last_success_at?: string | null;
  amazon_blocked_last?: boolean | null;
  amazon_rank_overall?: number | null;
  amazon_rank_specific?: number | null;
  amazon_offers_count_total?: number | null;
  amazon_offers_count_used_priced_total?: number | null;
};

type InventoryImage = {
  id: string;
  inventory_item_id: string;
  upload_path: string;
  created_at: string;
};

type UploadOut = { upload_path: string };

const STATUS_OPTIONS: Array<{ value: InventoryStatus | "ALL"; label: string }> = [
  { value: "ALL", label: "Alle" },
  { value: "DRAFT", label: "Entwurf" },
  { value: "AVAILABLE", label: "Verfügbar" },
  { value: "FBA_INBOUND", label: "FBA Unterwegs" },
  { value: "FBA_WAREHOUSE", label: "FBA Lagernd" },
  { value: "RESERVED", label: "Reserviert" },
  { value: "SOLD", label: "Verkauft" },
  { value: "RETURNED", label: "Retourniert" },
  { value: "DISCREPANCY", label: "Abweichung" },
  { value: "LOST", label: "Verloren" },
];

const QUEUE_OPTIONS: Array<{ value: InventoryQueue | "ALL"; label: string }> = [
  { value: "ALL", label: "Alle" },
  { value: "PHOTOS_MISSING", label: "Fotos fehlen" },
  { value: "STORAGE_MISSING", label: "Lagerplatz fehlt" },
  { value: "AMAZON_STALE", label: "Amazon stale" },
  { value: "OLD_STOCK_90D", label: "Altbestand >90T" },
];

const CONDITION_OPTIONS: Array<{ value: InventoryCondition; label: string }> = [
  { value: "NEW", label: "Neu" },
  { value: "LIKE_NEW", label: "Wie neu" },
  { value: "GOOD", label: "Gut" },
  { value: "ACCEPTABLE", label: "Akzeptabel" },
  { value: "DEFECT", label: "Defekt" },
];

function statusLabel(status: InventoryStatus): string {
  return STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;
}

function badgeClassForStatus(status: InventoryStatus): string {
  switch (status) {
    case "AVAILABLE":
    case "FBA_WAREHOUSE":
      return "badge badge--ok";
    case "DRAFT":
    case "FBA_INBOUND":
    case "RESERVED":
    case "RETURNED":
    case "DISCREPANCY":
      return "badge badge--warn";
    case "SOLD":
      return "badge";
    case "LOST":
      return "badge badge--danger";
    default:
      return "badge";
  }
}

function effectiveSourceLabel(source: EffectiveTargetPriceSource): string {
  switch (source) {
    case "MANUAL":
      return "manual";
    case "AUTO_AMAZON":
      return "auto (Amazon)";
    case "AUTO_COST_FLOOR":
      return "auto (Floor)";
    case "UNPRICED":
      return "unpriced";
    default:
      return source;
  }
}

function isLikelyImagePath(path: string): boolean {
  const p = (path ?? "").toLowerCase();
  return p.endsWith(".png") || p.endsWith(".jpg") || p.endsWith(".jpeg") || p.endsWith(".webp") || p.endsWith(".gif");
}

export function InventoryPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [message, setMessage] = useState<string | null>(null);

  const q = params.get("q") ?? "";
  const status = (params.get("status") as any) ?? "ALL";
  const queue = (params.get("queue") as any) ?? "ALL";
  const offset = Number(params.get("offset") ?? "0") || 0;
  const limit = 50;
  const selectedId = params.get("selected") ?? "";

  const master = useQuery({
    queryKey: ["master-products"],
    queryFn: () => api.request<MasterProduct[]>("/master-products"),
  });

  const mpById = useMemo(() => {
    const map = new Map<string, MasterProduct>();
    (master.data ?? []).forEach((m) => map.set(m.id, m));
    return map;
  }, [master.data]);

  const inv = useQuery({
    queryKey: ["inventory", q, status, queue, limit, offset],
    queryFn: () => {
      const usp = new URLSearchParams();
      usp.set("limit", String(limit));
      usp.set("offset", String(Math.max(0, offset)));
      if (q.trim()) usp.set("q", q.trim());
      if (status && status !== "ALL") usp.set("status", String(status));
      if (queue && queue !== "ALL") usp.set("queue", String(queue));
      return api.request<InventoryItem[]>(`/inventory?${usp.toString()}`);
    },
  });

  const rows = inv.data ?? [];
  const hasNext = rows.length === limit;
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const selectedMaster = selected ? mpById.get(selected.master_product_id) ?? null : null;

  const rowImages = useQuery({
    queryKey: ["inventory-row-images", rows.map((r) => r.id).join(",")],
    enabled: rows.length > 0,
    queryFn: () => {
      const usp = new URLSearchParams();
      rows.forEach((r) => usp.append("item_ids", r.id));
      return api.request<InventoryImage[]>(`/inventory/images?${usp.toString()}`);
    },
  });

  const rowPrimaryImageByItemId = useMemo(() => {
    const map = new Map<string, InventoryImage>();
    for (const img of rowImages.data ?? []) {
      if (!map.has(img.inventory_item_id)) map.set(img.inventory_item_id, img);
    }
    return map;
  }, [rowImages.data]);

  const [rowThumbUrls, setRowThumbUrls] = useState<Record<string, string>>({});
  const rowThumbUrlsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    rowThumbUrlsRef.current = rowThumbUrls;
  }, [rowThumbUrls]);

  useEffect(() => {
    return () => {
      Object.values(rowThumbUrlsRef.current).forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  useEffect(() => {
    const desired = new Map<string, InventoryImage>();
    for (const [itemId, img] of rowPrimaryImageByItemId.entries()) {
      if (isLikelyImagePath(img.upload_path)) desired.set(itemId, img);
    }
    const desiredItemIds = new Set(desired.keys());

    setRowThumbUrls((prev) => {
      const next: Record<string, string> = {};
      let changed = false;
      for (const [itemId, url] of Object.entries(prev)) {
        if (desiredItemIds.has(itemId)) next[itemId] = url;
        else {
          changed = true;
          URL.revokeObjectURL(url);
        }
      }
      return changed ? next : prev;
    });

    const missing = Array.from(desired.entries()).filter(([itemId]) => !rowThumbUrls[itemId]);
    if (!missing.length) return;

    let cancelled = false;
    (async () => {
      const created: Record<string, string> = {};
      for (const [itemId, img] of missing) {
        try {
          const blob = await api.fileBlob(img.upload_path);
          if (cancelled) break;
          if (!blob.type.startsWith("image/")) continue;
          created[itemId] = URL.createObjectURL(blob);
        } catch {
          // ignore
        }
      }
      if (cancelled) {
        Object.values(created).forEach((u) => URL.revokeObjectURL(u));
        return;
      }
      if (Object.keys(created).length) setRowThumbUrls((prev) => ({ ...prev, ...created }));
    })();

    return () => {
      cancelled = true;
    };
  }, [api, rowPrimaryImageByItemId, rowThumbUrls]);

  const images = useQuery({
    queryKey: ["inventory-images", selected?.id],
    enabled: Boolean(selected?.id),
    queryFn: () => api.request<InventoryImage[]>(`/inventory/${encodeURIComponent(selected!.id)}/images`),
  });

  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const imageUrlsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    imageUrlsRef.current = imageUrls;
  }, [imageUrls]);

  useEffect(() => {
    return () => {
      Object.values(imageUrlsRef.current).forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  useEffect(() => {
    const keep = new Set((images.data ?? []).map((i) => i.id));
    setImageUrls((prev) => {
      const next: Record<string, string> = {};
      let changed = false;
      for (const [id, url] of Object.entries(prev)) {
        if (keep.has(id)) next[id] = url;
        else {
          changed = true;
          URL.revokeObjectURL(url);
        }
      }
      return changed ? next : prev;
    });

    const missing = (images.data ?? []).filter((img) => isLikelyImagePath(img.upload_path) && !imageUrls[img.id]);
    if (!missing.length) return;

    let cancelled = false;
    (async () => {
      const created: Record<string, string> = {};
      for (const img of missing) {
        try {
          const blob = await api.fileBlob(img.upload_path);
          if (cancelled) break;
          if (!blob.type.startsWith("image/")) continue;
          created[img.id] = URL.createObjectURL(blob);
        } catch {
          // ignore
        }
      }
      if (cancelled) {
        Object.values(created).forEach((u) => URL.revokeObjectURL(u));
        return;
      }
      if (Object.keys(created).length) setImageUrls((prev) => ({ ...prev, ...created }));
    })();

    return () => {
      cancelled = true;
    };
  }, [api, images.data, imageUrls]);

  const [editStorage, setEditStorage] = useState("");
  const [editSerial, setEditSerial] = useState("");
  const [editTargetMode, setEditTargetMode] = useState<TargetPriceMode>("AUTO");
  const [editManualEur, setEditManualEur] = useState("");

  useEffect(() => {
    if (!selected) return;
    setEditStorage(selected.storage_location ?? "");
    setEditSerial(selected.serial_number ?? "");
    setEditTargetMode(selected.target_price_mode ?? "AUTO");
    setEditManualEur(
      typeof selected.manual_target_sell_price_cents === "number" ? String(selected.manual_target_sell_price_cents / 100).replace(".", ",") : "",
    );
  }, [selected?.id]);

  const updateItem = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("Kein Item ausgewählt");
      const payload: any = {
        storage_location: editStorage.trim() ? editStorage.trim() : null,
        serial_number: editSerial.trim() ? editSerial.trim() : null,
        target_price_mode: editTargetMode,
      };
      if (editTargetMode === "MANUAL") {
        const raw = editManualEur.trim().replace(",", ".");
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) throw new Error("Ungültiger Preis");
        payload.manual_target_sell_price_cents = Math.round(n * 100);
      } else {
        payload.manual_target_sell_price_cents = null;
      }
      return api.request<InventoryItem>(`/inventory/${encodeURIComponent(selected.id)}`, { method: "PATCH", json: payload });
    },
    onSuccess: async () => {
      setMessage("Gespeichert.");
      await qc.invalidateQueries({ queryKey: ["inventory"] });
      await qc.invalidateQueries({ queryKey: ["inventory-images"] });
      await qc.invalidateQueries({ queryKey: ["inventory-row-images"] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Speichern fehlgeschlagen")),
  });

  const [nextStatus, setNextStatus] = useState<InventoryStatus>("AVAILABLE");
  useEffect(() => {
    if (selected) setNextStatus(selected.status);
  }, [selected?.id]);

  const transition = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("Kein Item ausgewählt");
      return api.request<InventoryItem>(`/inventory/${encodeURIComponent(selected.id)}/status`, {
        method: "POST",
        json: { new_status: nextStatus },
      });
    },
    onSuccess: async () => {
      setMessage("Status aktualisiert.");
      await qc.invalidateQueries({ queryKey: ["inventory"] });
      await qc.invalidateQueries({ queryKey: ["inventory-row-images"] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Statuswechsel fehlgeschlagen")),
  });

  const uploadImages = useMutation({
    mutationFn: async (files: File[]) => {
      if (!selected) throw new Error("Kein Item ausgewählt");
      const created: InventoryImage[] = [];
      for (const file of files) {
        const uploaded = await api.uploadFile(file);
        const img = await api.request<InventoryImage>(`/inventory/${encodeURIComponent(selected.id)}/images`, {
          method: "POST",
          json: { upload_path: uploaded.upload_path },
        });
        created.push(img);
      }
      return created;
    },
    onSuccess: async () => {
      setMessage("Bilder hochgeladen.");
      await qc.invalidateQueries({ queryKey: ["inventory-images", selected?.id] });
      await qc.invalidateQueries({ queryKey: ["inventory-row-images"] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Upload fehlgeschlagen")),
  });

  const removeImage = useMutation({
    mutationFn: async (imageId: string) => {
      if (!selected) throw new Error("Kein Item ausgewählt");
      return api.request<void>(`/inventory/${encodeURIComponent(selected.id)}/images/${encodeURIComponent(imageId)}`, { method: "DELETE" });
    },
    onSuccess: async () => {
      setMessage("Bild entfernt.");
      await qc.invalidateQueries({ queryKey: ["inventory-images", selected?.id] });
      await qc.invalidateQueries({ queryKey: ["inventory-row-images"] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Löschen fehlgeschlagen")),
  });

  // ---------------------------------------------------------------------------
  // Bulk target pricing
  // ---------------------------------------------------------------------------

  type AsinState = "ANY" | "WITH_ASIN" | "WITHOUT_ASIN";
  type BulkOperation = "APPLY_RECOMMENDED_MANUAL" | "CLEAR_MANUAL_USE_AUTO";

  type BulkFilters = {
    conditions?: InventoryCondition[] | null;
    asin_state: AsinState;
    bsr_min?: number | null;
    bsr_max?: number | null;
    offers_min?: number | null;
    offers_max?: number | null;
  };

  type BulkRequest = { filters: BulkFilters; operation: BulkOperation };

  type BulkPreviewRow = {
    item_id: string;
    item_code: string;
    title: string;
    condition: InventoryCondition;
    asin?: string | null;
    rank?: number | null;
    offers_count?: number | null;
    before_target_price_mode: TargetPriceMode;
    before_effective_target_sell_price_cents?: number | null;
    before_effective_target_price_source: EffectiveTargetPriceSource;
    after_target_price_mode: TargetPriceMode;
    after_effective_target_sell_price_cents?: number | null;
    after_effective_target_price_source: EffectiveTargetPriceSource;
    delta_cents?: number | null;
  };

  type BulkPreviewOut = {
    matched_count: number;
    applicable_count: number;
    truncated: boolean;
    rows: BulkPreviewRow[];
  };

  type BulkApplyOut = {
    matched_count: number;
    updated_count: number;
    skipped_count: number;
    sample_updated_item_ids: string[];
  };

  const [bulkOp, setBulkOp] = useState<BulkOperation>("APPLY_RECOMMENDED_MANUAL");
  const [bulkAsinState, setBulkAsinState] = useState<AsinState>("ANY");
  const [bulkCond, setBulkCond] = useState<Record<InventoryCondition, boolean>>({
    NEW: true,
    LIKE_NEW: true,
    GOOD: true,
    ACCEPTABLE: true,
    DEFECT: true,
  });
  const [bulkBsrMin, setBulkBsrMin] = useState("");
  const [bulkBsrMax, setBulkBsrMax] = useState("");
  const [bulkOffersMin, setBulkOffersMin] = useState("");
  const [bulkOffersMax, setBulkOffersMax] = useState("");

  const bulkRequest: BulkRequest = useMemo(() => {
    const conditions = CONDITION_OPTIONS.filter((c) => bulkCond[c.value]).map((c) => c.value);
    const parseOptInt = (s: string): number | null => {
      const raw = s.trim();
      if (!raw) return null;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return null;
      return Math.trunc(n);
    };
    return {
      operation: bulkOp,
      filters: {
        conditions: conditions.length === CONDITION_OPTIONS.length ? null : conditions,
        asin_state: bulkAsinState,
        bsr_min: parseOptInt(bulkBsrMin),
        bsr_max: parseOptInt(bulkBsrMax),
        offers_min: parseOptInt(bulkOffersMin),
        offers_max: parseOptInt(bulkOffersMax),
      },
    };
  }, [bulkAsinState, bulkBsrMax, bulkBsrMin, bulkCond, bulkOffersMax, bulkOffersMin, bulkOp]);

  const bulkPreview = useMutation({
    mutationFn: () => api.request<BulkPreviewOut>("/inventory/target-pricing/preview", { method: "POST", json: bulkRequest }),
    onError: (e: any) => setMessage(String(e?.message ?? "Bulk preview fehlgeschlagen")),
  });

  const bulkApply = useMutation({
    mutationFn: () => api.request<BulkApplyOut>("/inventory/target-pricing/apply", { method: "POST", json: bulkRequest }),
    onSuccess: async (out) => {
      setMessage(`Bulk apply: ${out.updated_count} updated, ${out.skipped_count} skipped.`);
      bulkPreview.reset();
      await qc.invalidateQueries({ queryKey: ["inventory"] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Bulk apply fehlgeschlagen")),
  });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Lagerbestand</div>
          <div className="page-subtitle">Suche, Work Queues und schnelle Korrekturen (Fotos / Lagerplatz / Pricing).</div>
        </div>
        <div className="page-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              master.refetch();
              inv.refetch();
              rowImages.refetch();
            }}
          >
            <RefreshCw size={16} /> Aktualisieren
          </Button>
        </div>
      </div>

      {message ? (
        <InlineAlert tone="info" onDismiss={() => setMessage(null)}>
          {message}
        </InlineAlert>
      ) : null}

      <div className="split" data-mobile={selectedId ? "detail" : "list"}>
        <div className="panel">
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <input
              className="input"
              placeholder="Suche (Titel/EAN/ASIN/SKU/Item code)…"
              value={q}
              onChange={(e) => {
                params.set("q", e.target.value);
                params.set("offset", "0");
                setParams(params, { replace: true });
              }}
            />

            <select
              className="input"
              value={status}
              onChange={(e) => {
                params.set("status", e.target.value);
                params.set("offset", "0");
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
              value={queue}
              onChange={(e) => {
                params.set("queue", e.target.value);
                params.set("offset", "0");
                setParams(params, { replace: true });
              }}
            >
              {QUEUE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  Queue: {o.label}
                </option>
              ))}
            </select>
          </div>

          {inv.isError ? <InlineAlert tone="error">Inventory konnte nicht geladen werden.</InlineAlert> : null}

          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Status</th>
                <th className="numeric">Buy</th>
                <th className="numeric">Target</th>
                <th className="numeric">Quelle</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const mp = mpById.get(row.master_product_id) ?? null;
                const customThumb = rowThumbUrls[row.id] ?? "";
                const referenceThumb = mp ? resolveReferenceImageSrc(mp.reference_image_url) : "";
                const isSelected = selectedId === row.id;
                return (
                  <tr
                    key={row.id}
                    onClick={() => {
                      params.set("selected", row.id);
                      setParams(params, { replace: true });
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <td>
                      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                        <div style={{ display: "flex", gap: 6, flex: "0 0 auto" }}>
                          <div
                            style={{
                              width: 44,
                              height: 44,
                              borderRadius: 12,
                              border: "1px solid var(--border)",
                              background: "var(--surface-2)",
                              overflow: "hidden",
                              flex: "0 0 auto",
                            }}
                            title="Item Fotos"
                          >
                            {customThumb ? (
                              <img src={customThumb} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                            ) : (
                              <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", color: "var(--muted)", fontSize: 12 }}>
                                —
                              </div>
                            )}
                          </div>

                          <div
                            style={{
                              width: 44,
                              height: 44,
                              borderRadius: 12,
                              border: "1px solid var(--border)",
                              background: "var(--surface-2)",
                              overflow: "hidden",
                              flex: "0 0 auto",
                            }}
                            title="Master Product Referenzbild"
                          >
                            {referenceThumb ? (
                              <img src={referenceThumb} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                            ) : (
                              <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", color: "var(--muted)", fontSize: 12 }}>
                                —
                              </div>
                            )}
                          </div>
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 650, letterSpacing: "-0.01em" }}>
                            {mp ? <span title={mp.title}>{mp.title}</span> : <span className="muted">({row.master_product_id})</span>}
                          </div>
                          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                            {mp ? `${mp.platform} · ${mp.region}${mp.variant ? ` · ${mp.variant}` : ""}` : "—"} · {row.condition}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={badgeClassForStatus(row.status)}>{statusLabel(row.status)}</span>
                    </td>
                    <td className="numeric nowrap">{fmtEur(row.purchase_price_cents + row.allocated_costs_cents)}</td>
                    <td className="numeric nowrap">{fmtEur(row.effective_target_sell_price_cents)}</td>
                    <td className="numeric muted nowrap">{effectiveSourceLabel(row.effective_target_price_source)}</td>
                  </tr>
                );
              })}
              {!rows.length && !inv.isLoading ? (
                <tr>
                  <td colSpan={5} className="muted">
                    Keine Treffer.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>

          <div className="toolbar" style={{ marginTop: 10 }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                params.set("offset", String(Math.max(0, offset - limit)));
                setParams(params, { replace: true });
              }}
              disabled={offset <= 0}
            >
              ← Prev
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                params.set("offset", String(offset + limit));
                setParams(params, { replace: true });
              }}
              disabled={!hasNext}
            >
              Next →
            </Button>
            <div className="muted" style={{ fontSize: 12 }}>
              Offset {offset} · Limit {limit}
            </div>
          </div>

          <details style={{ marginTop: 12 }}>
            <summary className="muted" style={{ cursor: "pointer" }}>
              Bulk target pricing
            </summary>
            <div className="stack" style={{ marginTop: 10 }}>
              <div className="toolbar">
                <select className="input" value={bulkOp} onChange={(e) => setBulkOp(e.target.value as BulkOperation)}>
                  <option value="APPLY_RECOMMENDED_MANUAL">Apply recommended as MANUAL</option>
                  <option value="CLEAR_MANUAL_USE_AUTO">Clear manual (use AUTO)</option>
                </select>
                <select className="input" value={bulkAsinState} onChange={(e) => setBulkAsinState(e.target.value as AsinState)}>
                  <option value="ANY">ASIN: any</option>
                  <option value="WITH_ASIN">ASIN: with</option>
                  <option value="WITHOUT_ASIN">ASIN: without</option>
                </select>
                <Button variant="secondary" size="sm" onClick={() => bulkPreview.mutate()} disabled={bulkPreview.isPending}>
                  Preview
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    if (!bulkPreview.data?.rows?.length) return;
                    if (!window.confirm("Bulk apply wirklich ausführen?")) return;
                    bulkApply.mutate();
                  }}
                  disabled={!bulkPreview.data?.rows?.length || bulkApply.isPending}
                >
                  Apply
                </Button>
              </div>

              <div className="card" style={{ boxShadow: "none" }}>
                <div style={{ fontWeight: 650 }}>Filter</div>
                <div className="toolbar" style={{ marginTop: 10, gap: 12 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    {CONDITION_OPTIONS.map((c) => (
                      <label key={c.value} className="checkbox">
                        <input
                          type="checkbox"
                          checked={bulkCond[c.value]}
                          onChange={(e) => setBulkCond((prev) => ({ ...prev, [c.value]: e.target.checked }))}
                        />
                        {c.label}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="toolbar" style={{ marginTop: 10 }}>
                  <input className="input" placeholder="BSR min" value={bulkBsrMin} onChange={(e) => setBulkBsrMin(e.target.value)} inputMode="numeric" />
                  <input className="input" placeholder="BSR max" value={bulkBsrMax} onChange={(e) => setBulkBsrMax(e.target.value)} inputMode="numeric" />
                  <input className="input" placeholder="Offers min" value={bulkOffersMin} onChange={(e) => setBulkOffersMin(e.target.value)} inputMode="numeric" />
                  <input className="input" placeholder="Offers max" value={bulkOffersMax} onChange={(e) => setBulkOffersMax(e.target.value)} inputMode="numeric" />
                </div>
              </div>

              {bulkPreview.isError ? <InlineAlert tone="error">Bulk preview fehlgeschlagen.</InlineAlert> : null}

              {bulkPreview.data ? (
                <div className="card" style={{ boxShadow: "none" }}>
                  <div className="muted" style={{ fontSize: 12 }}>
                    Matched: {bulkPreview.data.matched_count} · Applicable: {bulkPreview.data.applicable_count}
                    {bulkPreview.data.truncated ? " · truncated" : ""}
                  </div>
                  <table className="table" style={{ marginTop: 10 }}>
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th>Cond</th>
                        <th className="numeric">Rank</th>
                        <th className="numeric">Offers</th>
                        <th className="numeric">Before</th>
                        <th className="numeric">After</th>
                        <th className="numeric">Δ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bulkPreview.data.rows.map((r) => (
                        <tr key={r.item_id}>
                          <td>
                            <div className="mono">{r.item_code}</div>
                            <div className="muted" style={{ fontSize: 12 }}>
                              {r.title}
                            </div>
                          </td>
                          <td>{r.condition}</td>
                          <td className="numeric">{r.rank ?? "—"}</td>
                          <td className="numeric">{r.offers_count ?? "—"}</td>
                          <td className="numeric nowrap">
                            {fmtEur(r.before_effective_target_sell_price_cents)}{" "}
                            <span className="muted">· {effectiveSourceLabel(r.before_effective_target_price_source)}</span>
                          </td>
                          <td className="numeric nowrap">
                            {fmtEur(r.after_effective_target_sell_price_cents)}{" "}
                            <span className="muted">· {effectiveSourceLabel(r.after_effective_target_price_source)}</span>
                          </td>
                          <td className="numeric nowrap">{fmtEur(r.delta_cents)}</td>
                        </tr>
                      ))}
                      {!bulkPreview.data.rows.length ? (
                        <tr>
                          <td colSpan={7} className="muted">
                            Keine Ergebnisse.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          </details>
        </div>

        <div className="panel">
          {selectedId ? (
            <div className="only-mobile" style={{ marginBottom: 8 }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  params.delete("selected");
                  setParams(params, { replace: true });
                }}
              >
                ← Zur Liste
              </Button>
            </div>
          ) : null}
          <div className="panel-title">Item Details</div>
          <div className="panel-sub">{selected ? selected.id : "Wähle links ein Item aus."}</div>

          {selected ? (
            <div className="stack" style={{ marginTop: 10 }}>
              <div className="kv">
                <div className="k">Item code</div>
                <div className="v mono">{selected.item_code}</div>
                <div className="k">Status</div>
                <div className="v">
                  <span className={badgeClassForStatus(selected.status)}>{statusLabel(selected.status)}</span>
                </div>
                <div className="k">Created</div>
                <div className="v">{formatDateTimeLocal(selected.created_at)}</div>
                <div className="k">Acquired</div>
                <div className="v">{selected.acquired_date ? formatDateLocal(selected.acquired_date) : "—"}</div>
              </div>

              {selectedMaster ? (
                <div className="card" style={{ boxShadow: "none" }}>
                  <div style={{ fontWeight: 650 }}>Master Product</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {selectedMaster.platform} · {selectedMaster.region}
                    {selectedMaster.variant ? ` · ${selectedMaster.variant}` : ""}
                  </div>
                  <div style={{ marginTop: 8 }}>{selectedMaster.title}</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    ASIN:{" "}
                    {selectedMaster.asin ? (
                      <a className="link" href={`https://www.amazon.de/dp/${String(selectedMaster.asin).trim()}`} target="_blank" rel="noreferrer">
                        {selectedMaster.asin}
                      </a>
                    ) : (
                      "—"
                    )}
                  </div>
                </div>
              ) : null}

              <div className="field">
                <div className="field-label">Lagerplatz</div>
                <input className="input" value={editStorage} onChange={(e) => setEditStorage(e.target.value)} />
              </div>

              <div className="field">
                <div className="field-label">Seriennummer</div>
                <input className="input" value={editSerial} onChange={(e) => setEditSerial(e.target.value)} />
              </div>

              <div className="field">
                <div className="field-label">Target pricing</div>
                <div className="toolbar">
                  <select className="input" value={editTargetMode} onChange={(e) => setEditTargetMode(e.target.value as TargetPriceMode)}>
                    <option value="AUTO">AUTO</option>
                    <option value="MANUAL">MANUAL</option>
                  </select>
                  <input
                    className="input"
                    placeholder="Manual (EUR)"
                    value={editManualEur}
                    onChange={(e) => setEditManualEur(e.target.value)}
                    disabled={editTargetMode !== "MANUAL"}
                    inputMode="decimal"
                  />
                </div>

                <div className="kv" style={{ marginTop: 10 }}>
                  <div className="k">Recommended</div>
                  <div className="v">{fmtEur(selected.recommended_target_sell_price_cents)}</div>
                  <div className="k">Effective</div>
                  <div className="v">
                    {fmtEur(selected.effective_target_sell_price_cents)}{" "}
                    <span className="muted">· {effectiveSourceLabel(selected.effective_target_price_source)}</span>
                  </div>
                  <div className="k">Summary</div>
                  <div className="v muted">{selected.target_price_recommendation?.summary ?? "—"}</div>
                </div>
              </div>

              <div className="toolbar">
                <Button variant="primary" onClick={() => updateItem.mutate()} disabled={updateItem.isPending}>
                  Speichern
                </Button>
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
              </div>

              <div className="field">
                <div className="field-label">Status wechseln</div>
                <div className="toolbar">
                  <select className="input" value={nextStatus} onChange={(e) => setNextStatus(e.target.value as InventoryStatus)}>
                    {STATUS_OPTIONS.filter((o) => o.value !== "ALL").map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <Button variant="secondary" onClick={() => transition.mutate()} disabled={transition.isPending || nextStatus === selected.status}>
                    Anwenden
                  </Button>
                </div>
              </div>

              <div>
                <div className="panel-title">Bilder</div>
                <div className="panel-sub">Uploads sind geschützt; Thumbnails werden via API geladen.</div>

                <div className="toolbar" style={{ marginTop: 8 }}>
                  <label className="btn btn--secondary btn--sm" style={{ gap: 8 }}>
                    <ImagePlus size={16} />
                    Upload…
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        if (!files.length) return;
                        uploadImages.mutate(files);
                        e.currentTarget.value = "";
                      }}
                    />
                  </label>
                </div>

                {images.isError ? <InlineAlert tone="error">Bilder konnten nicht geladen werden.</InlineAlert> : null}

                <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                  {(images.data ?? []).map((img) => (
                    <div key={img.id} style={{ position: "relative" }}>
                      <div
                        style={{
                          width: "100%",
                          aspectRatio: "1 / 1",
                          borderRadius: 10,
                          border: "1px solid var(--border)",
                          background: "var(--surface-2)",
                          overflow: "hidden",
                        }}
                      >
                        {imageUrls[img.id] ? (
                          <img src={imageUrls[img.id]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        ) : null}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Bild löschen"
                        onClick={() => {
                          if (!window.confirm("Bild wirklich löschen?")) return;
                          removeImage.mutate(img.id);
                        }}
                        disabled={removeImage.isPending}
                        style={{ position: "absolute", top: 4, right: 4 }}
                      >
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  ))}
                  {!images.data?.length && !images.isLoading ? (
                    <div className="muted" style={{ fontSize: 13 }}>
                      Keine Bilder.
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
