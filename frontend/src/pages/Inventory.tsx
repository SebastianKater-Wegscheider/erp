import { Copy, Image as ImageIcon, MoreHorizontal, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import { useApi } from "../lib/api";
import {
  AmazonFeeProfile,
  estimateFbaPayout,
  estimateMargin,
  estimateMarketPriceForInventoryCondition,
  estimateSellThroughFromBsr,
  formatSellThroughRange,
} from "../lib/amazon";
import { formatEur } from "../lib/money";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { InlineMessage } from "../components/ui/inline-message";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PageHeader } from "../components/ui/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { SearchField } from "../components/ui/search-field";
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
  ean?: string | null;
  asin?: string | null;
  reference_image_url?: string | null;

  amazon_last_success_at?: string | null;
  amazon_blocked_last?: boolean | null;
  amazon_rank_overall?: number | null;
  amazon_rank_overall_category?: string | null;
  amazon_rank_specific?: number | null;
  amazon_rank_specific_category?: string | null;

  amazon_price_new_cents?: number | null;
  amazon_price_used_like_new_cents?: number | null;
  amazon_price_used_very_good_cents?: number | null;
  amazon_price_used_good_cents?: number | null;
  amazon_price_used_acceptable_cents?: number | null;

  amazon_buybox_total_cents?: number | null;
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

const INVENTORY_STATUS_OPTIONS: Array<{ value: string; label: string }> = [
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

type InventoryViewMode = "overview" | "ops";
type InventoryQueue = "ALL" | "PHOTOS_MISSING" | "STORAGE_MISSING" | "AMAZON_STALE" | "OLD_STOCK_90D";

const INVENTORY_VIEW_KEY = "inventory:view";
const OVERVIEW_METRIC_CELL_CLASS = "w-[11.25rem] text-right";
const OVERVIEW_METRIC_CARD_CLASS =
  "inline-flex w-full min-h-[4.75rem] flex-col items-end justify-between rounded-lg border border-gray-200/90 bg-gray-50/80 px-2.5 py-2 text-right dark:border-gray-800 dark:bg-gray-900/50";
const INVENTORY_QUEUE_OPTIONS: Array<{ value: InventoryQueue; label: string }> = [
  { value: "ALL", label: "Alle" },
  { value: "PHOTOS_MISSING", label: "Fotos fehlen" },
  { value: "STORAGE_MISSING", label: "Lagerplatz fehlt" },
  { value: "AMAZON_STALE", label: "Amazon stale" },
  { value: "OLD_STOCK_90D", label: "Altbestand >90T" },
];

function normalizeInventoryViewMode(value?: string | null): InventoryViewMode | null {
  if (value === "overview" || value === "ops") return value;
  return null;
}

function normalizeInventoryQueue(value?: string | null): InventoryQueue {
  if (value === "PHOTOS_MISSING") return "PHOTOS_MISSING";
  if (value === "STORAGE_MISSING") return "STORAGE_MISSING";
  if (value === "AMAZON_STALE") return "AMAZON_STALE";
  if (value === "OLD_STOCK_90D") return "OLD_STOCK_90D";
  return "ALL";
}

function readPersistedInventoryViewMode(): InventoryViewMode | null {
  if (typeof window === "undefined") return null;
  const getItem = window.localStorage?.getItem;
  if (typeof getItem !== "function") return null;
  try {
    return normalizeInventoryViewMode(getItem.call(window.localStorage, INVENTORY_VIEW_KEY));
  } catch {
    return null;
  }
}

function persistInventoryViewMode(viewMode: InventoryViewMode): void {
  if (typeof window === "undefined") return;
  const setItem = window.localStorage?.setItem;
  if (typeof setItem !== "function") return;
  try {
    setItem.call(window.localStorage, INVENTORY_VIEW_KEY, viewMode);
  } catch {
    // ignore storage failures
  }
}

function copyViaExecCommand(value: string): boolean {
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");
  ta.style.position = "absolute";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  return ok;
}

async function copyToClipboard(value: string): Promise<boolean> {
  const text = value.trim();
  if (!text) return false;
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return copyViaExecCommand(text);
    }
  }
  return copyViaExecCommand(text);
}

function inventoryStatusLabel(status: string): string {
  const opt = INVENTORY_STATUS_OPTIONS.find((o) => o.value === status);
  return opt?.label ?? status;
}

function inventoryStatusVariant(status: string) {
  switch (status) {
    case "AVAILABLE":
      return "success" as const;
    case "FBA_WAREHOUSE":
      return "success" as const;
    case "FBA_INBOUND":
      return "warning" as const;
    case "RESERVED":
      return "warning" as const;
    case "DISCREPANCY":
      return "danger" as const;
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

function sellThroughSpeedLabel(speed: string): string {
  switch (speed) {
    case "FAST":
      return "Schnell";
    case "MEDIUM":
      return "Mittel";
    case "SLOW":
      return "Langsam";
    case "VERY_SLOW":
      return "Sehr langsam";
    default:
      return "—";
  }
}

function sellThroughSpeedVariant(speed: string) {
  switch (speed) {
    case "FAST":
      return "success" as const;
    case "MEDIUM":
      return "secondary" as const;
    case "SLOW":
      return "warning" as const;
    case "VERY_SLOW":
      return "danger" as const;
    default:
      return "outline" as const;
  }
}

function sellThroughConfidenceVariant(confidence: string) {
  switch (confidence) {
    case "HIGH":
      return "success" as const;
    case "MEDIUM":
      return "secondary" as const;
    case "LOW":
    default:
      return "outline" as const;
  }
}

function sellThroughConfidenceLabel(confidence: string): string {
  switch (confidence) {
    case "HIGH":
      return "Hoch";
    case "MEDIUM":
      return "Mittel";
    case "LOW":
      return "Niedrig";
    default:
      return "k. A.";
  }
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  const [viewMode, setViewMode] = useState<InventoryViewMode>(() => {
    const fromUrl = normalizeInventoryViewMode(searchParams.get("view"));
    if (fromUrl) return fromUrl;
    return readPersistedInventoryViewMode() ?? "overview";
  });
  const [status, setStatus] = useState<string>(() => {
    const s = (searchParams.get("status") ?? "").toUpperCase();
    if (s && INVENTORY_STATUS_OPTIONS.some((o) => o.value === s)) return s;
    return "ALL";
  });
  const [queue, setQueue] = useState<InventoryQueue>(() => normalizeInventoryQueue(searchParams.get("queue")));

  const [editing, setEditing] = useState<InventoryItem | null>(null);
  const [editStorageLocation, setEditStorageLocation] = useState("");
  const [editSerialNumber, setEditSerialNumber] = useState("");
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, true>>({});
  const [activeImageId, setActiveImageId] = useState<string | null>(null);
  const [imagesDragOver, setImagesDragOver] = useState(false);
  const [tablePreviewItemId, setTablePreviewItemId] = useState<string | null>(null);
  const [tablePreviewImageId, setTablePreviewImageId] = useState<string | null>(null);
  const [tablePreviewUrls, setTablePreviewUrls] = useState<Record<string, string>>({});
  const [tablePreviewErrors, setTablePreviewErrors] = useState<Record<string, true>>({});
  const tablePreviewUrlsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    persistInventoryViewMode(viewMode);
  }, [viewMode]);

  useEffect(() => {
    const fromUrl = normalizeInventoryViewMode(searchParams.get("view"));
    if (fromUrl && fromUrl !== viewMode) setViewMode(fromUrl);
  }, [searchParams, viewMode]);

  useEffect(() => {
    const qFromUrl = searchParams.get("q") ?? "";
    if (qFromUrl !== q) setQ(qFromUrl);

    const statusFromUrl = (() => {
      const s = (searchParams.get("status") ?? "").toUpperCase();
      if (s && INVENTORY_STATUS_OPTIONS.some((o) => o.value === s)) return s;
      return "ALL";
    })();
    if (statusFromUrl !== status) setStatus(statusFromUrl);

    const queueFromUrl = normalizeInventoryQueue(searchParams.get("queue"));
    if (queueFromUrl !== queue) setQueue(queueFromUrl);
  }, [q, queue, searchParams, status]);

  function updateInventorySearchParams(
    mutator: (next: URLSearchParams) => void,
    options?: { replace?: boolean },
  ) {
    const next = new URLSearchParams(searchParams);
    mutator(next);
    setSearchParams(next, { replace: options?.replace ?? false });
  }

  function setSearchQuery(nextQ: string) {
    setQ(nextQ);
    updateInventorySearchParams(
      (next) => {
        const trimmed = nextQ.trim();
        if (trimmed) next.set("q", trimmed);
        else next.delete("q");
      },
      { replace: true },
    );
  }

  function setStatusFilter(nextStatus: string) {
    setStatus(nextStatus);
    updateInventorySearchParams(
      (next) => {
        if (nextStatus === "ALL") next.delete("status");
        else next.set("status", nextStatus);
      },
      { replace: true },
    );
  }

  function setQueueFilter(nextQueue: InventoryQueue) {
    setQueue(nextQueue);
    updateInventorySearchParams(
      (next) => {
        if (nextQueue === "ALL") next.delete("queue");
        else next.set("queue", nextQueue);
      },
      { replace: true },
    );
  }

  function setViewModePersisted(nextMode: InventoryViewMode) {
    setViewMode(nextMode);
    updateInventorySearchParams(
      (next) => {
        next.set("view", nextMode);
      },
      { replace: true },
    );
  }

  const master = useQuery({
    queryKey: ["master-products"],
    queryFn: () => api.request<MasterProduct[]>("/master-products"),
  });

  const feeProfile = useQuery({
    queryKey: ["amazon-fee-profile"],
    queryFn: () => api.request<AmazonFeeProfile>("/amazon-scrapes/fee-profile"),
  });

  const feeProfileValue: AmazonFeeProfile = feeProfile.data ?? {
    referral_fee_bp: 1500,
    fulfillment_fee_cents: 350,
    inbound_shipping_cents: 0,
  };

  const feeTitle = `FBA Fees: referral ${(feeProfileValue.referral_fee_bp / 100).toFixed(2)}% + fulfillment ${formatEur(feeProfileValue.fulfillment_fee_cents)} € + inbound ${formatEur(feeProfileValue.inbound_shipping_cents)} €`;

  const inv = useQuery({
    queryKey: ["inventory", q, status, queue],
    queryFn: () =>
      api.request<InventoryItem[]>(
        `/inventory?limit=50&offset=0${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}${status !== "ALL" ? `&status=${status}` : ""}${queue !== "ALL" ? `&queue=${queue}` : ""}`,
      ),
  });

  const mpById = useMemo(() => {
    const map = new Map<string, MasterProduct>();
    (master.data ?? []).forEach((m) => map.set(m.id, m));
    return map;
  }, [master.data]);

  const rows = inv.data ?? [];
  const today = new Date();
  const rowItemIds = useMemo(() => rows.map((row) => row.id), [rows]);

  const rowImages = useQuery({
    queryKey: ["inventory-row-images", rowItemIds.join(",")],
    enabled: rowItemIds.length > 0,
    queryFn: () => {
      const params = new URLSearchParams();
      rowItemIds.forEach((id) => params.append("item_ids", id));
      return api.request<InventoryImage[]>(`/inventory/images?${params.toString()}`);
    },
  });

  const rowImagesByItemId = useMemo(() => {
    const map = new Map<string, InventoryImage[]>();
    for (const img of rowImages.data ?? []) {
      const list = map.get(img.inventory_item_id) ?? [];
      list.push(img);
      map.set(img.inventory_item_id, list);
    }
    return map;
  }, [rowImages.data]);

  const rowPrimaryImageByItemId = useMemo(() => {
    const map = new Map<string, InventoryImage>();
    for (const [itemId, imagesForItem] of rowImagesByItemId.entries()) {
      if (imagesForItem.length) map.set(itemId, imagesForItem[0]);
    }
    return map;
  }, [rowImagesByItemId]);

  const tablePreviewImages = useMemo(
    () => (tablePreviewItemId ? (rowImagesByItemId.get(tablePreviewItemId) ?? []) : []),
    [rowImagesByItemId, tablePreviewItemId],
  );

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

  useEffect(() => {
    tablePreviewUrlsRef.current = tablePreviewUrls;
  }, [tablePreviewUrls]);

  useEffect(() => {
    return () => {
      Object.values(tablePreviewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    const first = tablePreviewImages[0]?.id ?? null;
    if (!first) {
      setTablePreviewImageId(null);
      return;
    }
    setTablePreviewImageId((cur) => {
      if (cur && tablePreviewImages.some((img) => img.id === cur)) return cur;
      return first;
    });
  }, [tablePreviewImages]);

  const desiredTableImages = useMemo(() => {
    // Prefetch up to 4 thumbnails per item for the table row preview,
    // plus all images for the currently opened preview dialog.
    const map = new Map<string, InventoryImage>();
    for (const imagesForItem of rowImagesByItemId.values()) {
      for (const img of imagesForItem.slice(0, 4)) {
        map.set(img.id, img);
      }
    }
    for (const img of tablePreviewImages) {
      map.set(img.id, img);
    }
    return Array.from(map.values());
  }, [rowImagesByItemId, tablePreviewImages]);

  useEffect(() => {
    const keep = new Set(desiredTableImages.map((img) => img.id));
    setTablePreviewUrls((prev) => {
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
    setTablePreviewErrors((prev) => {
      let changed = false;
      const next: Record<string, true> = {};
      for (const [id, value] of Object.entries(prev)) {
        if (keep.has(id)) next[id] = value;
        else changed = true;
      }
      return changed ? next : prev;
    });

    const missing = desiredTableImages.filter(
      (img) =>
        isLikelyImagePath(img.upload_path) &&
        !tablePreviewUrls[img.id] &&
        !tablePreviewErrors[img.id],
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
        Object.values(newUrls).forEach((url) => URL.revokeObjectURL(url));
        return;
      }
      if (Object.keys(newUrls).length) setTablePreviewUrls((prev) => ({ ...prev, ...newUrls }));
      if (Object.keys(newErr).length) setTablePreviewErrors((prev) => ({ ...prev, ...newErr }));
    })();

    return () => {
      cancelled = true;
    };
  }, [api, desiredTableImages, tablePreviewErrors, tablePreviewUrls]);

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

  const uploadImages = useMutation({
    mutationFn: async ({ itemId, files }: { itemId: string; files: File[] }) => {
      const created: InventoryImage[] = [];
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        const uploaded = await api.request<UploadOut>("/uploads", { method: "POST", body: fd });
        const img = await api.request<InventoryImage>(`/inventory/${itemId}/images`, {
          method: "POST",
          json: { upload_path: uploaded.upload_path },
        });
        created.push(img);
      }
      return { itemId, created };
    },
    onSuccess: async ({ itemId, created }) => {
      if (created.length) {
        setActiveImageId(created[created.length - 1].id);
      }
      await qc.invalidateQueries({ queryKey: ["inventory-images", itemId] });
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

  function handleImageFiles(filesInput: FileList | File[] | null) {
    if (!editing) return;
    const files = Array.from(filesInput ?? []);
    if (!files.length) return;
    uploadImages.mutate({ itemId: editing.id, files });
  }

  const tablePreviewItem = tablePreviewItemId ? rows.find((row) => row.id === tablePreviewItemId) ?? null : null;
  const tablePreviewMasterProduct = tablePreviewItem
    ? mpById.get(tablePreviewItem.master_product_id) ?? null
    : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Lagerbestand"
        description={
          viewMode === "overview"
            ? "Priorisieren nach Marktpreis, Abverkauf und Marge."
            : "Operative Pflege für SN, Lagerplatz, Bilder und Artikelzustand."
        }
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              void master.refetch();
              void inv.refetch();
            }}
            disabled={master.isFetching || inv.isFetching}
          >
            <RefreshCw className="h-4 w-4" />
            Aktualisieren
          </Button>
        }
        actionsClassName="w-full sm:w-auto"
      />

      {(inv.isError || master.isError || rowImages.isError) && (
        <InlineMessage tone="error">
          {((inv.error ?? master.error ?? rowImages.error) as Error).message}
        </InlineMessage>
      )}

      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-col gap-1">
              <CardTitle>Artikel</CardTitle>
              <CardDescription>
                {inv.isPending ? "Lade…" : `${rows.length}${rows.length >= 50 ? "+" : ""} Artikel`}
              </CardDescription>
            </div>

            <div className="inline-flex items-center gap-1 rounded-md border border-gray-200 p-1 dark:border-gray-800">
              <Button
                type="button"
                size="sm"
                variant={viewMode === "overview" ? "secondary" : "ghost"}
                onClick={() => setViewModePersisted("overview")}
              >
                Priorisieren
              </Button>
              <Button
                type="button"
                size="sm"
                variant={viewMode === "ops" ? "secondary" : "ghost"}
                onClick={() => setViewModePersisted("ops")}
              >
                Pflege
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-1 items-center gap-2">
              <SearchField
                className="flex-1"
                value={q}
                onValueChange={setSearchQuery}
                placeholder="SKU/Titel/EAN/ASIN…"
              />
            </div>

            <div className="flex items-center gap-2">
              <Select value={status} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full md:w-[190px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Alle Status</SelectItem>
                  {INVENTORY_STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {INVENTORY_QUEUE_OPTIONS.map((opt) => (
              <Button
                key={opt.value}
                type="button"
                size="sm"
                variant={queue === opt.value ? "secondary" : "outline"}
                onClick={() => setQueueFilter(opt.value)}
              >
                {opt.label}
              </Button>
            ))}
          </div>

          <div className="space-y-2 md:hidden">
            {inv.isPending &&
              Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={`skel-inv-${i}`}
                  className="animate-pulse rounded-md border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-800 dark:bg-gray-900"
                >
                  <div className="flex items-start gap-3">
                    <div className="h-14 w-14 rounded-md bg-gray-100 dark:bg-gray-800" />
                    <div className="flex-1 space-y-2 pt-1">
                      <div className="h-4 w-3/4 rounded bg-gray-200 dark:bg-gray-800" />
                      <div className="h-3 w-1/2 rounded bg-gray-100 dark:bg-gray-800" />
                      <div className="h-3 w-2/3 rounded bg-gray-100 dark:bg-gray-800" />
                    </div>
                  </div>
                </div>
              ))}

            {!inv.isPending &&
              rows.map((it) => {
                const mp = mpById.get(it.master_product_id);
                const acquired = it.acquired_date ? new Date(it.acquired_date) : null;
                const days =
                  acquired ? Math.max(0, Math.floor((today.getTime() - acquired.getTime()) / (1000 * 60 * 60 * 24))) : null;
                const av = ageVariant(days);
                const totalCostCents = it.purchase_price_cents + it.allocated_costs_cents;
                const hasAllocated = it.allocated_costs_cents > 0;
                const market = estimateMarketPriceForInventoryCondition(mp, it.condition);
                const payout = estimateFbaPayout(market.cents, feeProfileValue);
                const margin = estimateMargin(payout.payout_cents, totalCostCents);
                const itemImages = rowImagesByItemId.get(it.id) ?? [];
                const itemPrimaryImage = rowPrimaryImageByItemId.get(it.id);
                const itemPrimaryUrl = itemPrimaryImage ? tablePreviewUrls[itemPrimaryImage.id] : null;
                const sell = estimateSellThroughFromBsr(mp ?? {});
                const sellRange = formatSellThroughRange(sell.range_days);
                const sellDisplay = sellRange === "—" ? "—" : `~${sellRange}`;
                const bsrRank = mp
                  ? typeof mp.amazon_rank_overall === "number"
                    ? mp.amazon_rank_overall
                    : mp.amazon_rank_specific
                  : null;

                return (
                  <div key={it.id} className="rounded-md border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-800 dark:bg-gray-900">
                    <div className="flex items-start gap-3">
                      <ReferenceThumb url={itemPrimaryUrl ?? mp?.reference_image_url ?? null} alt={mp?.title ?? "Produkt"} size={56} />

                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate font-medium text-gray-900 dark:text-gray-100">
                              {mp ? mp.title : it.master_product_id}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              {mp?.kind ? <Badge variant="secondary">{kindLabel(mp.kind)}</Badge> : null}
                              {mp?.sku ? (
                                <Badge variant="outline" className="font-mono text-[11px]">
                                  {mp.sku}
                                </Badge>
                              ) : null}
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-2">
                            <Badge variant={inventoryStatusVariant(it.status)}>{inventoryStatusLabel(it.status)}</Badge>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="outline" size="icon" aria-label="Aktionen">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onSelect={(e) => {
                                    e.preventDefault();
                                    void copyToClipboard(it.id);
                                  }}
                                >
                                  <Copy className="h-4 w-4" />
                                  Artikel-ID kopieren
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={(e) => {
                                    e.preventDefault();
                                    void copyToClipboard(it.master_product_id);
                                  }}
                                >
                                  <Copy className="h-4 w-4" />
                                  Produkt-UUID kopieren
                                </DropdownMenuItem>
                                {mp?.asin ? (
                                  <DropdownMenuItem
                                    onSelect={(e) => {
                                      e.preventDefault();
                                      void copyToClipboard(mp.asin ?? "");
                                    }}
                                  >
                                    <Copy className="h-4 w-4" />
                                    ASIN kopieren
                                  </DropdownMenuItem>
                                ) : null}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onSelect={(e) => {
                                    e.preventDefault();
                                    setEditing(it);
                                    setEditStorageLocation(it.storage_location ?? "");
                                    setEditSerialNumber(it.serial_number ?? "");
                                  }}
                                >
                                  Bearbeiten
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </div>

                        {mp ? (
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
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
                        ) : null}

                        {viewMode === "overview" ? (
                          <>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <Badge variant={av.variant}>{av.label}</Badge>
                              <Badge variant="outline">{conditionLabel(it.condition)}</Badge>
                            </div>

                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <div className="rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-950/30">
                                <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                  Marktpreis
                                </div>
                                <div className="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                                  {typeof market.cents === "number" ? `${formatEur(market.cents)} €` : "—"}
                                </div>
                                <div className="text-[11px] text-gray-500 dark:text-gray-400">{market.label}</div>
                              </div>

                              <div
                                className="rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-950/30"
                                title="Schätzung aus BSR + Offer-Konkurrenz; echte Verkäufe variieren."
                              >
                                <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                  Abverkauf
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-2">
                                  <Badge variant={sellThroughSpeedVariant(sell.speed)}>{sellThroughSpeedLabel(sell.speed)}</Badge>
                                  <div className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">{sellDisplay}</div>
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                                  <Badge variant={sellThroughConfidenceVariant(sell.confidence)}>{sell.confidence}</Badge>
                                  <span className="tabular-nums">{typeof bsrRank === "number" ? `BSR #${bsrRank}` : "BSR —"}</span>
                                </div>
                              </div>

                              <div className="rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-950/30" title={feeTitle}>
                                <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                  Marge
                                </div>
                                <div
                                  className={[
                                    "mt-0.5 font-semibold tabular-nums",
                                    margin === null
                                      ? "text-gray-900 dark:text-gray-100"
                                      : margin >= 0
                                        ? "text-emerald-700 dark:text-emerald-300"
                                        : "text-red-700 dark:text-red-300",
                                  ].join(" ")}
                                >
                                  {margin === null ? "—" : `${formatEur(margin)} €`}
                                </div>
                                <div className="text-[11px] text-gray-500 dark:text-gray-400">
                                  Kostenbasis {formatEur(totalCostCents)} €
                                </div>
                              </div>

                              <div className="rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-950/30" title={feeTitle}>
                                <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                  FBA payout
                                </div>
                                <div className="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                                  {typeof payout.payout_cents === "number" ? `${formatEur(payout.payout_cents)} €` : "—"}
                                </div>
                                <div className="text-[11px] text-gray-500 dark:text-gray-400">
                                  EK {formatEur(it.purchase_price_cents)} €{hasAllocated ? ` + NK ${formatEur(it.allocated_costs_cents)} €` : ""}
                                </div>
                              </div>
                            </div>

                            {!!itemImages.length && (
                              <div className="mt-2 flex items-center justify-between gap-3">
                                <Badge variant="outline">
                                  {itemImages.length} Foto{itemImages.length === 1 ? "" : "s"}
                                </Badge>
                                <Button size="sm" variant="outline" onClick={() => setTablePreviewItemId(it.id)}>
                                  Vorschau
                                </Button>
                              </div>
                            )}

                            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                              <Button
                                variant="outline"
                                className="w-full sm:w-auto sm:flex-1"
                                onClick={() => {
                                  setEditing(it);
                                  setEditStorageLocation(it.storage_location ?? "");
                                  setEditSerialNumber(it.serial_number ?? "");
                                }}
                              >
                                Bearbeiten
                              </Button>
                              {!!itemImages.length && (
                                <Button
                                  variant="secondary"
                                  className="w-full sm:w-auto sm:flex-1"
                                  onClick={() => setTablePreviewItemId(it.id)}
                                >
                                  Fotos
                                </Button>
                              )}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <Badge variant={av.variant}>{av.label}</Badge>
                              <Badge variant="outline">{conditionLabel(it.condition)}</Badge>
                              <Badge variant="outline">{purchaseTypeLabel(it.purchase_type)}</Badge>
                            </div>

                            {(it.serial_number || it.storage_location) && (
                              <div className="mt-2 flex flex-wrap gap-1">
                                {it.serial_number ? <MetaPill label="SN" value={it.serial_number} /> : null}
                                {it.storage_location ? <MetaPill label="Lager" value={it.storage_location} /> : null}
                              </div>
                            )}

                            <div className="mt-2">
                              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                                {formatEur(totalCostCents)} €
                              </div>
                              <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                                EK {formatEur(it.purchase_price_cents)} €{hasAllocated ? ` + NK ${formatEur(it.allocated_costs_cents)} €` : ""}
                              </div>
                            </div>

                            {!!itemImages.length && (
                              <div className="mt-3 space-y-2">
                                <div className="flex items-center justify-between gap-3">
                                  <Badge variant="outline">
                                    {itemImages.length} Foto{itemImages.length === 1 ? "" : "s"}
                                  </Badge>
                                  <Button size="sm" variant="outline" onClick={() => setTablePreviewItemId(it.id)}>
                                    Vorschau
                                  </Button>
                                </div>
                                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                                  {itemImages.slice(0, 4).map((img) => {
                                    const url = tablePreviewUrls[img.id];
                                    const canPreview = isLikelyImagePath(img.upload_path) && !tablePreviewErrors[img.id];
                                    return (
                                      <button
                                        key={img.id}
                                        type="button"
                                        className="h-12 w-12 shrink-0 overflow-hidden rounded border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
                                        title={img.upload_path}
                                        onClick={() => {
                                          setTablePreviewItemId(it.id);
                                          setTablePreviewImageId(img.id);
                                        }}
                                      >
                                        {url ? (
                                          <img src={url} alt="Artikelbild" className="h-full w-full object-cover" />
                                        ) : canPreview ? (
                                          <div className="h-full w-full animate-pulse bg-gray-100 dark:bg-gray-800" />
                                        ) : (
                                          <div className="flex h-full w-full items-center justify-center text-[10px] text-gray-500 dark:text-gray-400">
                                            Datei
                                          </div>
                                        )}
                                      </button>
                                    );
                                  })}
                                  {itemImages.length > 4 && (
                                    <div className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                                      +{itemImages.length - 4}
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}

                            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                              <Button
                                variant="outline"
                                className="w-full sm:w-auto sm:flex-1"
                                onClick={() => {
                                  setEditing(it);
                                  setEditStorageLocation(it.storage_location ?? "");
                                  setEditSerialNumber(it.serial_number ?? "");
                                }}
                              >
                                Bearbeiten
                              </Button>

                              {!!itemImages.length && (
                                <Button
                                  variant="secondary"
                                  className="w-full sm:w-auto sm:flex-1"
                                  onClick={() => setTablePreviewItemId(it.id)}
                                >
                                  Fotos
                                </Button>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

            {!inv.isPending && !rows.length && (
              <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-300">
                Keine Daten.
              </div>
            )}
          </div>

          <div className="hidden md:block">
            {viewMode === "overview" ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Produkt</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className={OVERVIEW_METRIC_CELL_CLASS}>Marktpreis</TableHead>
                    <TableHead className={OVERVIEW_METRIC_CELL_CLASS}>Abverkauf</TableHead>
                    <TableHead className={OVERVIEW_METRIC_CELL_CLASS}>Marge</TableHead>
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
                    const market = estimateMarketPriceForInventoryCondition(mp, it.condition);
                    const payout = estimateFbaPayout(market.cents, feeProfileValue);
                    const margin = estimateMargin(payout.payout_cents, totalCostCents);
                    const sell = estimateSellThroughFromBsr(mp ?? {});
                    const sellRange = formatSellThroughRange(sell.range_days);
                    const sellDisplay = sellRange === "—" ? "—" : `~${sellRange}`;
                    const bsrRank = mp
                      ? typeof mp.amazon_rank_overall === "number"
                        ? mp.amazon_rank_overall
                        : mp.amazon_rank_specific
                      : null;
                    const bsrLabel = typeof bsrRank === "number" ? `BSR #${bsrRank}` : "BSR —";
                    const itemImages = rowImagesByItemId.get(it.id) ?? [];
                    const itemPrimaryImage = rowPrimaryImageByItemId.get(it.id);
                    const itemPrimaryUrl = itemPrimaryImage ? tablePreviewUrls[itemPrimaryImage.id] : null;

                    return (
                      <TableRow key={it.id} className="align-top [&>td]:py-2.5">
                        <TableCell>
                          <div className="flex items-start gap-3">
                            <ReferenceThumb url={itemPrimaryUrl ?? mp?.reference_image_url ?? null} alt={mp?.title ?? "Produkt"} />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="min-w-0 truncate font-medium">{mp ? mp.title : it.master_product_id}</div>
                                {mp?.kind ? <Badge variant="secondary">{kindLabel(mp.kind)}</Badge> : null}
                              </div>
                              {mp ? (
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
                              ) : null}
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                                {mp?.sku ? (
                                  <Badge variant="outline" className="font-mono text-[10px]">
                                    {mp.sku}
                                  </Badge>
                                ) : null}
                                {!!itemImages.length ? (
                                  <>
                                    <Badge variant="outline" className="text-[10px]">
                                      {itemImages.length} Foto{itemImages.length === 1 ? "" : "s"}
                                    </Badge>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      className="h-6 px-2 text-[11px]"
                                      onClick={() => setTablePreviewItemId(it.id)}
                                    >
                                      Vorschau
                                    </Button>
                                  </>
                                ) : (
                                  <Badge variant="outline" className="text-[10px] text-gray-400 dark:text-gray-500">
                                    Keine Fotos
                                  </Badge>
                                )}
                              </div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1.5">
                            <Badge variant={inventoryStatusVariant(it.status)}>{inventoryStatusLabel(it.status)}</Badge>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant={av.variant}>{av.label}</Badge>
                              <Badge variant="outline">{conditionLabel(it.condition)}</Badge>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className={OVERVIEW_METRIC_CELL_CLASS}>
                          <div className={OVERVIEW_METRIC_CARD_CLASS}>
                            <div className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                              {typeof market.cents === "number" ? `${formatEur(market.cents)} €` : "—"}
                            </div>
                            <div className="mt-0.5 w-full truncate text-[11px] text-gray-500 dark:text-gray-400">{market.label}</div>
                          </div>
                        </TableCell>
                        <TableCell className={OVERVIEW_METRIC_CELL_CLASS} title="Schätzung aus BSR + Offer-Konkurrenz; echte Verkäufe variieren.">
                          <div className={OVERVIEW_METRIC_CARD_CLASS}>
                            <div className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">{sellDisplay}</div>
                            <div className="mt-0.5 w-full truncate text-[11px] text-gray-500 dark:text-gray-400">
                              {sellThroughSpeedLabel(sell.speed)} · {bsrLabel} · {sellThroughConfidenceLabel(sell.confidence)}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className={OVERVIEW_METRIC_CELL_CLASS} title={feeTitle}>
                          <div className={OVERVIEW_METRIC_CARD_CLASS}>
                            <div
                              className={[
                                "font-semibold tabular-nums",
                                margin === null
                                  ? "text-gray-900 dark:text-gray-100"
                                  : margin >= 0
                                    ? "text-emerald-700 dark:text-emerald-300"
                                    : "text-red-700 dark:text-red-300",
                              ].join(" ")}
                            >
                              {margin === null ? "—" : `${formatEur(margin)} €`}
                            </div>
                            <div className="mt-0.5 w-full truncate text-[11px] text-gray-500 dark:text-gray-400">
                              EK {formatEur(it.purchase_price_cents)} €{hasAllocated ? ` + NK ${formatEur(it.allocated_costs_cents)} €` : ""}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setEditing(it);
                                setEditStorageLocation(it.storage_location ?? "");
                                setEditSerialNumber(it.serial_number ?? "");
                              }}
                            >
                              Bearbeiten
                            </Button>
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
                                    void copyToClipboard(it.id);
                                  }}
                                >
                                  <Copy className="h-4 w-4" />
                                  Artikel-ID kopieren
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={(e) => {
                                    e.preventDefault();
                                    void copyToClipboard(it.master_product_id);
                                  }}
                                >
                                  <Copy className="h-4 w-4" />
                                  Produkt-UUID kopieren
                                </DropdownMenuItem>
                                {mp?.asin ? (
                                  <DropdownMenuItem
                                    onSelect={(e) => {
                                      e.preventDefault();
                                      void copyToClipboard(mp.asin ?? "");
                                    }}
                                  >
                                    <Copy className="h-4 w-4" />
                                    ASIN kopieren
                                  </DropdownMenuItem>
                                ) : null}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!rows.length && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-sm text-gray-500 dark:text-gray-400">
                        Keine Daten.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            ) : (
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
                    const itemImages = rowImagesByItemId.get(it.id) ?? [];
                    const itemPrimaryImage = rowPrimaryImageByItemId.get(it.id);
                    const itemPrimaryUrl = itemPrimaryImage ? tablePreviewUrls[itemPrimaryImage.id] : null;

                    return (
                      <TableRow key={it.id}>
                        <TableCell>
                          <div className="flex items-start gap-3">
                            <ReferenceThumb url={itemPrimaryUrl ?? mp?.reference_image_url ?? null} alt={mp?.title ?? "Produkt"} />

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

                              {mp ? (
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
                              ) : null}

                              {(it.serial_number || it.storage_location) ? (
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {it.serial_number ? <MetaPill label="SN" value={it.serial_number} /> : null}
                                  {it.storage_location ? <MetaPill label="Lager" value={it.storage_location} /> : null}
                                </div>
                              ) : null}

                              {!!itemImages.length && (
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                  <Badge variant="outline">
                                    {itemImages.length} Foto{itemImages.length === 1 ? "" : "s"}
                                  </Badge>
                                  <div className="flex items-center gap-1">
                                    {itemImages.slice(0, 4).map((img) => {
                                      const url = tablePreviewUrls[img.id];
                                      const canPreview = isLikelyImagePath(img.upload_path) && !tablePreviewErrors[img.id];
                                      return (
                                        <button
                                          key={img.id}
                                          type="button"
                                          className="h-8 w-8 overflow-hidden rounded border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
                                          title={img.upload_path}
                                          onClick={() => {
                                            setTablePreviewItemId(it.id);
                                            setTablePreviewImageId(img.id);
                                          }}
                                        >
                                          {url ? (
                                            <img src={url} alt="Artikelbild" className="h-full w-full object-cover" />
                                          ) : canPreview ? (
                                            <div className="h-full w-full animate-pulse bg-gray-100 dark:bg-gray-800" />
                                          ) : (
                                            <div className="flex h-full w-full items-center justify-center text-[9px] text-gray-500 dark:text-gray-400">
                                              Datei
                                            </div>
                                          )}
                                        </button>
                                      );
                                    })}
                                  </div>
                                  <Button size="sm" variant="outline" onClick={() => setTablePreviewItemId(it.id)}>
                                    Vorschau
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => {
                                      for (const img of itemImages) {
                                        void api.download(img.upload_path);
                                      }
                                    }}
                                  >
                                    Alle herunterladen
                                  </Button>
                                </div>
                              )}
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
                          <div className="font-medium tabular-nums">{formatEur(totalCostCents)} €</div>
                          <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                            EK {formatEur(it.purchase_price_cents)} €{hasAllocated ? ` + NK ${formatEur(it.allocated_costs_cents)} €` : ""}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex items-center gap-2">
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
                                    void copyToClipboard(it.id);
                                  }}
                                >
                                  <Copy className="h-4 w-4" />
                                  Artikel-ID kopieren
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={(e) => {
                                    e.preventDefault();
                                    void copyToClipboard(it.master_product_id);
                                  }}
                                >
                                  <Copy className="h-4 w-4" />
                                  Produkt-UUID kopieren
                                </DropdownMenuItem>
                                {mp?.asin ? (
                                  <DropdownMenuItem
                                    onSelect={(e) => {
                                      e.preventDefault();
                                      void copyToClipboard(mp.asin ?? "");
                                    }}
                                  >
                                    <Copy className="h-4 w-4" />
                                    ASIN kopieren
                                  </DropdownMenuItem>
                                ) : null}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
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
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Artikel bearbeiten</DialogTitle>
            <DialogDescription>
              {editing ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="break-all font-mono text-xs text-gray-500 dark:text-gray-400">{editing.id}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void copyToClipboard(editing.id);
                    }}
                  >
                    <Copy className="h-4 w-4" />
                    ID kopieren
                  </Button>
                </div>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
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
              <InlineMessage tone="error">
                {(update.error as Error).message}
              </InlineMessage>
            )}

            <div className="space-y-2">
              <div className="space-y-2">
                <div className="text-sm font-medium">Bilder</div>
                <div
                  className={[
                    "rounded-md border border-dashed p-3 transition-colors",
                    imagesDragOver
                      ? "border-gray-500 bg-gray-100 dark:border-gray-500 dark:bg-gray-900/60"
                      : "border-gray-300 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/30",
                  ].join(" ")}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setImagesDragOver(true);
                  }}
                  onDragLeave={() => setImagesDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setImagesDragOver(false);
                    handleImageFiles(e.dataTransfer.files);
                  }}
                >
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div className="text-sm text-gray-600 dark:text-gray-300">
                      Bilder hier ablegen oder mehrere Dateien auswählen.
                    </div>
                    <Input
                      type="file"
                      className="max-w-xs"
                      multiple
                      disabled={uploadImages.isPending}
                      onChange={(e) => {
                        handleImageFiles(e.target.files);
                        e.currentTarget.value = "";
                      }}
                    />
                  </div>
                  {uploadImages.isPending && (
                    <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                      Upload läuft: {uploadImages.variables?.files.length ?? 0} Datei(en)…
                    </div>
                  )}
                </div>
              </div>

              {(images.isError || uploadImages.isError || removeImage.isError) && (
                <InlineMessage tone="error">
                  {((images.error ?? uploadImages.error ?? removeImage.error) as Error).message}
                </InlineMessage>
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

              <div className="max-h-56 overflow-y-auto rounded-md border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
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
          </div>

          <DialogFooter className="sticky bottom-0 border-t border-gray-200 bg-white pt-4 dark:border-gray-800 dark:bg-gray-900">
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={update.isPending}>
              Schließen
            </Button>
            <Button onClick={() => update.mutate()} disabled={update.isPending}>
              Speichern
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={tablePreviewItemId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTablePreviewItemId(null);
            setTablePreviewImageId(null);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Artikelbilder</DialogTitle>
            <DialogDescription>
              {tablePreviewMasterProduct?.title ?? tablePreviewItem?.id ?? ""}
            </DialogDescription>
          </DialogHeader>

          {!!tablePreviewImages.length && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {tablePreviewImages.map((img) => {
                  const url = tablePreviewUrls[img.id];
                  const isActive = tablePreviewImageId === img.id;
                  const canPreview = isLikelyImagePath(img.upload_path) && !tablePreviewErrors[img.id];
                  return (
                    <button
                      key={img.id}
                      type="button"
                      className={[
                        "relative h-16 w-16 overflow-hidden rounded-md border bg-white shadow-sm",
                        "dark:border-gray-800 dark:bg-gray-900",
                        isActive
                          ? "ring-2 ring-gray-300 dark:ring-gray-700"
                          : "hover:ring-2 hover:ring-gray-200 dark:hover:ring-gray-800",
                      ].join(" ")}
                      onClick={() => setTablePreviewImageId(img.id)}
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

              {tablePreviewImageId && (
                <div className="overflow-hidden rounded-md border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
                  {tablePreviewUrls[tablePreviewImageId] ? (
                    <img
                      src={tablePreviewUrls[tablePreviewImageId]}
                      alt="Artikelbild Vorschau"
                      className="max-h-[50vh] w-full bg-gray-50 object-contain dark:bg-gray-950/40"
                    />
                  ) : (
                    <div className="flex h-48 w-full items-center justify-center bg-gray-50 text-sm text-gray-500 dark:bg-gray-950/40 dark:text-gray-400">
                      Vorschau nicht verfügbar.
                    </div>
                  )}
                  <div className="border-t border-gray-100 p-2 text-xs font-mono text-gray-500 dark:border-gray-800 dark:text-gray-400">
                    {(tablePreviewImages.find((img) => img.id === tablePreviewImageId)?.upload_path ?? "")}
                  </div>
                </div>
              )}

              <div className="max-h-56 overflow-y-auto rounded-md border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Datei</TableHead>
                      <TableHead className="text-right">Aktion</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tablePreviewImages.map((img) => (
                      <TableRow key={img.id}>
                        <TableCell className="font-mono text-xs">{img.upload_path}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="secondary" onClick={() => api.download(img.upload_path)}>
                            Download
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {!tablePreviewImages.length && (
            <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-300">
              Für diesen Artikel sind keine Bilder hinterlegt.
            </div>
          )}

          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                for (const img of tablePreviewImages) {
                  void api.download(img.upload_path);
                }
              }}
              disabled={!tablePreviewImages.length}
            >
              Alle herunterladen
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setTablePreviewItemId(null);
                setTablePreviewImageId(null);
              }}
            >
              Schließen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
