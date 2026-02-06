import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { formatEur } from "../lib/money";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

type InventoryItem = {
  id: string;
  master_product_id: string;
  condition: string;
  purchase_type: string;
  purchase_price_cents: number;
  allocated_costs_cents: number;
  storage_location?: string | null;
  serial_number?: string | null;
  status: string;
  acquired_date?: string | null;
};

type MasterProduct = { id: string; sku?: string; title: string; platform: string; region: string; variant?: string };

type InventoryImage = {
  id: string;
  upload_path: string;
  created_at: string;
};

type UploadOut = { upload_path: string };

const INVENTORY_STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "DRAFT", label: "Entwurf" },
  { value: "AVAILABLE", label: "Verfügbar" },
  { value: "RESERVED", label: "Reserviert" },
  { value: "SOLD", label: "Verkauft" },
  { value: "RETURNED", label: "Retourniert" },
  { value: "LOST", label: "Verloren" },
];

const CONDITION_LABEL: Record<string, string> = {
  NEW: "Neu",
  LIKE_NEW: "Wie neu",
  GOOD: "Gut",
  ACCEPTABLE: "Akzeptabel",
  DEFECT: "Defekt",
};

const PURCHASE_TYPE_LABEL: Record<string, string> = {
  DIFF: "Differenz",
  REGULAR: "Regulär",
};

function inventoryStatusLabel(status: string): string {
  const opt = INVENTORY_STATUS_OPTIONS.find((o) => o.value === status);
  return opt?.label ?? status;
}

function conditionLabel(condition: string): string {
  return CONDITION_LABEL[condition] ?? condition;
}

function purchaseTypeLabel(purchaseType: string): string {
  return PURCHASE_TYPE_LABEL[purchaseType] ?? purchaseType;
}

function ageVariant(days: number | null) {
  if (days === null) return { variant: "secondary" as const, label: "k. A." };
  if (days < 30) return { variant: "success" as const, label: `${days}T` };
  if (days <= 90) return { variant: "warning" as const, label: `${days}T` };
  return { variant: "danger" as const, label: `${days}T` };
}

export function InventoryPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("ALL");

  const [editing, setEditing] = useState<InventoryItem | null>(null);
  const [editStorageLocation, setEditStorageLocation] = useState("");
  const [editSerialNumber, setEditSerialNumber] = useState("");

  const master = useQuery({
    queryKey: ["master-products"],
    queryFn: () => api.request<MasterProduct[]>("/master-products"),
  });

  const inv = useQuery({
    queryKey: ["inventory", q, status],
    queryFn: () =>
      api.request<InventoryItem[]>(
        `/inventory?limit=50&offset=0${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}${status !== "ALL" ? `&status=${status}` : ""}`,
      ),
  });

  const mpById = useMemo(() => {
    const map = new Map<string, MasterProduct>();
    (master.data ?? []).forEach((m) => map.set(m.id, m));
    return map;
  }, [master.data]);

  const rows = inv.data ?? [];
  const today = new Date();

  const images = useQuery({
    queryKey: ["inventory-images", editing?.id],
    enabled: !!editing?.id,
    queryFn: () => api.request<InventoryImage[]>(`/inventory/${editing!.id}/images`),
  });

  const update = useMutation({
    mutationFn: async () => {
      if (!editing) throw new Error("Kein Artikel ausgewählt");
      return api.request<InventoryItem>(`/inventory/${editing.id}`, {
        method: "PATCH",
        json: {
          storage_location: editStorageLocation.trim() ? editStorageLocation.trim() : null,
          serial_number: editSerialNumber.trim() ? editSerialNumber.trim() : null,
        },
      });
    },
    onSuccess: async () => {
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.request<UploadOut>("/uploads", { method: "POST", body: fd });
    },
    onSuccess: async (r) => {
      if (!editing) return;
      await api.request<InventoryImage>(`/inventory/${editing.id}/images`, { method: "POST", json: { upload_path: r.upload_path } });
      await qc.invalidateQueries({ queryKey: ["inventory-images", editing.id] });
    },
  });

  const removeImage = useMutation({
    mutationFn: async (imageId: string) => {
      if (!editing) throw new Error("Kein Artikel ausgewählt");
      return api.request<void>(`/inventory/${editing.id}/images/${imageId}`, { method: "DELETE" });
    },
    onSuccess: async () => {
      if (!editing) return;
      await qc.invalidateQueries({ queryKey: ["inventory-images", editing.id] });
    },
  });

  return (
    <div className="space-y-4">
      <div className="text-xl font-semibold">Lagerbestand</div>

      <Card>
        <CardHeader>
          <CardTitle>Suche</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 md:flex-row md:items-center">
          <Input placeholder="SKU/Titel/EAN/ASIN oder Produktstamm-UUID…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="w-full md:w-56">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Alle</SelectItem>
                {INVENTORY_STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="secondary" onClick={() => inv.refetch()}>
            Aktualisieren
          </Button>
        </CardContent>
      </Card>

      {(inv.isError || master.isError) && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          {((inv.error ?? master.error) as Error).message}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Artikel</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produkt</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Alter</TableHead>
                <TableHead>Zustand</TableHead>
                <TableHead>Typ</TableHead>
                <TableHead className="text-right">Kosten (EUR)</TableHead>
                <TableHead className="text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((it) => {
                const mp = mpById.get(it.master_product_id);
                const acquired = it.acquired_date ? new Date(it.acquired_date) : null;
                const days =
                  acquired ? Math.max(0, Math.floor((today.getTime() - acquired.getTime()) / (1000 * 60 * 60 * 24))) : null;
                const av = ageVariant(days);
                return (
                  <TableRow key={it.id}>
                    <TableCell>
                      <div className="font-medium">{mp ? mp.title : it.master_product_id}</div>
                      {mp && (
                        <div className="text-xs text-gray-500">
                          {mp.platform} · {mp.region}
                          {mp.variant ? ` · ${mp.variant}` : ""}
                        </div>
                      )}
                      {mp?.sku && <div className="text-xs text-gray-400 font-mono">{mp.sku}</div>}
                      {it.serial_number && <div className="text-xs text-gray-500">SN: <span className="font-mono">{it.serial_number}</span></div>}
                      {it.storage_location && <div className="text-xs text-gray-500">Lager: {it.storage_location}</div>}
                      <div className="text-xs text-gray-400 font-mono">{it.id}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{inventoryStatusLabel(it.status)}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={av.variant}>{av.label}</Badge>
                    </TableCell>
                    <TableCell>{conditionLabel(it.condition)}</TableCell>
                    <TableCell>{purchaseTypeLabel(it.purchase_type)}</TableCell>
                    <TableCell className="text-right">
                      {formatEur(it.purchase_price_cents + it.allocated_costs_cents)} €
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        onClick={() => {
                          setEditing(it);
                          setEditStorageLocation(it.storage_location ?? "");
                          setEditSerialNumber(it.serial_number ?? "");
                        }}
                      >
                        Bearbeiten
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!rows.length && (
                <TableRow>
                  <TableCell colSpan={7} className="text-sm text-gray-500">
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
            <DialogTitle>Artikel bearbeiten</DialogTitle>
            <DialogDescription>{editing ? editing.id : ""}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Seriennummer (optional)</Label>
              <Input value={editSerialNumber} onChange={(e) => setEditSerialNumber(e.target.value)} placeholder="SN / IMEI / …" />
            </div>
            <div className="space-y-2">
              <Label>Lagerplatz (optional)</Label>
              <Input value={editStorageLocation} onChange={(e) => setEditStorageLocation(e.target.value)} placeholder="Regal 2 / Box A / …" />
            </div>
          </div>

          {update.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {(update.error as Error).message}
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Bilder</div>
              <Input
                type="file"
                className="max-w-xs"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload.mutate(f);
                }}
              />
            </div>

            {(images.isError || upload.isError || removeImage.isError) && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                {((images.error ?? upload.error ?? removeImage.error) as Error).message}
              </div>
            )}

            <div className="rounded-md border border-gray-200 bg-white">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Datei</TableHead>
                    <TableHead className="text-right"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(images.data ?? []).map((img) => (
                    <TableRow key={img.id}>
                      <TableCell className="font-mono text-xs">{img.upload_path}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="secondary" onClick={() => api.download(img.upload_path)} disabled={removeImage.isPending}>
                            Download
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => removeImage.mutate(img.id)}
                            disabled={removeImage.isPending}
                          >
                            Entfernen
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!images.data?.length && (
                    <TableRow>
                      <TableCell colSpan={2} className="text-sm text-gray-500">
                        Noch keine Bilder.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          <DialogFooter>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={update.isPending}>
              Schließen
            </Button>
            <Button onClick={() => update.mutate()} disabled={update.isPending}>
              Speichern
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
