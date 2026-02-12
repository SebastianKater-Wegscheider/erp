import { Pencil, Plus, RefreshCw, Route, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { latLngBounds } from "leaflet";
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap } from "react-leaflet";

import { useApi } from "../lib/api";
import { formatDateEuFromIso } from "../lib/dates";
import { formatEur } from "../lib/money";
import { paginateItems } from "../lib/pagination";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { InlineMessage } from "../components/ui/inline-message";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PaginationControls } from "../components/ui/pagination-controls";
import { PageHeader } from "../components/ui/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { SearchField } from "../components/ui/search-field";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { TABLE_CELL_NUMERIC_CLASS, TABLE_ROW_COMPACT_CLASS } from "../components/ui/table-row-layout";

type MileageOut = {
  id: string;
  log_date: string;
  start_location: string;
  destination: string;
  purpose: string;
  purpose_text?: string | null;
  distance_meters: number;
  rate_cents_per_km: number;
  amount_cents: number;
  purchase_ids?: string[];
};

type PurchaseRefOut = {
  id: string;
  purchase_date: string;
  counterparty_name: string;
  total_amount_cents: number;
  document_number?: string | null;
};

type GeoPoint = [number, number];

type RoutePreview = {
  start: GeoPoint;
  destination: GeoPoint;
  polyline: GeoPoint[];
  oneWayMeters: number;
};

type NominatimResult = {
  lat: string;
  lon: string;
};

type OsrmRouteResponse = {
  code?: string;
  routes?: Array<{
    distance?: number;
    geometry?: {
      coordinates?: Array<[number, number]>;
    };
  }>;
};

const PURPOSE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "BUYING", label: "Einkauf" },
  { value: "POST", label: "Post" },
  { value: "MATERIAL", label: "Material" },
  { value: "OTHER", label: "Sonstiges" },
];

const DEFAULT_MAP_CENTER: GeoPoint = [47.5, 9.74];

function optionLabel(options: Array<{ value: string; label: string }>, value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

function purchaseRefLabel(p: PurchaseRefOut): string {
  return `${formatDateEuFromIso(p.purchase_date)} · ${p.counterparty_name} · ${formatEur(p.total_amount_cents)} €`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function kmFromMeters(meters: number): string {
  const km = Math.max(0, meters) / 1000;
  return km.toFixed(2).replace(".", ",");
}

function normalizeKm(value: string): string {
  return value.trim().replace(",", ".");
}

function kmLabelFromMeters(meters: number): string {
  return `${(meters / 1000).toFixed(2)} km`;
}

async function geocodeAddress(query: string): Promise<GeoPoint> {
  const endpoint = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/json",
      "Accept-Language": "de",
    },
  });
  if (!response.ok) {
    throw new Error(`Geocoding fehlgeschlagen (${response.status})`);
  }
  const rows = (await response.json()) as NominatimResult[];
  const first = rows[0];
  if (!first) {
    throw new Error(`Adresse nicht gefunden: ${query}`);
  }

  const lat = Number(first.lat);
  const lon = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`Ungültige Koordinaten für: ${query}`);
  }
  return [lat, lon];
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
    <div className="overflow-hidden rounded-md border border-gray-200 dark:border-gray-800">
      <MapContainer center={DEFAULT_MAP_CENTER} zoom={11} scrollWheelZoom={false} className="h-56 w-full">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Polyline positions={route.polyline} pathOptions={{ color: "#0e766e", weight: 5 }} />
        <CircleMarker center={route.start} radius={6} pathOptions={{ color: "#0e766e", fillOpacity: 0.95 }} />
        <CircleMarker center={route.destination} radius={6} pathOptions={{ color: "#1d4ed8", fillOpacity: 0.95 }} />
        <FitRouteBounds points={route.polyline} />
      </MapContainer>
    </div>
  );
}

export function MileagePage() {
  const api = useApi();
  const qc = useQueryClient();
  const formRef = useRef<HTMLDivElement | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editingLogId, setEditingLogId] = useState<string | null>(null);

  const [logDate, setLogDate] = useState(todayIso());
  const [start, setStart] = useState("");
  const [destination, setDestination] = useState("");
  const [purpose, setPurpose] = useState("BUYING");
  const [purposeText, setPurposeText] = useState("");
  const [km, setKm] = useState("0");
  const [purchaseIds, setPurchaseIds] = useState<string[]>([]);

  const [roundTrip, setRoundTrip] = useState(false);
  const [routePreview, setRoutePreview] = useState<RoutePreview | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routePending, setRoutePending] = useState(false);

  const [purchasePickerOpen, setPurchasePickerOpen] = useState(false);
  const [purchaseQ, setPurchaseQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const purchaseRefs = useQuery({
    queryKey: ["purchase-refs"],
    queryFn: () => api.request<PurchaseRefOut[]>("/purchases/refs"),
  });

  const list = useQuery({
    queryKey: ["mileage"],
    queryFn: () => api.request<MileageOut[]>("/mileage"),
  });

  const kmNormalized = normalizeKm(km);
  const kmValue = kmNormalized ? Number(kmNormalized) : NaN;
  const kmIsValid = Number.isFinite(kmValue) && kmValue > 0;

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        log_date: logDate,
        start_location: start,
        destination,
        purpose: purchaseIds.length ? "BUYING" : purpose,
        km: kmNormalized,
        purchase_ids: purchaseIds,
        purpose_text: purchaseIds.length ? null : purposeText.trim() || null,
      };

      if (editingLogId) {
        return api.request<MileageOut>(`/mileage/${editingLogId}`, { method: "PUT", json: payload });
      }
      return api.request<MileageOut>("/mileage", { method: "POST", json: payload });
    },
    onSuccess: async () => {
      resetForm();
      setFormOpen(false);
      await qc.invalidateQueries({ queryKey: ["mileage"] });
    },
  });

  const purchaseRefById = new Map((purchaseRefs.data ?? []).map((p) => [p.id, p] as const));

  const filteredPurchaseRefs = (purchaseRefs.data ?? []).filter((p) => {
    const q = purchaseQ.trim().toLowerCase();
    if (!q) return true;
    const key = `${p.purchase_date} ${p.counterparty_name} ${p.document_number ?? ""} ${formatEur(p.total_amount_cents)}`.toLowerCase();
    return key.includes(q);
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = list.data ?? [];
    if (!q) return all;
    return all.filter((m) => {
      const purchasesKey = (m.purchase_ids ?? [])
        .map((id) => purchaseRefById.get(id))
        .filter((p): p is PurchaseRefOut => !!p)
        .map((p) => `${p.purchase_date} ${p.counterparty_name} ${p.document_number ?? ""} ${formatEur(p.total_amount_cents)}`)
        .join(" ");
      const key = `${m.log_date} ${m.start_location} ${m.destination} ${m.purpose} ${m.purpose_text ?? ""} ${purchasesKey}`.toLowerCase();
      return key.includes(q);
    });
  }, [list.data, purchaseRefById, search]);

  const totalCount = list.data?.length ?? 0;
  const pagedRows = useMemo(() => paginateItems(rows, page), [rows, page]);

  useEffect(() => {
    if (!routePreview) return;
    const computedMeters = roundTrip ? routePreview.oneWayMeters * 2 : routePreview.oneWayMeters;
    setKm(kmFromMeters(computedMeters));
  }, [routePreview, roundTrip]);

  useEffect(() => {
    setRoutePreview(null);
    setRouteError(null);
  }, [start, destination]);

  useEffect(() => {
    setPage(1);
  }, [search]);

  useEffect(() => {
    if (page !== pagedRows.page) setPage(pagedRows.page);
  }, [page, pagedRows.page]);

  function resetForm() {
    setEditingLogId(null);
    setLogDate(todayIso());
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

  function openCreateForm() {
    resetForm();
    setFormOpen(true);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function openEditForm(m: MileageOut) {
    save.reset();
    setEditingLogId(m.id);
    setLogDate(m.log_date);
    setStart(m.start_location);
    setDestination(m.destination);
    setPurpose(m.purpose);
    setPurposeText(m.purpose_text ?? "");
    setKm(kmFromMeters(m.distance_meters));
    setPurchaseIds(m.purchase_ids ?? []);
    setRoundTrip(false);
    setRoutePreview(null);
    setRouteError(null);
    setRoutePending(false);
    setPurchasePickerOpen(false);
    setPurchaseQ("");
    setFormOpen(true);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function closeForm() {
    resetForm();
    setFormOpen(false);
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

      const endpoint = `https://router.project-osrm.org/route/v1/driving/${startPoint[1]},${startPoint[0]};${destinationPoint[1]},${destinationPoint[0]}?overview=full&geometries=geojson`;
      const response = await fetch(endpoint, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Routenberechnung fehlgeschlagen (${response.status})`);
      }

      const data = (await response.json()) as OsrmRouteResponse;
      const route = data.routes?.[0];
      const oneWayMeters = Math.round(Number(route?.distance ?? 0));
      const coords = route?.geometry?.coordinates ?? [];
      const polyline = coords.map(([lon, lat]) => [lat, lon] as GeoPoint);

      if (!oneWayMeters || polyline.length < 2) {
        throw new Error("Keine Route gefunden. Bitte Eingabe prüfen.");
      }

      setRoutePreview({
        start: startPoint,
        destination: destinationPoint,
        polyline,
        oneWayMeters,
      });

      const distanceMeters = roundTrip ? oneWayMeters * 2 : oneWayMeters;
      setKm(kmFromMeters(distanceMeters));
    } catch (error) {
      setRoutePreview(null);
      setRouteError((error as Error)?.message ?? "Route konnte nicht berechnet werden");
    } finally {
      setRoutePending(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Fahrtenbuch"
        description="Fahrten erfassen, bearbeiten, Einkäufe verknüpfen und den steuerlichen Betrag berechnen."
        actions={
          <>
            <Button
              className="w-full sm:w-auto"
              variant="secondary"
              onClick={() => {
                void list.refetch();
                void purchaseRefs.refetch();
              }}
              disabled={list.isFetching || purchaseRefs.isFetching}
            >
              <RefreshCw className="h-4 w-4" />
              Aktualisieren
            </Button>
            <Button className="w-full sm:w-auto" onClick={openCreateForm}>
              <Plus className="h-4 w-4" />
              Fahrt erfassen
            </Button>
          </>
        }
        actionsClassName="w-full sm:w-auto"
      />

      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-col gap-1">
            <CardTitle>Historie</CardTitle>
            <CardDescription>
              {list.isPending ? "Lade…" : `${rows.length}${rows.length !== totalCount ? ` / ${totalCount}` : ""} Einträge`}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <SearchField
              className="flex-1"
              value={search}
              onValueChange={setSearch}
              placeholder="Suchen (Start, Ziel, Zweck, Einkauf, …)"
            />
          </div>

          {list.isError && (
            <InlineMessage tone="error">
              {(list.error as Error).message}
            </InlineMessage>
          )}

          <div className="md:hidden space-y-2">
            {pagedRows.items.map((m) => {
              const kmLabel = kmLabelFromMeters(m.distance_meters);
              const linkedPurchases = (m.purchase_ids ?? [])
                .map((id) => purchaseRefById.get(id))
                .filter((p): p is PurchaseRefOut => !!p);
              return (
                <div
                  key={m.id}
                  className="rounded-md border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs text-gray-500 dark:text-gray-400">{formatDateEuFromIso(m.log_date)}</div>
                      <div className="mt-1 truncate font-medium text-gray-900 dark:text-gray-100">
                        {m.start_location} → {m.destination}
                      </div>
                      <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{kmLabel}</div>

                      {m.purchase_ids?.length ? (
                        <div className="mt-2 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">
                              {m.purchase_ids.length} Einkauf{m.purchase_ids.length === 1 ? "" : "e"}
                            </Badge>
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {linkedPurchases
                              .slice(0, 2)
                              .map((p) => `${formatDateEuFromIso(p.purchase_date)} · ${p.counterparty_name}`)
                              .join(", ")}
                            {linkedPurchases.length > 2 ? ` +${linkedPurchases.length - 2}` : ""}
                          </div>
                        </div>
                      ) : (
                        <div className="mt-2 text-sm text-gray-700 dark:text-gray-200">
                          {m.purpose_text?.trim() || optionLabel(PURPOSE_OPTIONS, m.purpose)}
                        </div>
                      )}
                    </div>

                    <div className="shrink-0 text-right text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {formatEur(m.amount_cents)} €
                    </div>
                  </div>

                  <div className="mt-3">
                    <Button type="button" className="w-full" variant="secondary" onClick={() => openEditForm(m)}>
                      <Pencil className="h-4 w-4" />
                      Bearbeiten
                    </Button>
                  </div>
                </div>
              );
            })}
            {!rows.length && (
              <div className="rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
                Keine Daten.
              </div>
            )}
          </div>

          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Datum</TableHead>
                  <TableHead>Strecke</TableHead>
                  <TableHead>Zweck</TableHead>
                  <TableHead className="text-right">Betrag</TableHead>
                  <TableHead className="text-right">Aktion</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedRows.items.map((m) => (
                  <TableRow key={m.id} className={TABLE_ROW_COMPACT_CLASS}>
                    <TableCell className="whitespace-nowrap">{formatDateEuFromIso(m.log_date)}</TableCell>
                    <TableCell>
                      <div className="font-medium">
                        {m.start_location} → {m.destination}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{kmLabelFromMeters(m.distance_meters)}</div>
                    </TableCell>
                    <TableCell>
                      {m.purchase_ids?.length ? (
                        <>
                          <div className="font-medium">
                            {m.purchase_ids.length} Einkauf{m.purchase_ids.length === 1 ? "" : "e"}
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {m.purchase_ids
                              .map((id) => purchaseRefById.get(id))
                              .filter((p): p is PurchaseRefOut => !!p)
                              .slice(0, 2)
                              .map((p) => `${formatDateEuFromIso(p.purchase_date)} · ${p.counterparty_name}`)
                              .join(", ")}
                            {m.purchase_ids.length > 2 ? ` +${m.purchase_ids.length - 2}` : ""}
                          </div>
                        </>
                      ) : (
                        m.purpose_text?.trim() || optionLabel(PURPOSE_OPTIONS, m.purpose)
                      )}
                    </TableCell>
                    <TableCell className={TABLE_CELL_NUMERIC_CLASS}>{formatEur(m.amount_cents)} €</TableCell>
                    <TableCell className="text-right">
                      <Button type="button" size="sm" variant="secondary" onClick={() => openEditForm(m)}>
                        <Pencil className="h-4 w-4" />
                        Bearbeiten
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {!rows.length && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-sm text-gray-500 dark:text-gray-400">
                      Keine Daten.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <PaginationControls
            page={pagedRows.page}
            totalPages={pagedRows.totalPages}
            totalItems={pagedRows.totalItems}
            pageSize={pagedRows.pageSize}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>

      {formOpen && (
        <div ref={formRef}>
          <Card>
            <CardHeader>
              <CardTitle>{editingLogId ? "Fahrt bearbeiten" : "Fahrt erfassen"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-4">
                <div className="space-y-2">
                  <Label>Datum</Label>
                  <Input type="date" value={logDate} onChange={(e) => setLogDate(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Start</Label>
                  <Input value={start} onChange={(e) => setStart(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Ziel</Label>
                  <Input value={destination} onChange={(e) => setDestination(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>km</Label>
                  <Input value={km} onChange={(e) => setKm(e.target.value)} placeholder="z. B. 12.3" />
                </div>

                <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800 md:col-span-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                    <div className="space-y-2">
                      <Label>Routenberechnung (OpenStreetMap)</Label>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        Distanz wird aus der Route berechnet und in das km-Feld übernommen.
                      </div>
                    </div>

                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <div
                        role="radiogroup"
                        aria-label="Routenmodus"
                        className="grid w-full grid-cols-2 gap-2 sm:w-[16rem]"
                      >
                        <Button
                          type="button"
                          variant={roundTrip ? "outline" : "secondary"}
                          size="sm"
                          aria-pressed={!roundTrip}
                          onClick={() => setRoundTrip(false)}
                        >
                          Einfach
                        </Button>
                        <Button
                          type="button"
                          variant={roundTrip ? "secondary" : "outline"}
                          size="sm"
                          aria-pressed={roundTrip}
                          onClick={() => setRoundTrip(true)}
                        >
                          Hin- und Rückfahrt
                        </Button>
                      </div>

                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => {
                          void calculateRoute();
                        }}
                        disabled={routePending || !start.trim() || !destination.trim()}
                      >
                        <Route className="h-4 w-4" />
                        Route berechnen
                      </Button>
                    </div>
                  </div>

                  {routePreview && (
                    <div className="mt-3 text-xs text-gray-600 dark:text-gray-300">
                      Berechnet: {kmLabelFromMeters(routePreview.oneWayMeters)}
                      {roundTrip ? ` (gesamt ${kmLabelFromMeters(routePreview.oneWayMeters * 2)})` : ""}
                    </div>
                  )}

                  {routeError && (
                    <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
                      {routeError}
                    </div>
                  )}

                  {routePreview && (
                    <div className="mt-3">
                      <RouteMap route={routePreview} />
                    </div>
                  )}
                </div>

                <div className="space-y-2 md:col-span-4">
                  <Label>Einkäufe (optional)</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    {purchaseIds.map((id) => {
                      const p = purchaseRefById.get(id);
                      return (
                        <Badge key={id} variant="outline" className="gap-2">
                          {p ? purchaseRefLabel(p) : id}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5"
                            onClick={() => setPurchaseIds((prev) => prev.filter((x) => x !== id))}
                            aria-label="Einkauf entfernen"
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </Badge>
                      );
                    })}

                    <Dialog open={purchasePickerOpen} onOpenChange={setPurchasePickerOpen}>
                      <DialogTrigger asChild>
                        <Button type="button" variant="secondary" disabled={purchaseRefs.isLoading}>
                          Einkauf auswählen
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="max-w-2xl">
                        <DialogHeader>
                          <DialogTitle>Einkäufe verknüpfen</DialogTitle>
                          <DialogDescription>Wählen Sie einen oder mehrere Einkäufe aus.</DialogDescription>
                        </DialogHeader>

                        {purchaseRefs.isError && (
                          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                            {(purchaseRefs.error as Error).message}
                          </div>
                        )}

                        <div className="space-y-2">
                          <Label>Suche</Label>
                          <Input value={purchaseQ} onChange={(e) => setPurchaseQ(e.target.value)} placeholder="Name, Datum, Betrag, Belegnummer ..." />
                        </div>

                        <div className="max-h-[55vh] overflow-auto rounded-md border border-gray-200 dark:border-gray-800">
                          <div className="sm:hidden space-y-2 p-2">
                            {filteredPurchaseRefs.map((p) => {
                              const selected = purchaseIds.includes(p.id);
                              return (
                                <div
                                  key={p.id}
                                  className="rounded-md border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900"
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="text-xs text-gray-500 dark:text-gray-400">{formatDateEuFromIso(p.purchase_date)}</div>
                                      <div className="mt-1 truncate font-medium text-gray-900 dark:text-gray-100">{p.counterparty_name}</div>
                                      {p.document_number ? (
                                        <div className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">Beleg: {p.document_number}</div>
                                      ) : null}
                                    </div>
                                    <div className="shrink-0 text-right text-sm font-semibold text-gray-900 dark:text-gray-100">
                                      {formatEur(p.total_amount_cents)} €
                                    </div>
                                  </div>

                                  <div className="mt-3">
                                    {selected ? (
                                      <Button
                                        type="button"
                                        className="w-full"
                                        variant="outline"
                                        onClick={() => setPurchaseIds((prev) => prev.filter((id) => id !== p.id))}
                                      >
                                        Entfernen
                                      </Button>
                                    ) : (
                                      <Button type="button" className="w-full" onClick={() => setPurchaseIds((prev) => [...prev, p.id])}>
                                        Hinzufügen
                                      </Button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                            {!filteredPurchaseRefs.length && (
                              <div className="rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
                                Keine Treffer.
                              </div>
                            )}
                          </div>

                          <div className="hidden sm:block">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Datum</TableHead>
                                  <TableHead>Gegenpartei</TableHead>
                                  <TableHead>Beleg</TableHead>
                                  <TableHead className="text-right">Betrag</TableHead>
                                  <TableHead />
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {filteredPurchaseRefs.map((p) => {
                                  const selected = purchaseIds.includes(p.id);
                                  return (
                                    <TableRow key={p.id} className={TABLE_ROW_COMPACT_CLASS}>
                                      <TableCell className="whitespace-nowrap">{formatDateEuFromIso(p.purchase_date)}</TableCell>
                                      <TableCell className="font-medium">{p.counterparty_name}</TableCell>
                                      <TableCell>{p.document_number ?? ""}</TableCell>
                                      <TableCell className="text-right">{formatEur(p.total_amount_cents)} €</TableCell>
                                      <TableCell className="text-right">
                                        {selected ? (
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={() => setPurchaseIds((prev) => prev.filter((id) => id !== p.id))}
                                          >
                                            Entfernen
                                          </Button>
                                        ) : (
                                          <Button type="button" size="sm" onClick={() => setPurchaseIds((prev) => [...prev, p.id])}>
                                            Hinzufügen
                                          </Button>
                                        )}
                                      </TableCell>
                                    </TableRow>
                                  );
                                })}
                                {!filteredPurchaseRefs.length && (
                                  <TableRow>
                                    <TableCell colSpan={5} className="text-sm text-gray-500 dark:text-gray-400">
                                      Keine Treffer.
                                    </TableCell>
                                  </TableRow>
                                )}
                              </TableBody>
                            </Table>
                          </div>
                        </div>
                      </DialogContent>
                    </Dialog>

                    {!purchaseIds.length && <div className="text-sm text-gray-500 dark:text-gray-400">Keine Einkäufe verknüpft.</div>}
                  </div>
                </div>

                {!purchaseIds.length && (
                  <>
                    <div className="space-y-2">
                      <Label>Kategorie</Label>
                      <Select value={purpose} onValueChange={setPurpose}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PURPOSE_OPTIONS.map((p) => (
                            <SelectItem key={p.value} value={p.value}>
                              {p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2 md:col-span-3">
                      <Label>Zweck (optional)</Label>
                      <Input value={purposeText} onChange={(e) => setPurposeText(e.target.value)} placeholder="z. B. Pakete wegbringen" />
                    </div>
                  </>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-between">
                <Button className="w-full sm:w-auto" type="button" variant="secondary" onClick={closeForm} disabled={save.isPending}>
                  Schließen
                </Button>
                <Button
                  className="w-full sm:w-auto"
                  onClick={() => save.mutate()}
                  disabled={!start.trim() || !destination.trim() || !kmIsValid || save.isPending}
                >
                  {editingLogId ? "Änderungen speichern" : "Erstellen"}
                </Button>
              </div>

              {save.isError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                  {(save.error as Error).message}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
