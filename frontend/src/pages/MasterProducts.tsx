import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
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
  const [form, setForm] = useState<MasterProductFormState>({ ...EMPTY_FORM });
  const [editing, setEditing] = useState<MasterProduct | null>(null);
  const [editForm, setEditForm] = useState<MasterProductFormState>({ ...EMPTY_FORM });

  const list = useQuery({
    queryKey: ["master-products"],
    queryFn: () => api.request<MasterProduct[]>("/master-products"),
  });

  const releaseYear = releaseYearOrNull(form.release_year);
  const releaseYearValid = releaseYear === null || (Number.isInteger(releaseYear) && releaseYear >= 1970 && releaseYear <= 2100);

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
      setForm({ ...EMPTY_FORM });
      await qc.invalidateQueries({ queryKey: ["master-products"] });
    },
  });

  const update = useMutation({
    mutationFn: () => {
      if (!editing) throw new Error("Kein Produkt ausgewählt");
      const ry = releaseYearOrNull(editForm.release_year);
      const ryValid = ry === null || (Number.isInteger(ry) && ry >= 1970 && ry <= 2100);
      if (!ryValid) throw new Error("Release-Jahr muss zwischen 1970 und 2100 liegen");
      return api.request<MasterProduct>(`/master-products/${editing.id}`, {
        method: "PATCH",
        json: {
          kind: editForm.kind,
          title: editForm.title.trim(),
          manufacturer: opt(editForm.manufacturer),
          model: opt(editForm.model),
          platform: editForm.platform.trim(),
          region: editForm.region.trim(),
          variant: editForm.variant.trim(),
          ean: opt(editForm.ean),
          asin: opt(editForm.asin),
          genre: opt(editForm.genre),
          release_year: ry,
          reference_image_url: opt(editForm.reference_image_url),
        },
      });
    },
    onSuccess: async () => {
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ["master-products"] });
    },
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = list.data ?? [];
    if (!q) return all;
    return all.filter((m) =>
      `${m.kind} ${m.sku} ${m.title} ${m.manufacturer ?? ""} ${m.model ?? ""} ${m.platform} ${m.region} ${m.variant} ${m.ean ?? ""} ${m.asin ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [list.data, search]);

  return (
    <div className="space-y-4">
      <div className="text-xl font-semibold">Produktstamm</div>

      <Card>
        <CardHeader>
          <CardTitle>Anlegen</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-4 md:grid-cols-6">
            <div className="space-y-2 md:col-span-3">
              <Label>Titel</Label>
              <Input value={form.title} onChange={(e) => setForm((s) => ({ ...s, title: e.target.value }))} />
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
              <Input value={form.region} onChange={(e) => setForm((s) => ({ ...s, region: e.target.value }))} placeholder="EU, US, JP, N/A" />
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label>Hersteller (optional)</Label>
              <Input
                value={form.manufacturer}
                onChange={(e) => setForm((s) => ({ ...s, manufacturer: e.target.value }))}
                placeholder="z.B. Nintendo, Sony, Microsoft"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Modell (optional)</Label>
              <Input value={form.model} onChange={(e) => setForm((s) => ({ ...s, model: e.target.value }))} placeholder="z.B. Switch OLED, DualSense" />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Variante (z.B. Farbe)</Label>
              <Input value={form.variant} onChange={(e) => setForm((s) => ({ ...s, variant: e.target.value }))} placeholder="White, Black, 512GB, Bundle…" />
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
              <Label>Genre (optional)</Label>
              <Input value={form.genre} onChange={(e) => setForm((s) => ({ ...s, genre: e.target.value }))} />
            </div>
            <div className="space-y-2 md:col-span-1">
              <Label>Release (Jahr)</Label>
              <Input
                value={form.release_year}
                onChange={(e) => setForm((s) => ({ ...s, release_year: e.target.value }))}
                placeholder="z.B. 2017"
              />
              {!releaseYearValid && <div className="text-xs text-red-700">1970–2100</div>}
            </div>
            <div className="space-y-2 md:col-span-3">
              <Label>Referenzbild-URL (optional)</Label>
              <Input
                value={form.reference_image_url}
                onChange={(e) => setForm((s) => ({ ...s, reference_image_url: e.target.value }))}
                placeholder="https://…"
              />
            </div>

            <div className="flex items-end md:col-span-6">
              <Button
                onClick={() => create.mutate()}
                disabled={!form.title.trim() || !form.platform.trim() || !form.region.trim() || !releaseYearValid || create.isPending}
              >
                Anlegen
              </Button>
            </div>
          </div>

          {create.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {(create.error as Error).message}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Liste</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Input placeholder="Suchen (SKU, Titel, EAN, ASIN, …) …" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Button variant="secondary" onClick={() => list.refetch()}>
              Aktualisieren
            </Button>
          </div>

          {list.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {(list.error as Error).message}
            </div>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produkt</TableHead>
                <TableHead>IDs</TableHead>
                <TableHead className="text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="font-medium">{m.title}</div>
                      <Badge variant="secondary">{kindLabel(m.kind)}</Badge>
                    </div>
                    <div className="text-xs text-gray-500">
                      {m.platform} · {m.region}
                      {m.variant ? ` · ${m.variant}` : ""}
                    </div>
                    {(m.manufacturer || m.model) && (
                      <div className="text-xs text-gray-500">
                        {m.manufacturer ?? ""}{m.manufacturer && m.model ? " · " : ""}{m.model ?? ""}
                      </div>
                    )}
                    <div className="text-xs text-gray-400 font-mono">{m.sku}</div>
                    <div className="text-xs text-gray-300 font-mono">{m.id}</div>
                  </TableCell>
                  <TableCell className="text-sm">
                    <div>
                      <span className="text-gray-500">EAN:</span> <span className="font-mono">{m.ean ?? "—"}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">ASIN:</span> <span className="font-mono">{m.asin ?? "—"}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setEditing(m);
                        setEditForm({
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
                        });
                      }}
                    >
                      Bearbeiten
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!rows.length && (
                <TableRow>
                  <TableCell colSpan={3} className="text-sm text-gray-500">
                    Keine Daten.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Produkt bearbeiten</DialogTitle>
            <DialogDescription>{editing ? `${editing.sku} · ${editing.title} (${kindLabel(editing.kind)})` : ""}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-6">
            <div className="space-y-2 md:col-span-3">
              <Label>Titel</Label>
              <Input value={editForm.title} onChange={(e) => setEditForm((s) => ({ ...s, title: e.target.value }))} />
            </div>
            <div className="space-y-2 md:col-span-1">
              <Label>Typ</Label>
              <Select value={editForm.kind} onValueChange={(v) => setEditForm((s) => ({ ...s, kind: v as MasterProductKind }))}>
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
              <Input value={editForm.platform} onChange={(e) => setEditForm((s) => ({ ...s, platform: e.target.value }))} />
            </div>
            <div className="space-y-2 md:col-span-1">
              <Label>Region</Label>
              <Input value={editForm.region} onChange={(e) => setEditForm((s) => ({ ...s, region: e.target.value }))} />
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label>Hersteller (optional)</Label>
              <Input
                value={editForm.manufacturer}
                onChange={(e) => setEditForm((s) => ({ ...s, manufacturer: e.target.value }))}
                placeholder="z.B. Nintendo, Sony, Microsoft"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Modell (optional)</Label>
              <Input
                value={editForm.model}
                onChange={(e) => setEditForm((s) => ({ ...s, model: e.target.value }))}
                placeholder="z.B. Switch OLED, DualSense"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Variante (z.B. Farbe)</Label>
              <Input value={editForm.variant} onChange={(e) => setEditForm((s) => ({ ...s, variant: e.target.value }))} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>EAN</Label>
              <Input value={editForm.ean} onChange={(e) => setEditForm((s) => ({ ...s, ean: e.target.value }))} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>ASIN</Label>
              <Input value={editForm.asin} onChange={(e) => setEditForm((s) => ({ ...s, asin: e.target.value }))} />
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label>Genre (optional)</Label>
              <Input value={editForm.genre} onChange={(e) => setEditForm((s) => ({ ...s, genre: e.target.value }))} />
            </div>
            <div className="space-y-2 md:col-span-1">
              <Label>Release (Jahr)</Label>
              <Input value={editForm.release_year} onChange={(e) => setEditForm((s) => ({ ...s, release_year: e.target.value }))} />
            </div>
            <div className="space-y-2 md:col-span-3">
              <Label>Referenzbild-URL (optional)</Label>
              <Input
                value={editForm.reference_image_url}
                onChange={(e) => setEditForm((s) => ({ ...s, reference_image_url: e.target.value }))}
              />
            </div>
          </div>

          {update.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {(update.error as Error).message}
            </div>
          )}

          <DialogFooter>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={update.isPending}>
              Abbrechen
            </Button>
            <Button
              onClick={() => update.mutate()}
              disabled={!editForm.title.trim() || !editForm.platform.trim() || !editForm.region.trim() || update.isPending}
            >
              Speichern
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
