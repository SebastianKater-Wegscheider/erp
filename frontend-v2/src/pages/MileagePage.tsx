import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { latLngBounds } from "leaflet";
import { MapPinned, Pencil, RefreshCw, Save, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap } from "react-leaflet";
import { useSearchParams } from "react-router-dom";

import { useApi } from "../api/api";
import { calculateOsrmRoute, geocodeAddress, type GeoPoint, type RoutePreview } from "../lib/geo";
import { fmtEur } from "../lib/money";
import { paginateItems } from "../lib/pagination";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { InlineAlert } from "../ui/InlineAlert";
import { Modal } from "../ui/Modal";
import { Pagination } from "../ui/Pagination";

type MileagePurpose = "BUYING" | "POST" | "MATERIAL" | "OTHER";

type MileageOut = {
  id: string;
  log_date: string;
  start_location: string;
  destination: string;
  purpose: MileagePurpose;
  purpose_text?: string | null;
  distance_meters: number;
  rate_cents_per_km: number;
  amount_cents: number;
  purchase_ids?: string[];
  created_at: string;
  updated_at: string;
};

type PurchaseRefOut = {
  id: string;
  purchase_date: string;
  counterparty_name: string;
  total_amount_cents: number;
  document_number?: string | null;
};

const PURPOSE_OPTIONS: Array<{ value: MileagePurpose; label: string }> = [
  { value: "BUYING", label: "Einkauf" },
  { value: "POST", label: "Post" },
  { value: "MATERIAL", label: "Material" },
  { value: "OTHER", label: "Sonstiges" },
];

const DEFAULT_MAP_CENTER: GeoPoint = [47.5, 9.74];

function todayIsoLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalizeKm(value: string): string {
  return value.trim().replace(",", ".");
}

function kmFromMetersInput(distanceMeters: number): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) return "";
  return (distanceMeters / 1000).toFixed(2).replace(".", ",");
}

function FitRouteBounds({ points }: { points: GeoPoint[] }) {
  const map = useMap();

  useEffect(() => {
    if (points.length < 2) return;
    map.fitBounds(latLngBounds(points), { padding: [24, 24] });
  }, [map, points]);

  return null;
}

function RouteMap({ route }: { route: RoutePreview }) {
  return (
    <div style={{ overflow: "hidden", borderRadius: 10, border: "1px solid var(--border)" }}>
      <MapContainer center={DEFAULT_MAP_CENTER} zoom={11} scrollWheelZoom={false} style={{ height: 224, width: "100%" }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Polyline positions={route.polyline} pathOptions={{ color: "#0f766e", weight: 5 }} />
        <CircleMarker center={route.start} radius={6} pathOptions={{ color: "#0f766e", fillOpacity: 0.95 }} />
        <CircleMarker center={route.destination} radius={6} pathOptions={{ color: "#1d4ed8", fillOpacity: 0.95 }} />
        <FitRouteBounds points={route.polyline} />
      </MapContainer>
    </div>
  );
}

function purchaseRefLabel(p: PurchaseRefOut): string {
  const doc = p.document_number ? ` · ${p.document_number}` : "";
  return `${p.purchase_date} · ${p.counterparty_name}${doc} · ${fmtEur(p.total_amount_cents)}`;
}

export function MileagePage() {
  const api = useApi();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [message, setMessage] = useState<string | null>(null);

  const selectedId = params.get("selected") ?? "";
  const modeParam = params.get("mode") ?? "";
  const mode: "view" | "edit" = selectedId === "new" ? "edit" : modeParam === "edit" ? "edit" : "view";
  const search = params.get("q") ?? "";
  const page = Number(params.get("page") ?? "1") || 1;

  const purchaseRefs = useQuery({
    queryKey: ["purchase-refs"],
    queryFn: () => api.request<PurchaseRefOut[]>("/purchases/refs"),
  });
  const purchaseRefById = useMemo(() => new Map((purchaseRefs.data ?? []).map((p) => [p.id, p] as const)), [purchaseRefs.data]);

  const list = useQuery({
    queryKey: ["mileage"],
    queryFn: () => api.request<MileageOut[]>("/mileage"),
  });

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const all = list.data ?? [];
    if (!needle) return all;
    return all.filter((m) => {
      const purchasesKey = (m.purchase_ids ?? [])
        .map((id) => purchaseRefById.get(id))
        .filter((p): p is PurchaseRefOut => Boolean(p))
        .map((p) => purchaseRefLabel(p))
        .join(" ");
      const hay = `${m.log_date} ${m.start_location} ${m.destination} ${m.purpose} ${m.purpose_text ?? ""} ${purchasesKey}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [list.data, purchaseRefById, search]);

  const paged = useMemo(() => paginateItems(rows, page, 30), [page, rows]);

  useEffect(() => {
    if (page !== paged.page) {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("page", String(paged.page));
        return next;
      });
    }
  }, [page, paged.page, setParams]);

  const selectedLog: MileageOut | null = useMemo(() => {
    if (!selectedId || selectedId === "new") return null;
    return (list.data ?? []).find((m) => m.id === selectedId) ?? null;
  }, [list.data, selectedId]);

  const [editingLogId, setEditingLogId] = useState<string | null>(null);
  const [logDate, setLogDate] = useState(todayIsoLocal());
  const [start, setStart] = useState("");
  const [destination, setDestination] = useState("");
  const [purpose, setPurpose] = useState<MileagePurpose>("BUYING");
  const [purposeText, setPurposeText] = useState("");
  const [km, setKm] = useState("0");
  const [purchaseIds, setPurchaseIds] = useState<string[]>([]);

  const [roundTrip, setRoundTrip] = useState(false);
  const [routePreview, setRoutePreview] = useState<RoutePreview | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routePending, setRoutePending] = useState(false);

  const [purchasePickerOpen, setPurchasePickerOpen] = useState(false);
  const [purchaseQ, setPurchaseQ] = useState("");

  const kmNormalized = normalizeKm(km);
  const kmValue = kmNormalized ? Number(kmNormalized) : NaN;
  const kmValid = Number.isFinite(kmValue) && kmValue > 0;

  const canSubmit =
    /^\d{4}-\d{2}-\d{2}$/.test(logDate) &&
    start.trim().length > 0 &&
    destination.trim().length > 0 &&
    kmValid;

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        log_date: logDate,
        start_location: start.trim(),
        destination: destination.trim(),
        purpose: purchaseIds.length ? ("BUYING" as const) : purpose,
        km: kmNormalized,
        purchase_ids: purchaseIds,
        purpose_text: purchaseIds.length ? null : purposeText.trim() || null,
      };
      if (editingLogId) return api.request<MileageOut>(`/mileage/${editingLogId}`, { method: "PUT", json: payload });
      return api.request<MileageOut>("/mileage", { method: "POST", json: payload });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["mileage"] });
      setMessage("Fahrt gespeichert.");
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("mode", "view");
        if (selectedId === "new") next.delete("selected");
        return next;
      });
      resetForm();
    },
  });

  useEffect(() => {
    if (!routePreview) return;
    const computedMeters = roundTrip ? routePreview.oneWayMeters * 2 : routePreview.oneWayMeters;
    setKm(kmFromMetersInput(computedMeters));
  }, [routePreview, roundTrip]);

  useEffect(() => {
    setRoutePreview(null);
    setRouteError(null);
  }, [start, destination]);

  useEffect(() => {
    if (mode !== "edit") return;
    if (selectedId === "new") {
      if (!editingLogId) resetForm();
      return;
    }
    if (!selectedLog) return;
    if (editingLogId === selectedLog.id) return;
    openEdit(selectedLog);
  }, [editingLogId, mode, selectedId, selectedLog]);

  function resetForm() {
    setEditingLogId(null);
    setLogDate(todayIsoLocal());
    setStart("");
    setDestination("");
    setPurpose("BUYING");
    setPurposeText("");
    setKm("0");
    setPurchaseIds([]);
    setRoundTrip(false);
    setRoutePreview(null);
    setRouteError(null);
    setRoutePending(false);
    setPurchasePickerOpen(false);
    setPurchaseQ("");
    save.reset();
  }

  function openCreate() {
    resetForm();
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("selected", "new");
      next.set("mode", "edit");
      return next;
    });
  }

  function openEdit(m: MileageOut) {
    save.reset();
    setEditingLogId(m.id);
    setLogDate(m.log_date);
    setStart(m.start_location);
    setDestination(m.destination);
    setPurpose(m.purpose);
    setPurposeText(m.purpose_text ?? "");
    setKm(kmFromMetersInput(m.distance_meters));
    setPurchaseIds(m.purchase_ids ?? []);
    setRoundTrip(false);
    setRoutePreview(null);
    setRouteError(null);
    setRoutePending(false);
    setPurchasePickerOpen(false);
    setPurchaseQ("");
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("selected", m.id);
      next.set("mode", "edit");
      return next;
    });
  }

  function closeEditor() {
    resetForm();
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("mode", "view");
      if (selectedId === "new") next.delete("selected");
      return next;
    });
  }

  function backToList() {
    resetForm();
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("mode", "view");
      next.delete("selected");
      return next;
    });
  }

  async function calculateRoute() {
    if (!start.trim() || !destination.trim()) {
      setRouteError("Bitte Start und Ziel ausfüllen.");
      return;
    }

    setRouteError(null);
    setRoutePending(true);
    try {
      const [startPoint, destinationPoint] = await Promise.all([
        geocodeAddress(start.trim()),
        geocodeAddress(destination.trim()),
      ]);
      const route = await calculateOsrmRoute(startPoint, destinationPoint);
      setRoutePreview(route);
    } catch (error) {
      setRoutePreview(null);
      setRouteError((error as Error)?.message ?? "Route konnte nicht berechnet werden");
    } finally {
      setRoutePending(false);
    }
  }

  const filteredPurchaseRefs = useMemo(() => {
    const q = purchaseQ.trim().toLowerCase();
    const all = purchaseRefs.data ?? [];
    if (!q) return all;
    return all.filter((p) => purchaseRefLabel(p).toLowerCase().includes(q));
  }, [purchaseQ, purchaseRefs.data]);

  const errors = [
    purchaseRefs.isError ? (purchaseRefs.error as Error) : null,
    list.isError ? (list.error as Error) : null,
    save.isError ? (save.error as Error) : null,
  ].filter(Boolean) as Error[];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Fahrtenbuch</div>
          <div className="page-subtitle">Fahrten erfassen, optional Einkäufe verknüpfen, km via Route berechnen.</div>
        </div>
        <div className="page-actions">
          <Button variant="secondary" size="sm" onClick={() => list.refetch()} disabled={list.isFetching}>
            <RefreshCw size={16} /> Aktualisieren
          </Button>
          <Button variant="primary" size="sm" onClick={openCreate}>
            + Neu
          </Button>
        </div>
      </div>

      {message ? (
        <InlineAlert tone="info" onDismiss={() => setMessage(null)}>
          {message}
        </InlineAlert>
      ) : null}

      {errors.length ? <InlineAlert tone="error">{errors[0].message}</InlineAlert> : null}

      <div className="split" style={{ gridTemplateColumns: "1fr 540px" }} data-mobile={selectedId ? "detail" : "list"}>
        <div className="panel">
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <input
              className="input"
              placeholder="Suche (Ort, Zweck, Einkauf, …)"
              value={search}
              onChange={(e) =>
                setParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.set("q", e.target.value);
                  next.set("page", "1");
                  return next;
                })
              }
            />
            <div className="toolbar-spacer" />
            <Pagination
              page={paged.page}
              pageSize={paged.pageSize}
              total={paged.totalItems}
              onPageChange={(p) =>
                setParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.set("page", String(p));
                  return next;
                })
              }
            />
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>Datum</th>
                <th>Route</th>
                <th>Zweck</th>
                <th className="numeric">Betrag</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((m) => (
                <tr key={m.id} style={{ cursor: "pointer", background: m.id === selectedId ? "var(--surface-2)" : undefined }} onClick={() => openEdit(m)}>
                  <td className="mono nowrap">{m.log_date}</td>
                  <td>
                    <div style={{ fontWeight: 650 }}>{m.start_location}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      → {m.destination}
                    </div>
                  </td>
                  <td>
                    <div className="mono">{m.purpose}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {m.purchase_ids?.length ? `${m.purchase_ids.length} Einkauf/Einkäufe` : m.purpose_text ?? "—"}
                    </div>
                  </td>
                  <td className="numeric mono">{fmtEur(m.amount_cents)}</td>
                </tr>
              ))}
              {!paged.items.length ? (
                <tr>
                  <td colSpan={4} className="muted">
                    Keine Daten.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="panel">
          {selectedId ? (
            <div className="only-mobile" style={{ marginBottom: 8 }}>
              <Button variant="secondary" size="sm" onClick={backToList}>
                ← Zur Liste
              </Button>
            </div>
          ) : null}
          {mode === "edit" ? (
            <div className="stack">
              <div className="toolbar" style={{ justifyContent: "space-between" }}>
                <div>
                  <div className="panel-title">{editingLogId ? "Bearbeiten" : "Neu"}</div>
                  <div className="panel-sub">{editingLogId ? <span className="mono">{editingLogId}</span> : "—"}</div>
                </div>
                <div className="toolbar">
                  <Button variant="secondary" size="sm" onClick={closeEditor}>
                    <Undo2 size={16} /> Schließen
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => save.mutate()} disabled={!canSubmit || save.isPending}>
                    <Save size={16} /> {save.isPending ? "Speichere…" : "Speichern"}
                  </Button>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Field label="Datum">
                  <input className="input" type="date" value={logDate} onChange={(e) => setLogDate(e.target.value)} />
                </Field>
                <Field label="km">
                  <input className="input" value={km} onChange={(e) => setKm(e.target.value)} placeholder="z.B. 12,40" />
                </Field>
              </div>

              <Field label="Start">
                <input className="input" value={start} onChange={(e) => setStart(e.target.value)} placeholder="Adresse / Ort" />
              </Field>
              <Field label="Ziel">
                <input className="input" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="Adresse / Ort" />
              </Field>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Field label="Zweck">
                  <select className="input" value={purchaseIds.length ? "BUYING" : purpose} onChange={(e) => setPurpose(e.target.value as MileagePurpose)} disabled={purchaseIds.length > 0}>
                    {PURPOSE_OPTIONS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Einkäufe (optional)">
                  <Button type="button" variant="secondary" size="sm" onClick={() => setPurchasePickerOpen(true)} disabled={purchaseRefs.isFetching}>
                    <Pencil size={16} /> {purchaseIds.length ? `${purchaseIds.length} ausgewählt` : "Auswählen"}
                  </Button>
                </Field>
              </div>

              {purchaseIds.length ? (
                <div className="panel" style={{ padding: 12 }}>
                  <div className="panel-title" style={{ fontSize: 13 }}>
                    Verknüpfte Einkäufe
                  </div>
                  <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                    {purchaseIds.map((id) => (
                      <li key={id} className="muted" style={{ fontSize: 12 }}>
                        {purchaseRefById.get(id) ? purchaseRefLabel(purchaseRefById.get(id)!) : id}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <Field label="Zweck Text (optional)">
                  <input className="input" value={purposeText} onChange={(e) => setPurposeText(e.target.value)} placeholder="z.B. Post, Material, …" />
                </Field>
              )}

              <div className="toolbar">
                <Button type="button" size="sm" variant="secondary" onClick={calculateRoute} disabled={routePending}>
                  <MapPinned size={16} /> {routePending ? "Berechne…" : "Route berechnen"}
                </Button>
                <label className="checkbox" style={{ color: "var(--text)" }}>
                  <input type="checkbox" checked={roundTrip} onChange={(e) => setRoundTrip(e.target.checked)} /> Hin & zurück
                </label>
                <div className="toolbar-spacer" />
                {routeError ? <span style={{ color: "var(--danger)", fontSize: 12 }}>{routeError}</span> : null}
              </div>

              {routePreview ? <RouteMap route={routePreview} /> : null}
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 13 }}>
              Fahrt auswählen oder „Neu“ starten.
            </div>
          )}
        </div>
      </div>

      <Modal open={purchasePickerOpen} title="Einkäufe verknüpfen" description="Mehrere Einkäufe möglich." onClose={() => setPurchasePickerOpen(false)}>
        <div className="stack">
          <input className="input" placeholder="Suche…" value={purchaseQ} onChange={(e) => setPurchaseQ(e.target.value)} />
          <div className="panel" style={{ padding: 0, maxHeight: 360, overflow: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th></th>
                  <th>Purchase</th>
                  <th className="numeric">Betrag</th>
                </tr>
              </thead>
              <tbody>
                {filteredPurchaseRefs.map((p) => {
                  const checked = purchaseIds.includes(p.id);
                  return (
                    <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => setPurchaseIds((s) => (checked ? s.filter((id) => id !== p.id) : [...s, p.id]))}>
                      <td className="nowrap">
                        <input type="checkbox" checked={checked} onChange={() => {}} />
                      </td>
                      <td style={{ fontSize: 12 }}>{purchaseRefLabel(p)}</td>
                      <td className="numeric mono">{fmtEur(p.total_amount_cents)}</td>
                    </tr>
                  );
                })}
                {!filteredPurchaseRefs.length ? (
                  <tr>
                    <td colSpan={3} className="muted">
                      Keine Treffer.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="toolbar" style={{ justifyContent: "space-between" }}>
            <Button type="button" size="sm" variant="ghost" onClick={() => setPurchaseIds([])} disabled={!purchaseIds.length}>
              Reset
            </Button>
            <Button type="button" size="sm" variant="primary" onClick={() => setPurchasePickerOpen(false)}>
              Übernehmen
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
