import { Image as ImageIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

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

type MasterProductKind = "GAME" | "CONSOLE" | "ACCESSORY" | "OTHER";

type MasterProduct = {
  id: string;
  sku?: string;
  kind?: MasterProductKind;
  title: string;
  platform: string;
  region: string;
  variant?: string;
  reference_image_url?: string | null;
};

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

const MASTER_KIND_LABEL: Record<string, string> = {
  GAME: "Spiel",
  CONSOLE: "Konsole",
  ACCESSORY: "Zubehör",
  OTHER: "Sonstiges",
};

function inventoryStatusLabel(status: string): string {
  const opt = INVENTORY_STATUS_OPTIONS.find((o) => o.value === status);
  return opt?.label ?? status;
}

function inventoryStatusVariant(status: string) {
  switch (status) {
    case "AVAILABLE":
      return "success" as const;
    case "RESERVED":
      return "warning" as const;
    case "LOST":
      return "danger" as const;
    case "SOLD":
      return "secondary" as const;
    case "RETURNED":
      return "outline" as const;
    case "DRAFT":
    default:
      return "secondary" as const;
  }
}

function conditionLabel(condition: string): string {
  return CONDITION_LABEL[condition] ?? condition;
}

function purchaseTypeLabel(purchaseType: string): string {
  return PURCHASE_TYPE_LABEL[purchaseType] ?? purchaseType;
}

function kindLabel(kind: string | null | undefined): string {
  if (!kind) return "";
  return MASTER_KIND_LABEL[kind] ?? kind;
}

function isLikelyImagePath(path: string): boolean {
  const p = (path ?? "").toLowerCase();
  return (
    p.endsWith(".png") ||
    p.endsWith(".jpg") ||
    p.endsWith(".jpeg") ||
    p.endsWith(".webp") ||
    p.endsWith(".gif") ||
    p.endsWith(".avif") ||
    p.endsWith(".bmp")
  );
}

function ageVariant(days: number | null) {
  if (days === null) return { variant: "secondary" as const, label: "k. A." };
  if (days < 30) return { variant: "success" as const, label: `${days}T` };
  if (days <= 90) return { variant: "warning" as const, label: `${days}T` };
  return { variant: "danger" as const, label: `${days}T` };
}

function ReferenceThumb({
  url,
  alt,
  size = 44,
}: {
  url?: string | null;
  alt: string;
  size?: number;
}) {
  const src = (url ?? "").trim();
  const [errored, setErrored] = useState(false);

  useEffect(() => setErrored(false), [src]);

  const hasSrc = !!src;

  return (
    <div
      className={[
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm",
        "dark:border-gray-800 dark:bg-gray-950/40",
      ].join(" ")}
      style={{ width: size, height: size }}
    >
      {hasSrc && !errored ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setErrored(true)}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-gray-50 text-gray-400 dark:bg-gray-900/40 dark:text-gray-500">
          <ImageIcon className="h-4 w-4" />
          <span className="text-[10px] font-medium uppercase tracking-wide">Bild</span>
        </div>
      )}
    </div>
  );
}

function MetaPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex max-w-[18rem] items-center gap-1 truncate rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] text-gray-700 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-200">
      <span className="text-gray-500 dark:text-gray-400">{label}:</span>
      <span className="font-mono">{value}</span>
    </span>
  );
}

export function InventoryPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>(() => {
    const s = (searchParams.get("status") ?? "").toUpperCase();
    if (s && INVENTORY_STATUS_OPTIONS.some((o) => o.value === s)) return s;
    return "ALL";
  });

  const [editing, setEditing] = useState<InventoryItem | null>(null);
  const [editStorageLocation, setEditStorageLocation] = useState("");
  const [editSerialNumber, setEditSerialNumber] = useState("");
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, true>>({});
  const [activeImageId, setActiveImageId] = useState<string | null>(null);

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

  useEffect(() => {
    setActiveImageId(null);
    setPreviewErrors({});
    setPreviewUrls((prev) => {
      Object.values(prev).forEach((u) => URL.revokeObjectURL(u));
      return {};
    });
  }, [editing?.id]);

  useEffect(() => {
    const keep = new Set((images.data ?? []).map((i) => i.id));
    setPreviewUrls((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [id, url] of Object.entries(prev)) {
        if (keep.has(id)) next[id] = url;
        else {
          changed = true;
          URL.revokeObjectURL(url);
        }
      }
      return changed ? next : prev;
    });
    setPreviewErrors((prev) => {
      let changed = false;
      const next: Record<string, true> = {};
      for (const [id, v] of Object.entries(prev)) {
        if (keep.has(id)) next[id] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [images.data]);

  useEffect(() => {
    const first = images.data?.[0]?.id ?? null;
    if (!first) {
      setActiveImageId(null);
      return;
    }
    setActiveImageId((cur) => {
      if (cur && (images.data ?? []).some((i) => i.id === cur)) return cur;
      return first;
    });
  }, [images.data]);

  useEffect(() => {
    if (!editing?.id) return;
    const missing = (images.data ?? []).filter(
      (img) => isLikelyImagePath(img.upload_path) && !previewUrls[img.id] && !previewErrors[img.id],
    );
    if (!missing.length) return;

    let cancelled = false;
    (async () => {
      const newUrls: Record<string, string> = {};
      const newErr: Record<string, true> = {};
      for (const img of missing) {
        try {
          const blob = await api.fileBlob(img.upload_path);
          if (cancelled) break;
          if (!blob.type.startsWith("image/")) {
            newErr[img.id] = true;
            continue;
          }
          newUrls[img.id] = URL.createObjectURL(blob);
        } catch {
          newErr[img.id] = true;
        }
      }

      if (cancelled) {
        Object.values(newUrls).forEach((u) => URL.revokeObjectURL(u));
        return;
      }

      if (Object.keys(newUrls).length) setPreviewUrls((prev) => ({ ...prev, ...newUrls }));
      if (Object.keys(newErr).length) setPreviewErrors((prev) => ({ ...prev, ...newErr }));
    })();

    return () => {
      cancelled = true;
    };
  }, [editing?.id, images.data, previewErrors, previewUrls]);

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
      const img = await api.request<InventoryImage>(`/inventory/${editing.id}/images`, { method: "POST", json: { upload_path: r.upload_path } });
      setActiveImageId(img.id);
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
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
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
                const totalCostCents = it.purchase_price_cents + it.allocated_costs_cents;
                const hasAllocated = it.allocated_costs_cents > 0;
                return (
                  <TableRow key={it.id}>
                    <TableCell>
                      <div className="flex items-start gap-3">
                        <ReferenceThumb url={mp?.reference_image_url ?? null} alt={mp?.title ?? "Produkt"} />

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="min-w-0 truncate font-medium">{mp ? mp.title : it.master_product_id}</div>
                            {mp?.kind ? <Badge variant="secondary">{kindLabel(mp.kind)}</Badge> : null}
                            {mp?.sku ? (
                              <Badge variant="outline" className="font-mono text-[11px]">
                                {mp.sku}
                              </Badge>
                            ) : null}
                          </div>

                          {mp && (
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                              <span>{mp.platform}</span>
                              <span className="text-gray-300 dark:text-gray-700">•</span>
                              <span>{mp.region}</span>
                              {mp.variant ? (
                                <>
                                  <span className="text-gray-300 dark:text-gray-700">•</span>
                                  <span className="truncate">{mp.variant}</span>
                                </>
                              ) : null}
                            </div>
                          )}

                          {(it.serial_number || it.storage_location) && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {it.serial_number ? <MetaPill label="SN" value={it.serial_number} /> : null}
                              {it.storage_location ? <MetaPill label="Lager" value={it.storage_location} /> : null}
                            </div>
                          )}

                          <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                            ID: <span className="font-mono text-gray-400 dark:text-gray-500">{it.id}</span>
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={inventoryStatusVariant(it.status)}>{inventoryStatusLabel(it.status)}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={av.variant}>{av.label}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{conditionLabel(it.condition)}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{purchaseTypeLabel(it.purchase_type)}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="font-medium">{formatEur(totalCostCents)} €</div>
                      <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        EK {formatEur(it.purchase_price_cents)} €{hasAllocated ? ` + NK ${formatEur(it.allocated_costs_cents)} €` : ""}
                      </div>
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
                  <TableCell colSpan={7} className="text-sm text-gray-500 dark:text-gray-400">
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
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
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
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                {((images.error ?? upload.error ?? removeImage.error) as Error).message}
              </div>
            )}

            {!!(images.data ?? []).length && (
              <div className="rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950/40">
                <div className="flex flex-wrap gap-2">
                  {(images.data ?? []).map((img) => {
                    const url = previewUrls[img.id];
                    const isActive = activeImageId === img.id;
                    const canPreview = isLikelyImagePath(img.upload_path) && !previewErrors[img.id];
                    return (
                      <button
                        key={img.id}
                        type="button"
                        className={[
                          "relative h-16 w-16 overflow-hidden rounded-md border bg-white shadow-sm",
                          "dark:border-gray-800 dark:bg-gray-900",
                          isActive ? "ring-2 ring-gray-300 dark:ring-gray-700" : "hover:ring-2 hover:ring-gray-200 dark:hover:ring-gray-800",
                        ].join(" ")}
                        onClick={() => setActiveImageId(img.id)}
                        title={img.upload_path}
                      >
                        {url ? (
                          <img src={url} alt="Artikelbild" className="h-full w-full object-cover" />
                        ) : canPreview ? (
                          <div className="h-full w-full animate-pulse bg-gray-100 dark:bg-gray-800" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center bg-gray-100 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                            Datei
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>

                {activeImageId && (
                  <div className="mt-3 overflow-hidden rounded-md border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
                    {previewUrls[activeImageId] ? (
                      <img
                        src={previewUrls[activeImageId]}
                        alt="Artikelbild Vorschau"
                        className="max-h-64 w-full bg-gray-50 object-contain dark:bg-gray-950/40"
                      />
                    ) : (
                      <div className="flex h-40 w-full items-center justify-center bg-gray-50 text-sm text-gray-500 dark:bg-gray-950/40 dark:text-gray-400">
                        Vorschau nicht verfügbar.
                      </div>
                    )}
                    <div className="border-t border-gray-100 p-2 text-xs font-mono text-gray-500 dark:border-gray-800 dark:text-gray-400">
                      {(images.data ?? []).find((i) => i.id === activeImageId)?.upload_path ?? ""}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="rounded-md border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
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
                      <TableCell colSpan={2} className="text-sm text-gray-500 dark:text-gray-400">
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
