import { Plus, RefreshCw, Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { formatDateEuFromIso } from "../lib/dates";
import { formatEur } from "../lib/money";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

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

const PURPOSE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "BUYING", label: "Einkauf" },
  { value: "POST", label: "Post" },
  { value: "MATERIAL", label: "Material" },
  { value: "OTHER", label: "Sonstiges" },
];

function optionLabel(options: Array<{ value: string; label: string }>, value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

function purchaseRefLabel(p: PurchaseRefOut): string {
  return `${formatDateEuFromIso(p.purchase_date)} · ${p.counterparty_name} · ${formatEur(p.total_amount_cents)} €`;
}

export function MileagePage() {
  const api = useApi();
  const qc = useQueryClient();
  const formRef = useRef<HTMLDivElement | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [logDate, setLogDate] = useState(new Date().toISOString().slice(0, 10));
  const [start, setStart] = useState("");
  const [destination, setDestination] = useState("");
  const [purpose, setPurpose] = useState("BUYING");
  const [purposeText, setPurposeText] = useState("");
  const [km, setKm] = useState("0");
  const [purchaseIds, setPurchaseIds] = useState<string[]>([]);
  const [purchasePickerOpen, setPurchasePickerOpen] = useState(false);
  const [purchaseQ, setPurchaseQ] = useState("");
  const [search, setSearch] = useState("");

  const purchaseRefs = useQuery({
    queryKey: ["purchase-refs"],
    queryFn: () => api.request<PurchaseRefOut[]>("/purchases/refs"),
  });

  const list = useQuery({
    queryKey: ["mileage"],
    queryFn: () => api.request<MileageOut[]>("/mileage"),
  });

  const create = useMutation({
    mutationFn: () =>
      api.request<MileageOut>("/mileage", {
        method: "POST",
        json: {
          log_date: logDate,
          start_location: start,
          destination,
          purpose: purchaseIds.length ? "BUYING" : purpose,
          km,
          purchase_ids: purchaseIds,
          purpose_text: purchaseIds.length ? null : purposeText.trim() || null,
        },
      }),
    onSuccess: async () => {
      setStart("");
      setDestination("");
      setKm("0");
      setPurchaseIds([]);
      setPurposeText("");
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

  function openForm() {
    create.reset();
    setFormOpen(true);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function closeForm() {
    create.reset();
    setFormOpen(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-xl font-semibold">Fahrtenbuch</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Fahrten erfassen, Einkäufe verknüpfen und den steuerlichen Betrag berechnen.
          </div>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
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
          <Button className="w-full sm:w-auto" onClick={openForm}>
            <Plus className="h-4 w-4" />
            Fahrt erfassen
          </Button>
        </div>
      </div>

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
            <div className="flex flex-1 items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
                <Input
                  placeholder="Suchen (Start, Ziel, Zweck, Einkauf, …)"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              {search.trim() && (
                <Button type="button" variant="ghost" size="icon" onClick={() => setSearch("")} aria-label="Suche löschen">
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          {list.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
              {(list.error as Error).message}
            </div>
          )}

          <div className="md:hidden space-y-2">
            {rows.map((m) => {
              const kmLabel = `${(m.distance_meters / 1000).toFixed(2)} km`;
              const purchaseRefs = (m.purchase_ids ?? [])
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
                            {purchaseRefs
                              .slice(0, 2)
                              .map((p) => `${formatDateEuFromIso(p.purchase_date)} · ${p.counterparty_name}`)
                              .join(", ")}
                            {purchaseRefs.length > 2 ? ` +${purchaseRefs.length - 2}` : ""}
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="whitespace-nowrap">{formatDateEuFromIso(m.log_date)}</TableCell>
                    <TableCell>
                      <div className="font-medium">
                        {m.start_location} → {m.destination}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{(m.distance_meters / 1000).toFixed(2)} km</div>
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
                    <TableCell className="text-right">{formatEur(m.amount_cents)} €</TableCell>
                  </TableRow>
                ))}
                {!rows.length && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-sm text-gray-500 dark:text-gray-400">
                      Keine Daten.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {formOpen && (
        <div ref={formRef}>
          <Card>
            <CardHeader>
              <CardTitle>Erfassen</CardTitle>
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
                                    <TableRow key={p.id}>
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
                <Button className="w-full sm:w-auto" type="button" variant="secondary" onClick={closeForm} disabled={create.isPending}>
                  Schließen
                </Button>
                <Button className="w-full sm:w-auto" onClick={() => create.mutate()} disabled={!start.trim() || !destination.trim() || create.isPending}>
                  Erstellen
                </Button>
              </div>

              {create.isError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                  {(create.error as Error).message}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
