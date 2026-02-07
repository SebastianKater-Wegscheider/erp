import { MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

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
};

type MasterProductFormState = {
  kind: MasterProductKind;
  title: string;
  manufacturer: string;
  model: string;
  platform: string;
  region: string;
  variant: string;
  ean: string;
  asin: string;
  genre: string;
  release_year: string;
  reference_image_url: string;
};

const KIND_OPTIONS: Array<{ value: MasterProductKind; label: string }> = [
  { value: "GAME", label: "Spiel" },
  { value: "CONSOLE", label: "Konsole" },
  { value: "ACCESSORY", label: "Zubehör" },
  { value: "OTHER", label: "Sonstiges" },
];

const EMPTY_FORM: MasterProductFormState = {
  kind: "GAME",
  title: "",
  manufacturer: "",
  model: "",
  platform: "",
  region: "EU",
  variant: "",
  ean: "",
  asin: "",
  genre: "",
  release_year: "",
  reference_image_url: "",
};

function kindLabel(kind: MasterProductKind): string {
  return KIND_OPTIONS.find((k) => k.value === kind)?.label ?? kind;
}

function opt(value: string): string | null {
  const v = value.trim();
  return v ? v : null;
}

function releaseYearOrNull(value: string): number | null {
  const v = value.trim();
  if (!v) return null;
  const n = Number(v);
  if (!Number.isInteger(n)) return NaN;
  return n;
}

export function MasterProductsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<MasterProductKind | "ALL">("ALL");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"create" | "edit">("create");
  const [activeProduct, setActiveProduct] = useState<MasterProduct | null>(null);
  const [form, setForm] = useState<MasterProductFormState>({ ...EMPTY_FORM });
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<MasterProduct | null>(null);

  const list = useQuery({
    queryKey: ["master-products"],
    queryFn: () => api.request<MasterProduct[]>("/master-products"),
  });

  const releaseYear = releaseYearOrNull(form.release_year);
  const releaseYearValid = releaseYear === null || (Number.isInteger(releaseYear) && releaseYear >= 1970 && releaseYear <= 2100);
  const requiredValid = !!form.title.trim() && !!form.platform.trim() && !!form.region.trim();

  const create = useMutation({
    mutationFn: () =>
      api.request<MasterProduct>("/master-products", {
        method: "POST",
        json: {
          kind: form.kind,
          title: form.title.trim(),
          manufacturer: opt(form.manufacturer),
          model: opt(form.model),
          platform: form.platform.trim(),
          region: form.region.trim(),
          variant: form.variant.trim(),
          ean: opt(form.ean),
          asin: opt(form.asin),
          genre: opt(form.genre),
          release_year: releaseYearValid ? releaseYear : null,
          reference_image_url: opt(form.reference_image_url),
        },
      }),
    onSuccess: async () => {
      setEditorOpen(false);
      setForm({ ...EMPTY_FORM });
      setShowAdvanced(false);
      await qc.invalidateQueries({ queryKey: ["master-products"] });
    },
  });

  const update = useMutation({
    mutationFn: () => {
      if (!activeProduct) throw new Error("Kein Produkt ausgewählt");
      const ry = releaseYearOrNull(form.release_year);
      const ryValid = ry === null || (Number.isInteger(ry) && ry >= 1970 && ry <= 2100);
      if (!ryValid) throw new Error("Release-Jahr muss zwischen 1970 und 2100 liegen");
      return api.request<MasterProduct>(`/master-products/${activeProduct.id}`, {
        method: "PATCH",
        json: {
          kind: form.kind,
          title: form.title.trim(),
          manufacturer: opt(form.manufacturer),
          model: opt(form.model),
          platform: form.platform.trim(),
          region: form.region.trim(),
          variant: form.variant.trim(),
          ean: opt(form.ean),
          asin: opt(form.asin),
          genre: opt(form.genre),
          release_year: ry,
          reference_image_url: opt(form.reference_image_url),
        },
      });
    },
    onSuccess: async () => {
      setEditorOpen(false);
      setActiveProduct(null);
      await qc.invalidateQueries({ queryKey: ["master-products"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.request<void>(`/master-products/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setConfirmDelete(null);
      await qc.invalidateQueries({ queryKey: ["master-products"] });
    },
  });

  function openCreate() {
    create.reset();
    update.reset();
    setEditorMode("create");
    setActiveProduct(null);
    setForm({ ...EMPTY_FORM });
    setShowAdvanced(false);
    setEditorOpen(true);
  }

  function openEdit(m: MasterProduct) {
    create.reset();
    update.reset();
    setEditorMode("edit");
    setActiveProduct(m);
    const next = formFromProduct(m);
    setForm(next);
    setShowAdvanced(hasAdvancedValues(next));
    setEditorOpen(true);
  }

  function requestDelete(m: MasterProduct) {
    setEditorOpen(false);
    setConfirmDelete(m);
    remove.reset();
  }

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let all = list.data ?? [];
    if (kindFilter !== "ALL") all = all.filter((m) => m.kind === kindFilter);
    if (!q) return all;
    return all.filter((m) =>
      `${m.kind} ${m.sku} ${m.title} ${m.manufacturer ?? ""} ${m.model ?? ""} ${m.platform} ${m.region} ${m.variant} ${m.ean ?? ""} ${m.asin ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [kindFilter, list.data, search]);

  const totalCount = list.data?.length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-xl font-semibold">Produktstamm</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Masterdaten (SKU) für Produkte. Hier anlegen, pflegen und bei Bedarf löschen.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => list.refetch()} disabled={list.isFetching}>
            <RefreshCw className="h-4 w-4" />
            Aktualisieren
          </Button>
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" />
            Produkt anlegen
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-col gap-1">
            <CardTitle>Produkte</CardTitle>
            <CardDescription>
              {list.isPending ? "Lade…" : `${rows.length}${rows.length !== totalCount ? ` / ${totalCount}` : ""} Produkte`}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-1 items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
                <Input
                  placeholder="Suchen (SKU, Titel, EAN, ASIN, …)"
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

            <div className="flex items-center gap-2">
              <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as MasterProductKind | "ALL")}>
                <SelectTrigger className="w-[190px]">
                  <SelectValue placeholder="Typ" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Alle Typen</SelectItem>
                  {KIND_OPTIONS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {list.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
              {(list.error as Error).message}
            </div>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produkt</TableHead>
                <TableHead>IDs</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Aktionen</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.isPending &&
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={`skel-${i}`} className="animate-pulse">
                    <TableCell>
                      <div className="space-y-2">
                        <div className="h-4 w-64 rounded bg-gray-200 dark:bg-gray-800" />
                        <div className="h-3 w-48 rounded bg-gray-100 dark:bg-gray-800" />
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-2">
                        <div className="h-3 w-40 rounded bg-gray-100 dark:bg-gray-800" />
                        <div className="h-3 w-32 rounded bg-gray-100 dark:bg-gray-800" />
                      </div>
                    </TableCell>
                    <TableCell />
                  </TableRow>
                ))}

              {!list.isPending &&
                rows.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="min-w-0 truncate font-medium">{m.title}</div>
                          <Badge variant="secondary">{kindLabel(m.kind)}</Badge>
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {m.platform} · {m.region}
                          {m.variant ? ` · ${m.variant}` : ""}
                        </div>
                        {(m.manufacturer || m.model) && (
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {m.manufacturer ?? ""}
                            {m.manufacturer && m.model ? " · " : ""}
                            {m.model ?? ""}
                          </div>
                        )}
                        {(m.genre || m.release_year) && (
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {m.genre ?? "—"}
                            {m.release_year ? ` · ${m.release_year}` : ""}
                          </div>
                        )}
                      </div>

                      <div className="mt-2 text-xs font-mono text-gray-400 dark:text-gray-500">{m.sku}</div>
                    </TableCell>

                    <TableCell className="text-sm">
                      <div>
                        <span className="text-gray-500 dark:text-gray-400">EAN:</span>{" "}
                        <span className="font-mono">{m.ean ?? "—"}</span>
                      </div>
                      <div>
                        <span className="text-gray-500 dark:text-gray-400">ASIN:</span>{" "}
                        <span className="font-mono">{m.asin ?? "—"}</span>
                      </div>
                      <div className="mt-2 text-xs font-mono text-gray-300 dark:text-gray-600">{m.id}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label="Aktionen">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={(e) => {
                              e.preventDefault();
                              openEdit(m);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                            Bearbeiten
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-red-700 focus:bg-red-50 focus:text-red-800 dark:text-red-300 dark:focus:bg-red-950/40 dark:focus:text-red-200"
                            onSelect={(e) => {
                              e.preventDefault();
                              requestDelete(m);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                            Löschen
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}

              {!rows.length && (
                <TableRow>
                  <TableCell colSpan={3} className="text-sm text-gray-500 dark:text-gray-400">
                    <div className="flex flex-col items-start gap-2 py-3">
                      <div>Keine Produkte gefunden.</div>
                      <div className="flex items-center gap-2">
                        <Button type="button" variant="secondary" onClick={() => setSearch("")} disabled={!search.trim()}>
                          Suche zurücksetzen
                        </Button>
                        <Button type="button" onClick={openCreate}>
                          <Plus className="h-4 w-4" />
                          Produkt anlegen
                        </Button>
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={editorOpen}
        onOpenChange={(open) => {
          if (!open) {
            setEditorOpen(false);
            setActiveProduct(null);
          }
        }}
      >
          <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{editorMode === "create" ? "Produkt anlegen" : "Produkt bearbeiten"}</DialogTitle>
            <DialogDescription>
              {editorMode === "edit" && activeProduct
                ? `${activeProduct.sku} · ${activeProduct.title} (${kindLabel(activeProduct.kind)})`
                : "Pflegen Sie die Identität (Typ, Titel, Plattform, Region, Variante) sauber, damit Duplikate vermieden werden."}
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (editorMode === "create") return create.mutate();
              return update.mutate();
            }}
            className="space-y-4"
          >
            <div className="grid gap-4 md:grid-cols-6">
              <div className="space-y-2 md:col-span-3">
                <Label>Titel</Label>
                <Input autoFocus value={form.title} onChange={(e) => setForm((s) => ({ ...s, title: e.target.value }))} />
              </div>
              <div className="space-y-2 md:col-span-1">
                <Label>Typ</Label>
                <Select value={form.kind} onValueChange={(v) => setForm((s) => ({ ...s, kind: v as MasterProductKind }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KIND_OPTIONS.map((k) => (
                      <SelectItem key={k.value} value={k.value}>
                        {k.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 md:col-span-1">
                <Label>Plattform</Label>
                <Input value={form.platform} onChange={(e) => setForm((s) => ({ ...s, platform: e.target.value }))} />
              </div>
              <div className="space-y-2 md:col-span-1">
                <Label>Region</Label>
                <Input
                  value={form.region}
                  onChange={(e) => setForm((s) => ({ ...s, region: e.target.value }))}
                  placeholder="EU, US, JP, N/A"
                  list="region-options"
                />
                <datalist id="region-options">
                  <option value="EU" />
                  <option value="US" />
                  <option value="JP" />
                  <option value="N/A" />
                </datalist>
              </div>

              <div className="space-y-2 md:col-span-2">
                <Label>Variante</Label>
                <Input
                  value={form.variant}
                  onChange={(e) => setForm((s) => ({ ...s, variant: e.target.value }))}
                  placeholder="z.B. Farbe, Bundle, Speicher…"
                />
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-950/50">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Optionale Felder</div>
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowAdvanced((v) => !v)}>
                  {showAdvanced ? "Ausblenden" : "Anzeigen"}
                </Button>
              </div>

              {showAdvanced && (
                <div className="mt-4 grid gap-4 md:grid-cols-6">
                  <div className="space-y-2 md:col-span-2">
                    <Label>Hersteller</Label>
                    <Input
                      value={form.manufacturer}
                      onChange={(e) => setForm((s) => ({ ...s, manufacturer: e.target.value }))}
                      placeholder="z.B. Nintendo, Sony, Microsoft"
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label>Modell</Label>
                    <Input value={form.model} onChange={(e) => setForm((s) => ({ ...s, model: e.target.value }))} placeholder="z.B. Switch OLED" />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label>Genre</Label>
                    <Input value={form.genre} onChange={(e) => setForm((s) => ({ ...s, genre: e.target.value }))} />
                  </div>

                  <div className="space-y-2 md:col-span-2">
                    <Label>EAN</Label>
                    <Input value={form.ean} onChange={(e) => setForm((s) => ({ ...s, ean: e.target.value }))} />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label>ASIN</Label>
                    <Input value={form.asin} onChange={(e) => setForm((s) => ({ ...s, asin: e.target.value }))} />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label>Release (Jahr)</Label>
                    <Input value={form.release_year} onChange={(e) => setForm((s) => ({ ...s, release_year: e.target.value }))} placeholder="z.B. 2017" />
                    {!releaseYearValid && <div className="text-xs text-red-700">1970–2100</div>}
                  </div>

                  <div className="space-y-2 md:col-span-6">
                    <Label>Referenzbild-URL</Label>
                    <Input
                      value={form.reference_image_url}
                      onChange={(e) => setForm((s) => ({ ...s, reference_image_url: e.target.value }))}
                      placeholder="https://…"
                    />
                  </div>
                </div>
              )}
            </div>

            {(create.isError || update.isError) && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                {((editorMode === "create" ? create.error : update.error) as Error).message}
              </div>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setEditorOpen(false)}
                disabled={create.isPending || update.isPending}
              >
                Abbrechen
              </Button>
              <Button type="submit" disabled={!requiredValid || !releaseYearValid || create.isPending || update.isPending}>
                {editorMode === "create" ? "Anlegen" : "Speichern"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDelete !== null} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Produkt löschen?</DialogTitle>
            <DialogDescription>
              {confirmDelete ? `${confirmDelete.sku} · ${confirmDelete.title}` : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="text-sm text-gray-700 dark:text-gray-300">
            Das Produkt wird dauerhaft gelöscht. Falls es bereits in Einkäufen oder Lagerbestand verwendet wird, ist das Löschen nicht möglich.
          </div>

          {remove.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
              {(remove.error as Error).message}
            </div>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" onClick={() => setConfirmDelete(null)} disabled={remove.isPending}>
              Abbrechen
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => confirmDelete && remove.mutate(confirmDelete.id)}
              disabled={!confirmDelete || remove.isPending}
            >
              <Trash2 className="h-4 w-4" />
              Löschen
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formFromProduct(m: MasterProduct): MasterProductFormState {
  return {
    kind: m.kind,
    title: m.title ?? "",
    manufacturer: m.manufacturer ?? "",
    model: m.model ?? "",
    platform: m.platform ?? "",
    region: m.region ?? "",
    variant: m.variant ?? "",
    ean: m.ean ?? "",
    asin: m.asin ?? "",
    genre: m.genre ?? "",
    release_year: m.release_year ? String(m.release_year) : "",
    reference_image_url: m.reference_image_url ?? "",
  };
}

function hasAdvancedValues(f: MasterProductFormState): boolean {
  return !!(
    f.manufacturer.trim() ||
    f.model.trim() ||
    f.ean.trim() ||
    f.asin.trim() ||
    f.genre.trim() ||
    f.release_year.trim() ||
    f.reference_image_url.trim()
  );
}
