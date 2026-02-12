import { Plus, RefreshCw, Route, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { latLngBounds } from "leaflet";
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap } from "react-leaflet";

import { useApi } from "../lib/api";
import { useTaxProfile } from "../lib/taxProfile";
import { AmazonFeeProfile, estimateFbaPayout, estimateMargin, estimateMarketPriceForInventoryCondition } from "../lib/amazon";
import { formatEur, parseEurToCents } from "../lib/money";
import { paginateItems } from "../lib/pagination";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { InlineMessage } from "../components/ui/inline-message";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PaginationControls } from "../components/ui/pagination-controls";
import { PageHeader } from "../components/ui/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { TABLE_CELL_NUMERIC_CLASS, TABLE_ROW_COMPACT_CLASS } from "../components/ui/table-row-layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";

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

  amazon_price_new_cents?: number | null;
  amazon_price_used_like_new_cents?: number | null;
  amazon_price_used_very_good_cents?: number | null;
  amazon_price_used_good_cents?: number | null;
  amazon_price_used_acceptable_cents?: number | null;
};

type PurchaseOut = {
  id: string;
  kind: string;
  purchase_date: string;
  counterparty_name: string;
  counterparty_address?: string | null;
  counterparty_birthdate?: string | null;
  counterparty_id_number?: string | null;
  source_platform?: string | null;
  listing_url?: string | null;
  notes?: string | null;
  total_amount_cents: number;
  shipping_cost_cents: number;
  buyer_protection_fee_cents: number;
  tax_rate_bp?: number;
  payment_source: string;
  document_number?: string | null;
  pdf_path?: string | null;
  external_invoice_number?: string | null;
  receipt_upload_path?: string | null;
  primary_mileage_log_id?: string | null;
  lines: Array<{
    id: string;
    master_product_id: string;
    condition: string;
    purchase_type: string;
    purchase_price_cents: number;
    market_value_cents?: number | null;
    held_privately_over_12_months?: boolean | null;
    valuation_reason?: string | null;
    shipping_allocated_cents: number;
    buyer_protection_fee_allocated_cents: number;
  }>;
};

type PurchaseAttachmentOut = {
  id: string;
  purchase_id: string;
  purchase_line_id?: string | null;
  upload_path: string;
  original_filename: string;
  kind: string;
  note?: string | null;
  created_at: string;
  updated_at: string;
};

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
  routes?: Array<{
    distance?: number;
    geometry?: {
      coordinates?: Array<[number, number]>;
    };
  }>;
};

type UploadOut = { upload_path: string };

type Line = {
  ui_id: string;
  purchase_line_id?: string;
  master_product_id: string;
  condition: string;
  purchase_price: string;
  market_value: string;
  held_privately_over_12_months: boolean;
  valuation_reason: string;
};

type StagedAttachment = {
  local_id: string;
  file: File;
  file_name: string;
  file_size: number;
  mime_type: string;
  kind: string;
  purchase_line_id?: string;
  note: string;
  status: "queued" | "uploading" | "uploaded" | "error";
  upload_path?: string;
  error?: string;
};

const PURCHASE_KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "PRIVATE_DIFF", label: "Privat (Differenz)" },
  { value: "PRIVATE_EQUITY", label: "Private Sacheinlage (PAIV)" },
  { value: "COMMERCIAL_REGULAR", label: "Gewerblich (Regulär)" },
];

const PAYMENT_SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "CASH", label: "Bar" },
  { value: "BANK", label: "Bank" },
  { value: "PRIVATE_EQUITY", label: "Privateinlage" },
];

const CONDITION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "NEW", label: "Neu" },
  { value: "LIKE_NEW", label: "Wie neu" },
  { value: "GOOD", label: "Gut" },
  { value: "ACCEPTABLE", label: "Akzeptabel" },
  { value: "DEFECT", label: "Defekt" },
];

const PURCHASE_TYPE_LABEL: Record<string, string> = {
  DIFF: "Differenz",
  REGULAR: "Regulär",
};

const MASTER_KIND_OPTIONS: Array<{ value: MasterProductKind; label: string }> = [
  { value: "GAME", label: "Spiel" },
  { value: "CONSOLE", label: "Konsole" },
  { value: "ACCESSORY", label: "Zubehör" },
  { value: "OTHER", label: "Sonstiges" },
];

type SourcePlatformOption = {
  value: string;
  label: string;
  aliases: string[];
  bgClass: string;
  fgClass: string;
  glyph: string;
};

const SOURCE_PLATFORM_OPTIONS: SourcePlatformOption[] = [
  {
    value: "Kleinanzeigen",
    label: "Kleinanzeigen",
    aliases: ["kleinanzeigen", "kleinanzeigen.de", "ebay kleinanzeigen", "ebay-kleinanzeigen", "ebaykleinanzeigen"],
    bgClass: "bg-[#e9ff98]",
    fgClass: "text-[#1f3f2b]",
    glyph: "KA",
  },
  {
    value: "eBay",
    label: "eBay",
    aliases: ["ebay", "ebay.de", "e-bay"],
    bgClass: "bg-[#fff0f0]",
    fgClass: "text-[#b60037]",
    glyph: "eB",
  },
  {
    value: "willhaben.at",
    label: "willhaben.at",
    aliases: ["willhaben", "willhaben.at"],
    bgClass: "bg-[#e8f2ff]",
    fgClass: "text-[#1f4ea8]",
    glyph: "wh",
  },
  {
    value: "Laendleanzeiger.at",
    label: "Laendleanzeiger.at",
    aliases: ["laendleanzeiger", "laendleanzeiger.at", "ländleanzeiger", "ländleanzeiger.at", "landleanzeiger"],
    bgClass: "bg-[#fff0d6]",
    fgClass: "text-[#9a5600]",
    glyph: "LA",
  },
];

const PURCHASE_ATTACHMENT_KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "LISTING", label: "Anzeige" },
  { value: "MARKET_COMP", label: "Marktvergleich" },
  { value: "CHAT", label: "Konversation" },
  { value: "PAYMENT", label: "Zahlung" },
  { value: "DELIVERY", label: "Versand" },
  { value: "OTHER", label: "Sonstiges" },
];

const PLATFORM_NONE = "__NONE__";
const PLATFORM_OTHER = "__OTHER__";
const PURCHASE_TABLE_ACTION_CELL_CLASS = "w-[22rem] text-right align-middle";
const PURCHASE_TABLE_ACTION_GROUP_CLASS = "inline-flex w-full items-center justify-end gap-2";
const PURCHASE_TABLE_DOC_SLOT_CLASS = "flex min-w-[9.5rem] justify-end";
const PURCHASE_TABLE_MAIN_SLOT_CLASS = "flex min-w-[11.5rem] justify-end";
const DEFAULT_MAP_CENTER: GeoPoint = [47.5, 9.74];

function optionLabel(options: Array<{ value: string; label: string }>, value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

function sourcePlatformKey(value: string): string {
  const folded = value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return folded.replace(/[^a-z0-9]+/g, "");
}

function canonicalSourcePlatform(value?: string | null): SourcePlatformOption | null {
  const key = sourcePlatformKey(value ?? "");
  if (!key) return null;
  for (const option of SOURCE_PLATFORM_OPTIONS) {
    if (sourcePlatformKey(option.value) === key) return option;
    for (const alias of option.aliases) {
      if (sourcePlatformKey(alias) === key) return option;
    }
  }
  return null;
}

function SourcePlatformLogo({
  platform,
  size = "md",
}: {
  platform: SourcePlatformOption;
  size?: "sm" | "md";
}) {
  const sizeClass = size === "sm" ? "h-5 w-5 text-[9px]" : "h-6 w-6 text-[10px]";
  return (
    <span
      className={`inline-flex ${sizeClass} items-center justify-center rounded-full border border-gray-200 font-semibold uppercase tracking-tight dark:border-gray-700 ${platform.bgClass} ${platform.fgClass}`}
      title={platform.label}
      aria-label={platform.label}
    >
      {platform.glyph}
    </span>
  );
}

function todayIsoLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateEuFromIso(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? "").trim());
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function parseMoneyInputToCents(input: string): number | null {
  try {
    return parseEurToCents(input);
  } catch {
    return null;
  }
}

function linePurchaseCents(line: Line, isPrivateEquity: boolean): number | null {
  const explicit = parseMoneyInputToCents(line.purchase_price);
  if (explicit !== null) return explicit;
  if (!isPrivateEquity) return null;
  const market = parseMoneyInputToCents(line.market_value);
  if (market === null) return null;
  return Math.floor((market * 85) / 100);
}

function inferAttachmentKind(file: File): string {
  const normalizedName = file.name.toLowerCase();
  if (normalizedName.includes("vergleich") || normalizedName.includes("market-comp") || normalizedName.includes("comp")) return "MARKET_COMP";
  if (normalizedName.includes("chat")) return "CHAT";
  if (normalizedName.includes("zahl") || normalizedName.includes("payment") || normalizedName.includes("paypal")) return "PAYMENT";
  if (normalizedName.includes("versand") || normalizedName.includes("dhl") || normalizedName.includes("hermes")) return "DELIVERY";
  if (normalizedName.includes("anzeige") || normalizedName.includes("listing")) return "LISTING";
  return "OTHER";
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function allocateProportional(totalCents: number, weights: number[]): number[] {
  if (totalCents < 0) return weights.map(() => 0);
  if (!weights.length) return [];

  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? Math.floor(x) : 0));
  const totalWeight = w.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) {
    const base = Math.floor(totalCents / w.length);
    const rem = totalCents - base * w.length;
    const out = w.map(() => base);
    for (let i = 0; i < rem; i++) out[i] += 1;
    return out;
  }

  const shares: number[] = [];
  const remainders: number[] = [];
  let allocated = 0;
  for (const wi of w) {
    const num = totalCents * wi;
    const share = Math.floor(num / totalWeight);
    shares.push(share);
    allocated += share;
    remainders.push(num % totalWeight);
  }

  const remainder = totalCents - allocated;
  if (remainder) {
    const indices = Array.from({ length: w.length }, (_, i) => i).sort((a, b) => remainders[b] - remainders[a]);
    for (const i of indices.slice(0, remainder)) shares[i] += 1;
  }
  return shares;
}

function newLineId(): string {
  try {
    // Available in modern browsers; fine fallback below for older envs.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function masterProductLabel(m: MasterProduct): string {
  return `${m.sku} · ${m.title} · ${m.platform} · ${m.region}${m.variant ? ` · ${m.variant}` : ""}`;
}

function masterProductSearchKey(m: MasterProduct): string {
  return `${m.sku} ${m.title} ${m.platform} ${m.region} ${m.variant} ${m.ean ?? ""} ${m.asin ?? ""} ${m.manufacturer ?? ""} ${m.model ?? ""}`.toLowerCase();
}

function kmFromMetersString(distanceMeters: number): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) return "";
  return (distanceMeters / 1000).toFixed(2);
}

function needsMileageReminder(
  purchase: PurchaseOut,
  linkedPurchaseIds: Set<string>,
  mileageLinksReady: boolean,
): boolean {
  if (purchase.payment_source !== "CASH") return false;
  if (purchase.primary_mileage_log_id) return false;
  if (!mileageLinksReady) return false;
  return !linkedPurchaseIds.has(purchase.id);
}

function kmLabelFromMeters(distanceMeters: number): string {
  return `${(distanceMeters / 1000).toFixed(2)} km`;
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

function MileageRouteMap({ route }: { route: RoutePreview }) {
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

function MasterProductCombobox({
  value,
  options,
  placeholder,
  disabled,
  loading,
  onValueChange,
  onCreateNew,
}: {
  value: string;
  options: MasterProduct[];
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  onValueChange: (id: string) => void;
  onCreateNew?: (seedTitle: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selected = useMemo(() => options.find((m) => m.id === value) ?? null, [options, value]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState<string>(() => (selected ? masterProductLabel(selected) : ""));
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const [menuPos, setMenuPos] = useState<
    | {
        left: number;
        width: number;
        top?: number;
        bottom?: number;
        maxHeight: number;
      }
    | null
  >(null);

  useEffect(() => {
    if (!open) setQ(selected ? masterProductLabel(selected) : "");
  }, [open, selected]);

  useEffect(() => {
    if (!open) {
      setPortalContainer(null);
      return;
    }
    const root = rootRef.current;
    if (!root) {
      setPortalContainer(document.body);
      return;
    }
    const inDialog =
      (root.closest("[data-radix-dialog-content]") as HTMLElement | null) ??
      (root.closest("[role='dialog']") as HTMLElement | null);
    setPortalContainer(inDialog ?? document.body);
  }, [open]);

  useEffect(() => {
    function onPointerDown(ev: PointerEvent) {
      if (!(ev.target instanceof Node)) return;
      const root = rootRef.current;
      const menu = menuRef.current;
      if (root && root.contains(ev.target)) return;
      if (menu && menu.contains(ev.target)) return;
      setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }

    const scrollOpts = { capture: true } as const;

    function compute() {
      const el = inputRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const margin = 6;

      const below = Math.max(0, window.innerHeight - rect.bottom - margin);
      const above = Math.max(0, rect.top - margin);
      const placeBelow = below >= 220 || below >= above;
      const maxHeight = Math.max(160, Math.min(320, placeBelow ? below : above));

      if (placeBelow) {
        setMenuPos({ left: rect.left, top: rect.bottom + margin, width: rect.width, maxHeight });
      } else {
        setMenuPos({ left: rect.left, bottom: window.innerHeight - rect.top + margin, width: rect.width, maxHeight });
      }
    }

    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, scrollOpts);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, scrollOpts);
    };
  }, [open]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    const all = options ?? [];
    if (!query) return all.slice(0, 12);
    const out: MasterProduct[] = [];
    for (const m of all) {
      if (masterProductSearchKey(m).includes(query)) out.push(m);
      if (out.length >= 12) break;
    }
    return out;
  }, [options, q]);

  const canCreate = !!onCreateNew;

  return (
    <div ref={rootRef} className="relative">
      <Input
        ref={inputRef}
        value={q}
        disabled={disabled}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
          }
          if (e.key === "Enter") {
            // Keep Enter from submitting the purchase form accidentally.
            e.preventDefault();
            if (open && results.length) {
              onValueChange(results[0].id);
              setOpen(false);
              return;
            }
          }
        }}
      />

      {open &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            className="z-[70] overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-950"
            style={{
              position: "fixed",
              left: menuPos.left,
              width: menuPos.width,
              top: menuPos.top,
              bottom: menuPos.bottom,
            }}
          >
            <div className="overflow-auto p-1" style={{ maxHeight: menuPos.maxHeight }}>
              {loading && (
                <div className="px-2 py-2 text-xs text-gray-500 dark:text-gray-400">Lade Produkte…</div>
              )}

              {!loading && !results.length && (
                <div className="px-2 py-2 text-xs text-gray-500 dark:text-gray-400">Keine Treffer.</div>
              )}

              {!loading &&
                results.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={[
                      "w-full rounded px-2 py-2 text-left text-sm",
                      "hover:bg-gray-50 dark:hover:bg-gray-900/50",
                      value === m.id ? "bg-gray-50 dark:bg-gray-900/40" : "",
                    ].join(" ")}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onValueChange(m.id);
                      setOpen(false);
                    }}
                  >
                    <div className="font-medium">{m.title}</div>
                    <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                      <span className="font-mono">{m.sku}</span> · {m.platform} · {m.region}
                      {m.variant ? ` · ${m.variant}` : ""}
                    </div>
                    {(m.ean || m.asin) && (
                      <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        <span className="text-gray-500 dark:text-gray-500">EAN:</span>{" "}
                        <span className="font-mono">{m.ean ?? "—"}</span>{" "}
                        <span className="text-gray-500 dark:text-gray-500">ASIN:</span>{" "}
                        <span className="font-mono">{m.asin ?? "—"}</span>
                      </div>
                    )}
                    {(m.manufacturer || m.model) && (
                      <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        {m.manufacturer ?? ""}
                        {m.manufacturer && m.model ? " · " : ""}
                        {m.model ?? ""}
                      </div>
                    )}
                  </button>
                ))}

              <div className="my-1 border-t border-gray-100 dark:border-gray-800" />

              <button
                type="button"
                className="w-full rounded px-2 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-900/50"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onValueChange("");
                  setOpen(false);
                }}
              >
                Auswahl entfernen
              </button>

              <button
                type="button"
                disabled={!canCreate}
                className={[
                  "w-full rounded px-2 py-2 text-left text-sm",
                  canCreate ? "hover:bg-gray-50 dark:hover:bg-gray-900/50" : "cursor-not-allowed opacity-50",
                ].join(" ")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (!onCreateNew) return;
                  onCreateNew(q.trim());
                  setOpen(false);
                }}
              >
                Neues Produkt anlegen{q.trim() ? `: “${q.trim()}”` : ""}
              </button>
            </div>
          </div>,
          portalContainer ?? document.body,
        )}
    </div>
  );
}

export function PurchasesPage() {
  const api = useApi();
  const qc = useQueryClient();
  const taxProfile = useTaxProfile();
  const vatEnabled = taxProfile.data?.vat_enabled ?? true;
  const [formOpen, setFormOpen] = useState(false);
  const [formTab, setFormTab] = useState<"BASICS" | "POSITIONS" | "ATTACHMENTS">("BASICS");

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

  const masterById = useMemo(() => {
    const map = new Map<string, MasterProduct>();
    (master.data ?? []).forEach((m) => map.set(m.id, m));
    return map;
  }, [master.data]);

  const list = useQuery({
    queryKey: ["purchases"],
    queryFn: () => api.request<PurchaseOut[]>("/purchases"),
  });
  const mileageLinks = useQuery({
    queryKey: ["mileage"],
    queryFn: () => api.request<MileageOut[]>("/mileage"),
  });

  const generatePdf = useMutation({
    mutationFn: (purchaseId: string) => api.request<PurchaseOut>(`/purchases/${purchaseId}/generate-pdf`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["purchases"] });
    },
  });
  const reopenPurchase = useMutation({
    mutationFn: (purchaseId: string) => api.request<PurchaseOut>(`/purchases/${purchaseId}/reopen`, { method: "POST" }),
    onSuccess: async (purchase) => {
      await qc.invalidateQueries({ queryKey: ["purchases"] });
      startEdit(purchase);
    },
  });
  const deletePurchases = useMutation({
    mutationFn: async (purchaseIds: string[]) => {
      let deleted = 0;
      const failures: string[] = [];
      for (const purchaseId of purchaseIds) {
        try {
          await api.request<void>(`/purchases/${purchaseId}`, { method: "DELETE" });
          deleted += 1;
        } catch (error) {
          failures.push(`${purchaseId}: ${String((error as Error)?.message ?? "Unbekannter Fehler")}`);
        }
      }
      if (failures.length) {
        throw new Error(
          `Nur ${deleted}/${purchaseIds.length} Einkauf/Einkäufe gelöscht. ${failures[0]}`,
        );
      }
    },
    onSuccess: async (_out, purchaseIds) => {
      if (editingPurchaseId && purchaseIds.includes(editingPurchaseId)) {
        cancelEdit();
        setFormOpen(false);
      }
      setSelectedPurchaseIds((prev) => prev.filter((id) => !purchaseIds.includes(id)));
      await qc.invalidateQueries({ queryKey: ["purchases"] });
      await qc.invalidateQueries({ queryKey: ["mileage"] });
      for (const purchaseId of purchaseIds) {
        await qc.invalidateQueries({ queryKey: ["purchase-mileage", purchaseId] });
        await qc.invalidateQueries({ queryKey: ["purchase-attachments", purchaseId] });
      }
    },
  });

  const [editingPurchaseId, setEditingPurchaseId] = useState<string | null>(null);
  const [kind, setKind] = useState<string>("PRIVATE_DIFF");
  const [purchaseDate, setPurchaseDate] = useState<string>(() => todayIsoLocal());
  const [counterpartyName, setCounterpartyName] = useState("");
  const [counterpartyAddress, setCounterpartyAddress] = useState("");
  const [counterpartyBirthdate, setCounterpartyBirthdate] = useState("");
  const [counterpartyIdNumber, setCounterpartyIdNumber] = useState("");
  const [sourcePlatform, setSourcePlatform] = useState("");
  const [listingUrl, setListingUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [identityFieldsOpen, setIdentityFieldsOpen] = useState(false);
  const [paymentSource, setPaymentSource] = useState<string>("CASH");
  const [totalAmount, setTotalAmount] = useState<string>("0,00");
  const [shippingCost, setShippingCost] = useState<string>("0,00");
  const [buyerProtectionFee, setBuyerProtectionFee] = useState<string>("0,00");
  const [withMileage, setWithMileage] = useState(false);
  const [mileageLogDate, setMileageLogDate] = useState<string>(() => todayIsoLocal());
  const [mileageStartLocation, setMileageStartLocation] = useState("");
  const [mileageDestination, setMileageDestination] = useState("");
  const [mileageKm, setMileageKm] = useState("");
  const [mileagePurposeText, setMileagePurposeText] = useState("");
  const [mileageRoundTrip, setMileageRoundTrip] = useState(false);
  const [mileageRoutePreview, setMileageRoutePreview] = useState<RoutePreview | null>(null);
  const [mileageRouteError, setMileageRouteError] = useState<string | null>(null);
  const [mileageRoutePending, setMileageRoutePending] = useState(false);
  const [mileageSyncError, setMileageSyncError] = useState<string | null>(null);

  const [externalInvoiceNumber, setExternalInvoiceNumber] = useState<string>("");
  const [receiptUploadPath, setReceiptUploadPath] = useState<string>("");
  const [taxRateBp, setTaxRateBp] = useState<string>("2000");
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([]);
  const [stagedAttachmentBulkKind, setStagedAttachmentBulkKind] = useState<string>("OTHER");
  const [stagedAttachmentError, setStagedAttachmentError] = useState<string | null>(null);
  const [isLinkingStagedAttachments, setIsLinkingStagedAttachments] = useState(false);

  const [lines, setLines] = useState<Line[]>([]);

  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [quickCreateTargetLineId, setQuickCreateTargetLineId] = useState<string | null>(null);
  const [quickCreateKind, setQuickCreateKind] = useState<MasterProductKind>("GAME");
  const [quickCreateTitle, setQuickCreateTitle] = useState("");
  const [quickCreatePlatform, setQuickCreatePlatform] = useState("");
  const [quickCreatePlatformMode, setQuickCreatePlatformMode] = useState<"PRESET" | "CUSTOM">("PRESET");
  const [quickCreateRegion, setQuickCreateRegion] = useState("EU");
  const [quickCreateVariant, setQuickCreateVariant] = useState("");
  const [page, setPage] = useState(1);
  const [selectedPurchaseIds, setSelectedPurchaseIds] = useState<string[]>([]);

  const isPrivateDiff = kind === "PRIVATE_DIFF";
  const isPrivateEquity = kind === "PRIVATE_EQUITY";
  const isPrivateKind = isPrivateDiff || isPrivateEquity;
  const purchaseType = isPrivateKind ? "DIFF" : "REGULAR";
  const purchaseDateValid = /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate);

  const totalCentsParsed = useMemo(() => parseMoneyInputToCents(totalAmount), [totalAmount]);
  const shippingCostCentsParsed = useMemo(
    () => (isPrivateDiff ? parseMoneyInputToCents(shippingCost) : 0),
    [isPrivateDiff, shippingCost],
  );
  const buyerProtectionFeeCentsParsed = useMemo(
    () => (isPrivateDiff ? parseMoneyInputToCents(buyerProtectionFee) : 0),
    [isPrivateDiff, buyerProtectionFee],
  );

  const totalCents = totalCentsParsed ?? 0;
  const shippingCostCents = shippingCostCentsParsed ?? 0;
  const buyerProtectionFeeCents = buyerProtectionFeeCentsParsed ?? 0;
  const extraCostsCents = shippingCostCents + buyerProtectionFeeCents;
  const totalPaidCents = totalCents + extraCostsCents;
  const extraCostsValid =
    shippingCostCentsParsed !== null &&
    buyerProtectionFeeCentsParsed !== null &&
    shippingCostCents >= 0 &&
    buyerProtectionFeeCents >= 0;

  const sumLinesCents = useMemo(() => {
    let sum = 0;
    for (const l of lines) {
      const cents = linePurchaseCents(l, isPrivateEquity);
      if (cents === null) {
        return null;
      }
      sum += cents;
    }
    return sum;
  }, [isPrivateEquity, lines]);

  const splitOk = sumLinesCents !== null && sumLinesCents === totalCents;
  const allLinesHaveProduct = lines.every((l) => !!l.master_product_id.trim());
  const paivLinesValid = !isPrivateEquity || lines.every((l) => parseMoneyInputToCents(l.market_value) !== null);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.request<UploadOut>("/uploads", { method: "POST", body: fd });
    },
    onSuccess: (r) => setReceiptUploadPath(r.upload_path),
  });

  const purchaseAttachments = useQuery({
    queryKey: ["purchase-attachments", editingPurchaseId],
    enabled: !!editingPurchaseId,
    queryFn: () => api.request<PurchaseAttachmentOut[]>(`/purchases/${editingPurchaseId!}/attachments`),
  });

  const purchaseMileage = useQuery({
    queryKey: ["purchase-mileage", editingPurchaseId],
    enabled: !!editingPurchaseId,
    queryFn: () => api.request<MileageOut | null>(`/purchases/${editingPurchaseId!}/mileage`),
  });

  const deletePurchaseAttachment = useMutation({
    mutationFn: ({ purchaseId, attachmentId }: { purchaseId: string; attachmentId: string }) =>
      api.request<void>(`/purchases/${purchaseId}/attachments/${attachmentId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["purchase-attachments", editingPurchaseId] });
    },
  });

  async function uploadStagedAttachment(localId: string, file: File): Promise<void> {
    setStagedAttachments((prev) =>
      prev.map((item) =>
        item.local_id === localId
          ? { ...item, status: "uploading", error: undefined, upload_path: undefined }
          : item,
      ),
    );
    try {
      const fd = new FormData();
      fd.append("file", file);
      const out = await api.request<UploadOut>("/uploads", { method: "POST", body: fd });
      setStagedAttachments((prev) =>
        prev.map((item) =>
          item.local_id === localId
            ? { ...item, status: "uploaded", upload_path: out.upload_path, error: undefined }
            : item,
        ),
      );
    } catch (error) {
      setStagedAttachments((prev) =>
        prev.map((item) =>
          item.local_id === localId
            ? {
                ...item,
                status: "error",
                error: (error as Error)?.message ?? "Upload fehlgeschlagen",
                upload_path: undefined,
              }
            : item,
        ),
      );
    }
  }

  async function stageAttachmentFiles(files: File[]): Promise<void> {
    if (!files.length) return;
    setStagedAttachmentError(null);
    const staged = files.map((file) => ({
      local_id: newLineId(),
      file,
      file_name: file.name,
      file_size: file.size,
      mime_type: file.type,
      kind: inferAttachmentKind(file),
      purchase_line_id: undefined,
      note: "",
      status: "queued" as const,
    }));
    setStagedAttachments((prev) => [...prev, ...staged]);
    await Promise.all(staged.map((entry) => uploadStagedAttachment(entry.local_id, entry.file)));
  }

  async function linkStagedAttachmentsToPurchase(purchaseId: string): Promise<void> {
    const ready = stagedAttachments.filter((item) => item.status === "uploaded" && !!item.upload_path);
    if (!ready.length) return;

    setIsLinkingStagedAttachments(true);
    setStagedAttachmentError(null);
    try {
      const invalidMarketComp = ready.find((item) => item.kind === "MARKET_COMP" && !item.purchase_line_id);
      if (invalidMarketComp) {
        throw new Error("MARKET_COMP benötigt eine zugeordnete Position.");
      }
      const payload = ready.map((item) => ({
        upload_path: item.upload_path!,
        purchase_line_id: item.purchase_line_id ?? null,
        original_filename: item.file_name,
        kind: item.kind,
        note: item.note.trim() ? item.note.trim() : null,
      }));
      for (const chunk of chunkArray(payload, 30)) {
        await api.request<PurchaseAttachmentOut[]>(`/purchases/${purchaseId}/attachments`, {
          method: "POST",
          json: { attachments: chunk },
        });
      }
      setStagedAttachments((prev) => prev.filter((item) => !(item.status === "uploaded" && item.upload_path)));
      await qc.invalidateQueries({ queryKey: ["purchase-attachments", purchaseId] });
    } finally {
      setIsLinkingStagedAttachments(false);
    }
  }

  async function syncPurchaseMileageForPurchase(
    purchaseId: string,
    options?: { deleteIfDisabled?: boolean },
  ): Promise<void> {
    setMileageSyncError(null);
    if (!withMileage) {
      if (options?.deleteIfDisabled) {
        await api.request<void>(`/purchases/${purchaseId}/mileage`, { method: "DELETE" });
      }
      return;
    }
    if (!mileageInputValid) {
      throw new Error("Fahrt unvollständig: Datum, Start, Ziel und km > 0 erforderlich.");
    }
    await api.request<MileageOut>(`/purchases/${purchaseId}/mileage`, {
      method: "PUT",
      json: {
        log_date: mileageLogDate,
        start_location: mileageStartLocation.trim(),
        destination: mileageDestination.trim(),
        km: mileageKmNormalized,
        purpose_text: mileagePurposeText.trim() ? mileagePurposeText.trim() : null,
      },
    });
  }

  async function calculateMileageRoute(): Promise<void> {
    if (!mileageStartLocation.trim() || !mileageDestination.trim()) {
      setMileageRouteError("Bitte Start und Ziel ausfüllen.");
      return;
    }

    setMileageRouteError(null);
    setMileageRoutePending(true);
    try {
      const [startPoint, destinationPoint] = await Promise.all([
        geocodeAddress(mileageStartLocation.trim()),
        geocodeAddress(mileageDestination.trim()),
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

      setMileageRoutePreview({
        start: startPoint,
        destination: destinationPoint,
        polyline,
        oneWayMeters,
      });

      const distanceMeters = mileageRoundTrip ? oneWayMeters * 2 : oneWayMeters;
      setMileageKm(kmFromMetersString(distanceMeters));
    } catch (error) {
      setMileageRoutePreview(null);
      setMileageRouteError((error as Error)?.message ?? "Route konnte nicht berechnet werden");
    } finally {
      setMileageRoutePending(false);
    }
  }

  const create = useMutation({
    mutationFn: async () => {
      if (!purchaseDateValid) throw new Error("Datum fehlt");
      if (counterpartyBirthdate && !/^\d{4}-\d{2}-\d{2}$/.test(counterpartyBirthdate)) {
        throw new Error("Geburtsdatum muss als Datum gesetzt sein");
      }
      const payload = {
        kind,
        purchase_date: purchaseDate,
        counterparty_name: counterpartyName,
        counterparty_address: counterpartyAddress || null,
        counterparty_birthdate: isPrivateKind ? counterpartyBirthdate || null : null,
        counterparty_id_number:
          isPrivateKind ? (counterpartyIdNumber.trim() ? counterpartyIdNumber.trim() : null) : null,
        source_platform: isPrivateDiff ? (sourcePlatform.trim() ? sourcePlatform.trim() : null) : null,
        listing_url: isPrivateDiff ? (listingUrl.trim() ? listingUrl.trim() : null) : null,
        notes: isPrivateKind ? (notes.trim() ? notes.trim() : null) : null,
        total_amount_cents: totalCents,
        shipping_cost_cents: isPrivateDiff ? shippingCostCents : 0,
        buyer_protection_fee_cents: isPrivateDiff ? buyerProtectionFeeCents : 0,
        tax_rate_bp: kind === "COMMERCIAL_REGULAR" ? (vatEnabled ? Number(taxRateBp) : 0) : 0,
        payment_source: isPrivateEquity ? "PRIVATE_EQUITY" : paymentSource,
        external_invoice_number: kind === "COMMERCIAL_REGULAR" ? externalInvoiceNumber : null,
        receipt_upload_path: kind === "COMMERCIAL_REGULAR" ? receiptUploadPath : null,
        lines: lines.map((l) => ({
          master_product_id: l.master_product_id,
          condition: l.condition,
          purchase_type: purchaseType,
          purchase_price_cents: parseMoneyInputToCents(l.purchase_price),
          market_value_cents: isPrivateEquity ? parseMoneyInputToCents(l.market_value) : null,
          held_privately_over_12_months: isPrivateEquity ? l.held_privately_over_12_months : null,
          valuation_reason: isPrivateEquity ? (l.valuation_reason.trim() ? l.valuation_reason.trim() : null) : null,
        })),
      };
      return api.request<PurchaseOut>("/purchases", { method: "POST", json: payload });
    },
    onSuccess: async (created) => {
      if (isPrivateDiff) {
        try {
          await linkStagedAttachmentsToPurchase(created.id);
        } catch (error) {
          setStagedAttachmentError((error as Error)?.message ?? "Anhaenge konnten nicht verknuepft werden");
          setEditingPurchaseId(created.id);
          setFormOpen(true);
          setFormTab("ATTACHMENTS");
          await qc.invalidateQueries({ queryKey: ["purchases"] });
          return;
        }
      } else if (isPrivateEquity && stagedReadyCount > 0) {
        setStagedAttachmentError("Bitte Einkauf erneut öffnen und MARKET_COMP-Dateien einer Position zuordnen.");
        startEdit(created);
        setFormTab("ATTACHMENTS");
        await qc.invalidateQueries({ queryKey: ["purchases"] });
        return;
      }
      try {
        await syncPurchaseMileageForPurchase(created.id);
      } catch (error) {
        setMileageSyncError((error as Error)?.message ?? "Fahrt konnte nicht gespeichert werden");
        setEditingPurchaseId(created.id);
        setFormOpen(true);
        setFormTab("BASICS");
        await qc.invalidateQueries({ queryKey: ["purchases"] });
        await qc.invalidateQueries({ queryKey: ["purchase-mileage", created.id] });
        return;
      }
      resetFormDraft();
      setFormOpen(false);
      await qc.invalidateQueries({ queryKey: ["purchases"] });
      await qc.invalidateQueries({ queryKey: ["mileage"] });
    },
  });

  const update = useMutation({
    mutationFn: async () => {
      if (!editingPurchaseId) throw new Error("Kein Einkauf ausgewählt");
      if (!purchaseDateValid) throw new Error("Datum fehlt");
      if (counterpartyBirthdate && !/^\d{4}-\d{2}-\d{2}$/.test(counterpartyBirthdate)) {
        throw new Error("Geburtsdatum muss als Datum gesetzt sein");
      }
      const payload = {
        kind,
        purchase_date: purchaseDate,
        counterparty_name: counterpartyName,
        counterparty_address: counterpartyAddress || null,
        counterparty_birthdate: isPrivateKind ? counterpartyBirthdate || null : null,
        counterparty_id_number:
          isPrivateKind ? (counterpartyIdNumber.trim() ? counterpartyIdNumber.trim() : null) : null,
        source_platform: isPrivateDiff ? (sourcePlatform.trim() ? sourcePlatform.trim() : null) : null,
        listing_url: isPrivateDiff ? (listingUrl.trim() ? listingUrl.trim() : null) : null,
        notes: isPrivateKind ? (notes.trim() ? notes.trim() : null) : null,
        total_amount_cents: totalCents,
        shipping_cost_cents: isPrivateDiff ? shippingCostCents : 0,
        buyer_protection_fee_cents: isPrivateDiff ? buyerProtectionFeeCents : 0,
        tax_rate_bp: kind === "COMMERCIAL_REGULAR" ? (vatEnabled ? Number(taxRateBp) : 0) : 0,
        payment_source: isPrivateEquity ? "PRIVATE_EQUITY" : paymentSource,
        external_invoice_number: kind === "COMMERCIAL_REGULAR" ? externalInvoiceNumber : null,
        receipt_upload_path: kind === "COMMERCIAL_REGULAR" ? receiptUploadPath : null,
        lines: lines.map((l) => ({
          id: l.purchase_line_id ?? null,
          master_product_id: l.master_product_id,
          condition: l.condition,
          purchase_type: purchaseType,
          purchase_price_cents: parseMoneyInputToCents(l.purchase_price),
          market_value_cents: isPrivateEquity ? parseMoneyInputToCents(l.market_value) : null,
          held_privately_over_12_months: isPrivateEquity ? l.held_privately_over_12_months : null,
          valuation_reason: isPrivateEquity ? (l.valuation_reason.trim() ? l.valuation_reason.trim() : null) : null,
        })),
      };
      return api.request<PurchaseOut>(`/purchases/${editingPurchaseId}`, { method: "PUT", json: payload });
    },
    onSuccess: async (updatedPurchase) => {
      if (isPrivateKind) {
        try {
          await linkStagedAttachmentsToPurchase(updatedPurchase.id);
        } catch (error) {
          setStagedAttachmentError((error as Error)?.message ?? "Anhaenge konnten nicht verknuepft werden");
          setFormTab("ATTACHMENTS");
          setFormOpen(true);
          await qc.invalidateQueries({ queryKey: ["purchases"] });
          return;
        }
      }
      try {
        await syncPurchaseMileageForPurchase(updatedPurchase.id, { deleteIfDisabled: true });
      } catch (error) {
        setMileageSyncError((error as Error)?.message ?? "Fahrt konnte nicht gespeichert werden");
        setFormTab("BASICS");
        setFormOpen(true);
        await qc.invalidateQueries({ queryKey: ["purchases"] });
        await qc.invalidateQueries({ queryKey: ["purchase-mileage", updatedPurchase.id] });
        return;
      }
      resetFormDraft();
      setFormOpen(false);
      await qc.invalidateQueries({ queryKey: ["purchases"] });
      await qc.invalidateQueries({ queryKey: ["mileage"] });
    },
  });

  const quickCreate = useMutation({
    mutationFn: async () => {
      if (!quickCreateTitle.trim()) throw new Error("Titel fehlt");
      if (!quickCreatePlatform.trim()) throw new Error("Plattform fehlt");
      if (!quickCreateRegion.trim()) throw new Error("Region fehlt");
      return api.request<MasterProduct>("/master-products", {
        method: "POST",
        json: {
          kind: quickCreateKind,
          title: quickCreateTitle.trim(),
          platform: quickCreatePlatform.trim(),
          region: quickCreateRegion.trim(),
          variant: quickCreateVariant.trim(),
        },
      });
    },
    onSuccess: async (mp) => {
      qc.setQueryData<MasterProduct[]>(["master-products"], (old) => {
        const prev = old ?? [];
        if (prev.some((x) => x.id === mp.id)) return prev;
        return [...prev, mp];
      });
      await qc.invalidateQueries({ queryKey: ["master-products"] });
      setQuickCreateOpen(false);
      if (quickCreateTargetLineId) {
        setLines((s) => s.map((l) => (l.ui_id === quickCreateTargetLineId ? { ...l, master_product_id: mp.id } : l)));
      }
      setQuickCreateTargetLineId(null);
      setQuickCreateTitle("");
      setQuickCreatePlatformMode("PRESET");
      setQuickCreateVariant("");
    },
  });

  const mileageKmNormalized = mileageKm.trim().replace(",", ".");
  const mileageKmValue = mileageKmNormalized ? Number(mileageKmNormalized) : NaN;
  const mileageDateValid = /^\d{4}-\d{2}-\d{2}$/.test(mileageLogDate);
  const mileageInputValid =
    !withMileage ||
    (mileageDateValid &&
      !!mileageStartLocation.trim() &&
      !!mileageDestination.trim() &&
      Number.isFinite(mileageKmValue) &&
      mileageKmValue > 0);

  const canSubmit =
    purchaseDateValid &&
    counterpartyName.trim() &&
    lines.length > 0 &&
    allLinesHaveProduct &&
    splitOk &&
    totalCentsParsed !== null &&
    (!isPrivateDiff || extraCostsValid) &&
    (kind !== "COMMERCIAL_REGULAR" || (externalInvoiceNumber.trim() && receiptUploadPath.trim())) &&
    paivLinesValid &&
    mileageInputValid;

  const platformOptions = useMemo(() => {
    const set = new Set<string>();
    for (const m of master.data ?? []) {
      if (m.platform?.trim()) set.add(m.platform.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [master.data]);

  const sourcePlatformOptions = SOURCE_PLATFORM_OPTIONS;
  const sourcePlatformSelectValue = sourcePlatform.trim() ? sourcePlatform.trim() : PLATFORM_NONE;

  const quickCreatePlatformSelectValue =
    quickCreatePlatformMode === "CUSTOM"
      ? PLATFORM_OTHER
      : quickCreatePlatform.trim()
        ? quickCreatePlatform.trim()
        : PLATFORM_NONE;

  const purchaseRows = list.data ?? [];
  const pagedPurchases = useMemo(() => paginateItems(purchaseRows, page), [purchaseRows, page]);
  const selectedPurchaseIdSet = useMemo(() => new Set(selectedPurchaseIds), [selectedPurchaseIds]);
  const selectedPurchaseCount = selectedPurchaseIds.length;
  const pagedPurchaseIds = useMemo(() => pagedPurchases.items.map((purchase) => purchase.id), [pagedPurchases.items]);
  const allCurrentPageSelected = pagedPurchaseIds.length > 0 && pagedPurchaseIds.every((id) => selectedPurchaseIdSet.has(id));
  const mileageLinkedPurchaseIds = useMemo(() => {
    const ids = new Set<string>();
    for (const log of mileageLinks.data ?? []) {
      for (const purchaseId of log.purchase_ids ?? []) {
        ids.add(purchaseId);
      }
    }
    return ids;
  }, [mileageLinks.data]);
  const mileageLinksReady = mileageLinks.isSuccess;

  useEffect(() => {
    if (!isPrivateKind && formTab === "ATTACHMENTS") {
      setFormTab("BASICS");
    }
  }, [formTab, isPrivateKind]);

  useEffect(() => {
    if (!mileageRoutePreview) return;
    const computedMeters = mileageRoundTrip ? mileageRoutePreview.oneWayMeters * 2 : mileageRoutePreview.oneWayMeters;
    setMileageKm(kmFromMetersString(computedMeters));
  }, [mileageRoutePreview, mileageRoundTrip]);

  useEffect(() => {
    setMileageRoutePreview(null);
    setMileageRouteError(null);
  }, [mileageStartLocation, mileageDestination]);

  useEffect(() => {
    if (withMileage) return;
    setMileageRoundTrip(false);
    setMileageRoutePreview(null);
    setMileageRouteError(null);
    setMileageRoutePending(false);
  }, [withMileage]);

  useEffect(() => {
    if (page !== pagedPurchases.page) setPage(pagedPurchases.page);
  }, [page, pagedPurchases.page]);

  useEffect(() => {
    const availableIds = new Set(purchaseRows.map((purchase) => purchase.id));
    setSelectedPurchaseIds((prev) => prev.filter((id) => availableIds.has(id)));
  }, [purchaseRows]);

  useEffect(() => {
    if (editingPurchaseId) return;
    if (!withMileage) setMileageLogDate(purchaseDate);
  }, [editingPurchaseId, purchaseDate, withMileage]);

  useEffect(() => {
    if (!editingPurchaseId || !purchaseMileage.isSuccess) return;
    const linked = purchaseMileage.data;
    if (!linked) {
      setWithMileage(false);
      setMileageLogDate(purchaseDate);
      setMileageStartLocation("");
      setMileageDestination("");
      setMileageKm("");
      setMileagePurposeText("");
      setMileageRoundTrip(false);
      setMileageRoutePreview(null);
      setMileageRouteError(null);
      setMileageRoutePending(false);
      return;
    }
    setWithMileage(true);
    setMileageLogDate(linked.log_date);
    setMileageStartLocation(linked.start_location);
    setMileageDestination(linked.destination);
    setMileageKm(kmFromMetersString(linked.distance_meters));
    setMileagePurposeText(linked.purpose_text ?? "");
    setMileageRoundTrip(false);
    setMileageRoutePreview(null);
    setMileageRouteError(null);
    setMileageRoutePending(false);
  }, [editingPurchaseId, purchaseDate, purchaseMileage.data, purchaseMileage.isSuccess]);

  const stagedUploadCount = stagedAttachments.length;
  const stagedReadyCount = stagedAttachments.filter((item) => item.status === "uploaded" && item.upload_path).length;
  const stagedUploadingCount = stagedAttachments.filter((item) => item.status === "uploading").length;
  const stagedQueuedCount = stagedAttachments.filter((item) => item.status === "queued").length;
  const stagedErrorCount = stagedAttachments.filter((item) => item.status === "error").length;
  const paivComplianceWarnings = useMemo(() => {
    if (!isPrivateEquity) return [] as string[];
    const marketCompByLine = new Map<string, number>();
    for (const attachment of purchaseAttachments.data ?? []) {
      if (attachment.kind !== "MARKET_COMP" || !attachment.purchase_line_id) continue;
      marketCompByLine.set(attachment.purchase_line_id, (marketCompByLine.get(attachment.purchase_line_id) ?? 0) + 1);
    }
    for (const attachment of stagedAttachments) {
      if (attachment.kind !== "MARKET_COMP" || !attachment.purchase_line_id || attachment.status !== "uploaded") continue;
      marketCompByLine.set(attachment.purchase_line_id, (marketCompByLine.get(attachment.purchase_line_id) ?? 0) + 1);
    }
    const warnings: string[] = [];
    for (const line of lines) {
      const title = masterById.get(line.master_product_id)?.title ?? "Unbekannt";
      const lineId = line.purchase_line_id ?? line.ui_id;
      const count = marketCompByLine.get(lineId) ?? 0;
      if (count < 3) warnings.push(`${title}: nur ${count} Marktvergleich(e) verknüpft.`);
      if (!line.held_privately_over_12_months) warnings.push(`${title}: 12-Monats-Besitz nicht bestätigt.`);
    }
    return warnings;
  }, [isPrivateEquity, lines, masterById, purchaseAttachments.data, stagedAttachments]);
  const lineSelectOptions = useMemo(
    () =>
      lines
        .filter((line) => !!line.purchase_line_id)
        .map((line) => ({
          value: line.purchase_line_id!,
          label: masterById.get(line.master_product_id)?.title ?? line.purchase_line_id!,
        })),
    [lines, masterById],
  );

  useEffect(() => {
    if (isPrivateEquity) {
      setPaymentSource("PRIVATE_EQUITY");
    } else if (paymentSource === "PRIVATE_EQUITY") {
      setPaymentSource("CASH");
    }
  }, [isPrivateEquity, paymentSource]);

  function openQuickCreate(lineId: string, seedTitle: string) {
    const lastSelected = [...lines]
      .reverse()
      .map((l) => master.data?.find((m) => m.id === l.master_product_id) ?? null)
      .find((m) => m !== null);

    setQuickCreateTargetLineId(lineId);
    setQuickCreateKind(lastSelected?.kind ?? "GAME");
    setQuickCreateTitle(seedTitle.trim());
    setQuickCreatePlatform(lastSelected?.platform ?? "");
    setQuickCreatePlatformMode(
      lastSelected?.platform && platformOptions.includes(lastSelected.platform) ? "PRESET" : "CUSTOM",
    );
    setQuickCreateRegion(lastSelected?.region ?? "EU");
    setQuickCreateVariant("");
    quickCreate.reset();
    setQuickCreateOpen(true);
  }

  function resetFormDraft() {
    setEditingPurchaseId(null);
    setKind("PRIVATE_DIFF");
    setFormTab("BASICS");
    setPurchaseDate(todayIsoLocal());
    setCounterpartyName("");
    setCounterpartyAddress("");
    setCounterpartyBirthdate("");
    setCounterpartyIdNumber("");
    setSourcePlatform("");
    setListingUrl("");
    setNotes("");
    setIdentityFieldsOpen(false);
    setPaymentSource("CASH");
    setTotalAmount("0,00");
    setShippingCost("0,00");
    setBuyerProtectionFee("0,00");
    setWithMileage(false);
    setMileageLogDate(todayIsoLocal());
    setMileageStartLocation("");
    setMileageDestination("");
    setMileageKm("");
    setMileagePurposeText("");
    setMileageRoundTrip(false);
    setMileageRoutePreview(null);
    setMileageRouteError(null);
    setMileageRoutePending(false);
    setMileageSyncError(null);
    setExternalInvoiceNumber("");
    setReceiptUploadPath("");
    setTaxRateBp("2000");
    setStagedAttachmentBulkKind("OTHER");
    setStagedAttachments([]);
    setStagedAttachmentError(null);
    setLines([]);
    create.reset();
    update.reset();
  }

  function startEdit(p: PurchaseOut) {
    setEditingPurchaseId(p.id);
    setFormTab("BASICS");
    setKind(p.kind);
    setPurchaseDate(p.purchase_date);
    setCounterpartyName(p.counterparty_name);
    setCounterpartyAddress(p.counterparty_address ?? "");
    setCounterpartyBirthdate(p.counterparty_birthdate ?? "");
    setCounterpartyIdNumber(p.counterparty_id_number ?? "");
    setSourcePlatform(canonicalSourcePlatform(p.source_platform)?.value ?? "");
    setListingUrl(p.listing_url ?? "");
    setNotes(p.notes ?? "");
    setIdentityFieldsOpen(false);
    setPaymentSource(p.payment_source);
    setTotalAmount(formatEur(p.total_amount_cents));
    setShippingCost(formatEur(p.shipping_cost_cents ?? 0));
    setBuyerProtectionFee(formatEur(p.buyer_protection_fee_cents ?? 0));
    setWithMileage(false);
    setMileageLogDate(p.purchase_date);
    setMileageStartLocation("");
    setMileageDestination("");
    setMileageKm("");
    setMileagePurposeText("");
    setMileageRoundTrip(false);
    setMileageRoutePreview(null);
    setMileageRouteError(null);
    setMileageRoutePending(false);
    setMileageSyncError(null);
    setExternalInvoiceNumber(p.external_invoice_number ?? "");
    setReceiptUploadPath(p.receipt_upload_path ?? "");
    setTaxRateBp(String(p.tax_rate_bp ?? 2000));
    setStagedAttachmentBulkKind("OTHER");
    setStagedAttachments([]);
    setStagedAttachmentError(null);
    setLines(
      (p.lines ?? []).map((pl) => ({
        ui_id: pl.id,
        purchase_line_id: pl.id,
        master_product_id: pl.master_product_id,
        condition: pl.condition,
        purchase_price: formatEur(pl.purchase_price_cents),
        market_value: formatEur(pl.market_value_cents ?? 0),
        held_privately_over_12_months: !!pl.held_privately_over_12_months,
        valuation_reason: pl.valuation_reason ?? "",
      })),
    );
    create.reset();
    update.reset();
    setFormOpen(true);
  }

  function cancelEdit() {
    resetFormDraft();
  }

  function openCreateForm() {
    cancelEdit();
    setFormOpen(true);
  }

  function hasDraftChanges(): boolean {
    if (stagedAttachments.length) return true;
    if (editingPurchaseId) return false;
    if (withMileage) return true;
    if (mileageStartLocation.trim()) return true;
    if (mileageDestination.trim()) return true;
    if (mileageKm.trim()) return true;
    if (mileagePurposeText.trim()) return true;
    if (lines.length) return true;
    if (counterpartyName.trim()) return true;
    if (counterpartyAddress.trim()) return true;
    if (counterpartyBirthdate.trim()) return true;
    if (counterpartyIdNumber.trim()) return true;
    if (sourcePlatform.trim()) return true;
    if (listingUrl.trim()) return true;
    if (notes.trim()) return true;
    if (externalInvoiceNumber.trim()) return true;
    if (receiptUploadPath.trim()) return true;
    if (totalAmount !== "0,00") return true;
    if (shippingCost !== "0,00") return true;
    if (buyerProtectionFee !== "0,00") return true;
    return false;
  }

  function closeForm() {
    if (hasDraftChanges()) {
      const shouldClose = window.confirm(
        "Ungespeicherte Eingaben oder nicht verknuepfte Uploads gehen verloren. Trotzdem schliessen?",
      );
      if (!shouldClose) return;
    }
    cancelEdit();
    setFormOpen(false);
  }

  function togglePurchaseSelection(purchaseId: string): void {
    setSelectedPurchaseIds((prev) => (prev.includes(purchaseId) ? prev.filter((id) => id !== purchaseId) : [...prev, purchaseId]));
  }

  function toggleCurrentPageSelection(nextChecked: boolean): void {
    setSelectedPurchaseIds((prev) => {
      const prevSet = new Set(prev);
      if (nextChecked) {
        for (const purchaseId of pagedPurchaseIds) prevSet.add(purchaseId);
      } else {
        for (const purchaseId of pagedPurchaseIds) prevSet.delete(purchaseId);
      }
      return Array.from(prevSet);
    });
  }

  function requestDeleteSelectedPurchases(): void {
    if (!selectedPurchaseCount) return;
    const confirmed = window.confirm(
      `${selectedPurchaseCount} ausgewählte Einkauf/Einkäufe wirklich löschen?\n\nDer Vorgang ist dauerhaft. Löschen ist nur möglich, wenn die zugehörigen Lagerpositionen noch verfügbar sind.`,
    );
    if (!confirmed) return;
    const selectedIds = [...selectedPurchaseIds];
    deletePurchases.mutate(selectedIds);
  }

  async function handleStageFileInput(fileList: FileList | null): Promise<void> {
    const files = Array.from(fileList ?? []);
    await stageAttachmentFiles(files);
  }

  async function handleRetryStagedUpload(localId: string): Promise<void> {
    const target = stagedAttachments.find((item) => item.local_id === localId);
    if (!target) return;
    await uploadStagedAttachment(localId, target.file);
  }

  function applyBulkAttachmentKindToStaged(): void {
    setStagedAttachments((prev) => prev.map((item) => ({ ...item, kind: stagedAttachmentBulkKind })));
  }

  async function persistStagedAttachmentsNow(): Promise<void> {
    if (!editingPurchaseId) {
      setStagedAttachmentError("Einkauf zuerst speichern, danach koennen die Anhaenge verknuepft werden.");
      return;
    }
    try {
      await linkStagedAttachmentsToPurchase(editingPurchaseId);
    } catch (error) {
      setStagedAttachmentError((error as Error)?.message ?? "Anhaenge konnten nicht verknuepft werden");
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Einkäufe"
        description="Einkäufe erfassen, Belege hochladen und Eigenbelege als PDF erstellen."
        actions={
          <>
            <Button variant="secondary" className="w-full sm:w-auto" onClick={() => list.refetch()} disabled={list.isFetching}>
              <RefreshCw className="h-4 w-4" />
              Aktualisieren
            </Button>
            <Button className="w-full sm:w-auto" onClick={openCreateForm}>
              <Plus className="h-4 w-4" />
              {editingPurchaseId ? "Neuer Einkauf" : "Einkauf erfassen"}
            </Button>
          </>
        }
        actionsClassName="w-full sm:w-auto"
      />

      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div className="flex flex-col gap-1">
              <CardTitle>Historie</CardTitle>
              <CardDescription>
                {list.isPending ? "Lade…" : `${purchaseRows.length} Einkäufe`}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center justify-start gap-2 rounded-lg border border-gray-200 bg-gray-50/70 p-2 dark:border-gray-800 dark:bg-gray-900/40">
              <div className="px-1 text-xs text-gray-600 dark:text-gray-300">
                {selectedPurchaseCount ? `${selectedPurchaseCount} ausgewählt` : "Keine Auswahl"}
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => toggleCurrentPageSelection(!allCurrentPageSelected)}
                disabled={!pagedPurchaseIds.length || deletePurchases.isPending}
              >
                {allCurrentPageSelected ? "Seite abwählen" : "Seite auswählen"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setSelectedPurchaseIds([])}
                disabled={!selectedPurchaseCount || deletePurchases.isPending}
              >
                Auswahl aufheben
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={requestDeleteSelectedPurchases}
                disabled={!selectedPurchaseCount || deletePurchases.isPending}
              >
                <Trash2 className="h-4 w-4" />
                {deletePurchases.isPending ? "Lösche…" : "Ausgewählte löschen"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">

          {list.isError && (
            <InlineMessage tone="error">
              {(list.error as Error).message}
            </InlineMessage>
          )}
          {(generatePdf.isError || reopenPurchase.isError || deletePurchases.isError) && (
            <InlineMessage tone="error">
              {String(
                (
                  (generatePdf.error as Error) ??
                  (reopenPurchase.error as Error) ??
                  (deletePurchases.error as Error)
                )?.message ?? "Unbekannter Fehler",
              )}
            </InlineMessage>
          )}

          <div className="space-y-2 md:hidden">
            {list.isPending &&
              Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={`skel-p-${i}`}
                  className="animate-pulse rounded-md border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-800 dark:bg-gray-900"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-2">
                      <div className="h-4 w-36 rounded bg-gray-200 dark:bg-gray-800" />
                      <div className="h-3 w-56 rounded bg-gray-100 dark:bg-gray-800" />
                      <div className="h-3 w-40 rounded bg-gray-100 dark:bg-gray-800" />
                    </div>
                    <div className="space-y-2 text-right">
                      <div className="h-4 w-20 rounded bg-gray-200 dark:bg-gray-800" />
                      <div className="h-3 w-24 rounded bg-gray-100 dark:bg-gray-800" />
                    </div>
                  </div>
                </div>
              ))}

            {!list.isPending &&
              pagedPurchases.items.map((p) => {
                const extraCosts = (p.shipping_cost_cents ?? 0) + (p.buyer_protection_fee_cents ?? 0);
                const totalPaid = (p.total_amount_cents ?? 0) + extraCosts;
                const sourcePlatformInfo = canonicalSourcePlatform(p.source_platform);
                const rowSelected = selectedPurchaseIdSet.has(p.id);
                return (
                  <div
                    key={p.id}
                    className="rounded-md border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-800 dark:bg-gray-900"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <label className="mb-2 inline-flex cursor-pointer items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                          <input
                            type="checkbox"
                            checked={rowSelected}
                            onChange={() => togglePurchaseSelection(p.id)}
                            disabled={deletePurchases.isPending}
                            aria-label={`Einkauf ${p.counterparty_name} auswählen`}
                            className="h-4 w-4 rounded border-gray-300 text-teal-700 focus:ring-teal-600 dark:border-gray-700"
                          />
                          Auswählen
                        </label>
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {formatDateEuFromIso(p.purchase_date)}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Badge variant="secondary">{optionLabel(PURCHASE_KIND_OPTIONS, p.kind)}</Badge>
                          {p.document_number ? (
                            <Badge variant="outline" className="font-mono text-[11px]">
                              {p.document_number}
                            </Badge>
                          ) : null}
                          {needsMileageReminder(p, mileageLinkedPurchaseIds, mileageLinksReady) ? (
                            <Badge variant="warning">Bar ohne Fahrt</Badge>
                          ) : null}
                        </div>

                        <div className="mt-2">
                          <div className="truncate font-medium text-gray-900 dark:text-gray-100">{p.counterparty_name}</div>
                          {sourcePlatformInfo ? (
                            <div className="mt-1">
                              <SourcePlatformLogo platform={sourcePlatformInfo} />
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="shrink-0 text-right">
                        <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                          {formatEur(totalPaid)} €
                        </div>
                        <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                          Waren {formatEur(p.total_amount_cents)} €
                        </div>
                        {!!extraCosts && (
                          <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                            NK {formatEur(extraCosts)} €
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      {p.pdf_path ? (
                        <Button
                          variant="outline"
                          className="w-full sm:flex-1"
                          onClick={() => api.download(p.pdf_path!, p.pdf_path!.split("/").pop()!)}
                        >
                          PDF
                        </Button>
                      ) : p.kind === "PRIVATE_DIFF" || p.kind === "PRIVATE_EQUITY" ? (
                        <Button
                          variant="outline"
                          className="w-full sm:flex-1"
                          onClick={() => generatePdf.mutate(p.id)}
                          disabled={generatePdf.isPending}
                        >
                          Eigenbeleg erstellen
                        </Button>
                      ) : (
                        <Button variant="outline" className="w-full sm:flex-1" disabled>
                          PDF —
                        </Button>
                      )}

                      {!p.pdf_path ? (
                        <Button
                          variant="secondary"
                          className="w-full sm:flex-1"
                          onClick={() => startEdit(p)}
                          disabled={create.isPending || update.isPending || deletePurchases.isPending}
                        >
                          Bearbeiten
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          className="w-full sm:flex-1"
                          onClick={() => reopenPurchase.mutate(p.id)}
                          disabled={reopenPurchase.isPending || create.isPending || update.isPending || deletePurchases.isPending}
                        >
                          Zur Bearbeitung öffnen
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}

            {!list.isPending && !purchaseRows.length && (
              <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-300">
                Keine Daten.
              </div>
            )}
          </div>

          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      checked={allCurrentPageSelected}
                      onChange={(e) => toggleCurrentPageSelection(e.target.checked)}
                      disabled={deletePurchases.isPending}
                      aria-label="Aktuelle Seite auswählen"
                      className="h-4 w-4 rounded border-gray-300 text-teal-700 focus:ring-teal-600 dark:border-gray-700"
                    />
                  </TableHead>
                  <TableHead>Datum</TableHead>
                  <TableHead>Art</TableHead>
                  <TableHead>Verkäufer</TableHead>
                  <TableHead className="text-right">Waren</TableHead>
                  <TableHead className="text-right">Nebenkosten</TableHead>
                  <TableHead className="text-right">Bezahlt</TableHead>
                  <TableHead className="text-right">Dokumente</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedPurchases.items.map((p) => (
                  <TableRow key={p.id} className={TABLE_ROW_COMPACT_CLASS}>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selectedPurchaseIdSet.has(p.id)}
                        onChange={() => togglePurchaseSelection(p.id)}
                        disabled={deletePurchases.isPending}
                        aria-label={`Einkauf ${p.counterparty_name} auswählen`}
                        className="h-4 w-4 rounded border-gray-300 text-teal-700 focus:ring-teal-600 dark:border-gray-700"
                      />
                    </TableCell>
                    {(() => {
                      const extraCosts = (p.shipping_cost_cents ?? 0) + (p.buyer_protection_fee_cents ?? 0);
                      const totalPaid = (p.total_amount_cents ?? 0) + extraCosts;
                      const sourcePlatformInfo = canonicalSourcePlatform(p.source_platform);
                      return (
                        <>
                          <TableCell>{formatDateEuFromIso(p.purchase_date)}</TableCell>
                          <TableCell>{optionLabel(PURCHASE_KIND_OPTIONS, p.kind)}</TableCell>
                          <TableCell>
                            <div>{p.counterparty_name}</div>
                            {needsMileageReminder(p, mileageLinkedPurchaseIds, mileageLinksReady) ? (
                              <div className="mt-1">
                                <Badge variant="warning">Bar ohne Fahrt</Badge>
                              </div>
                            ) : null}
                            {sourcePlatformInfo ? (
                              <div className="mt-1">
                                <SourcePlatformLogo platform={sourcePlatformInfo} size="sm" />
                              </div>
                            ) : null}
                          </TableCell>
                          <TableCell className={TABLE_CELL_NUMERIC_CLASS}>{formatEur(p.total_amount_cents)} €</TableCell>
                          <TableCell className={TABLE_CELL_NUMERIC_CLASS}>{formatEur(extraCosts)} €</TableCell>
                          <TableCell className={TABLE_CELL_NUMERIC_CLASS}>{formatEur(totalPaid)} €</TableCell>
                        </>
                      );
                    })()}
                    <TableCell className={PURCHASE_TABLE_ACTION_CELL_CLASS}>
                      <div className={PURCHASE_TABLE_ACTION_GROUP_CLASS}>
                        <div className={PURCHASE_TABLE_DOC_SLOT_CLASS}>
                          {p.pdf_path ? (
                            <Dialog>
                              <DialogTrigger asChild>
                                <Button size="sm" variant="outline" className="min-w-[6.5rem]">
                                  PDF
                                </Button>
                              </DialogTrigger>
                              <DialogContent>
                                <DialogHeader>
                                  <DialogTitle>Einkauf (PDF)</DialogTitle>
                                  <DialogDescription>{p.pdf_path}</DialogDescription>
                                </DialogHeader>
                                <DialogFooter>
                                  <Button variant="secondary" onClick={() => api.download(p.pdf_path!, p.pdf_path!.split("/").pop()!)}>
                                    Herunterladen
                                  </Button>
                                </DialogFooter>
                              </DialogContent>
                            </Dialog>
                          ) : p.kind === "PRIVATE_DIFF" || p.kind === "PRIVATE_EQUITY" ? (
                            <Button size="sm" variant="outline" className="min-w-[9.5rem]" onClick={() => generatePdf.mutate(p.id)} disabled={generatePdf.isPending}>
                              Eigenbeleg erstellen
                            </Button>
                          ) : (
                            <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                          )}
                        </div>

                        <div className={PURCHASE_TABLE_MAIN_SLOT_CLASS}>
                          {!p.pdf_path && (
                            <Button
                              size="sm"
                              variant="secondary"
                              className="min-w-[7.5rem]"
                              onClick={() => startEdit(p)}
                              disabled={create.isPending || update.isPending || deletePurchases.isPending}
                            >
                              Bearbeiten
                            </Button>
                          )}
                          {p.pdf_path && (
                            <Button
                              size="sm"
                              variant="secondary"
                              className="min-w-[11.5rem]"
                              onClick={() => reopenPurchase.mutate(p.id)}
                              disabled={reopenPurchase.isPending || create.isPending || update.isPending || deletePurchases.isPending}
                            >
                              Zur Bearbeitung öffnen
                            </Button>
                          )}
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {!purchaseRows.length && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-sm text-gray-500 dark:text-gray-400">
                      Keine Daten.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <PaginationControls
            page={pagedPurchases.page}
            totalPages={pagedPurchases.totalPages}
            totalItems={pagedPurchases.totalItems}
            pageSize={pagedPurchases.pageSize}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>

      <Dialog
        open={formOpen || !!editingPurchaseId}
        onOpenChange={(open) => {
          if (!open) closeForm();
        }}
      >
        <DialogContent className="flex h-[min(96dvh,980px)] w-[min(98vw,1180px)] max-w-6xl flex-col overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-gray-200 bg-gray-50/70 px-4 pb-3 pr-14 pt-4 sm:px-6 sm:pr-16 sm:pt-5 dark:border-gray-800 dark:bg-gray-900/30">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Einkauf</div>
            <DialogTitle className="text-xl leading-tight sm:text-2xl">{editingPurchaseId ? "Einkauf bearbeiten" : "Einkauf erfassen"}</DialogTitle>
            <DialogDescription className="break-all font-mono text-xs">
              {editingPurchaseId ? `ID: ${editingPurchaseId}` : "Schnellerfassung in Tabs: Eckdaten, Positionen, Nachweise."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white dark:bg-gray-900">
            <Tabs value={formTab} onValueChange={(value) => setFormTab(value as "BASICS" | "POSITIONS" | "ATTACHMENTS")} className="flex min-h-0 flex-1 flex-col">
              <div className="shrink-0 border-b border-gray-200 px-4 py-3 sm:px-6 dark:border-gray-800">
                <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto sm:w-auto">
                  <TabsTrigger value="BASICS">Eckdaten</TabsTrigger>
                  <TabsTrigger value="POSITIONS">Positionen</TabsTrigger>
                  <TabsTrigger value="ATTACHMENTS" disabled={!isPrivateKind}>
                    Nachweise
                  </TabsTrigger>
                </TabsList>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3 sm:px-6">
                <TabsContent value="BASICS" className="mt-0 min-h-0 space-y-4 rounded-xl border border-gray-200 bg-gray-50/40 p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950/20">
                  <div className="border-b border-gray-200 pb-3 dark:border-gray-800">
                    <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">Eckdaten</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      Stammdaten, Kosten und optionale Nachverfolgungsinfos fuer den Einkauf.
                    </div>
                  </div>
                  <div className="grid gap-4 md:grid-cols-3">
                    <div className="space-y-2">
                      <Label>Art</Label>
                      <Select value={kind} onValueChange={setKind} disabled={!!editingPurchaseId}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PURCHASE_KIND_OPTIONS.map((k) => (
                            <SelectItem key={k.value} value={k.value}>
                              {k.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        Einkaufstyp ist fest auf {PURCHASE_TYPE_LABEL[purchaseType] ?? purchaseType} gesetzt.
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>Datum</Label>
                      <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Zahlungsquelle</Label>
                      <Select value={paymentSource} onValueChange={setPaymentSource} disabled={isPrivateEquity}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(isPrivateEquity
                            ? PAYMENT_SOURCE_OPTIONS.filter((p) => p.value === "PRIVATE_EQUITY")
                            : PAYMENT_SOURCE_OPTIONS.filter((p) => p.value !== "PRIVATE_EQUITY")
                          ).map((p) => (
                            <SelectItem key={p.value} value={p.value}>
                              {p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {isPrivateEquity && (
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          PAIV ist cash-neutral; die Zahlungsquelle ist fix auf Privateinlage gesetzt.
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Verkäufer / Lieferant</Label>
                      <Input value={counterpartyName} onChange={(e) => setCounterpartyName(e.target.value)} placeholder="Name" />
                    </div>
                    <div className="space-y-2">
                      <Label>Adresse (optional)</Label>
                      <Input value={counterpartyAddress} onChange={(e) => setCounterpartyAddress(e.target.value)} placeholder="Adresse" />
                    </div>
                  </div>

                  <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium">Fahrt zum Einkauf (optional)</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          Verknüpft eine Fahrt direkt mit diesem Einkauf für das Fahrtenbuch.
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant={withMileage ? "secondary" : "outline"}
                        onClick={() => {
                          setWithMileage((current) => {
                            const next = !current;
                            if (next) {
                              setMileageLogDate(mileageLogDate || purchaseDate);
                            } else {
                              setMileageRoundTrip(false);
                              setMileageRoutePreview(null);
                              setMileageRouteError(null);
                              setMileageRoutePending(false);
                            }
                            return next;
                          });
                          setMileageSyncError(null);
                        }}
                      >
                        {withMileage ? "Aktiv" : "Hinzufügen"}
                      </Button>
                    </div>

                    {editingPurchaseId && purchaseMileage.isFetching && (
                      <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">Lade verknüpfte Fahrt…</div>
                    )}
                    {purchaseMileage.isError && (
                      <div className="mt-2 text-xs text-red-700 dark:text-red-300">{(purchaseMileage.error as Error).message}</div>
                    )}

                    {withMileage && (
                      <div className="mt-3 grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label>Fahrtdatum</Label>
                          <Input type="date" value={mileageLogDate} onChange={(e) => setMileageLogDate(e.target.value)} />
                        </div>
                        <div className="space-y-2">
                          <Label>Kilometer</Label>
                          <Input value={mileageKm} onChange={(e) => setMileageKm(e.target.value)} placeholder="z. B. 12.4" />
                        </div>
                        <div className="space-y-2">
                          <Label>Start</Label>
                          <Input
                            value={mileageStartLocation}
                            onChange={(e) => setMileageStartLocation(e.target.value)}
                            placeholder="z. B. Lager"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Ziel</Label>
                          <Input
                            value={mileageDestination}
                            onChange={(e) => setMileageDestination(e.target.value)}
                            placeholder="z. B. Verkäuferadresse"
                          />
                        </div>
                        <div className="space-y-2 md:col-span-2">
                          <Label>Zweck-Notiz (optional)</Label>
                          <Input
                            value={mileagePurposeText}
                            onChange={(e) => setMileagePurposeText(e.target.value)}
                            placeholder="z. B. Abholung Konvolut"
                          />
                        </div>

                        <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800 md:col-span-2">
                          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                            <div className="space-y-2">
                              <Label>Routenberechnung (OpenStreetMap)</Label>
                              <div className="text-xs text-gray-500 dark:text-gray-400">
                                Distanz wird aus der Route berechnet und in das km-Feld übernommen.
                              </div>
                            </div>

                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                              <div role="radiogroup" aria-label="Routenmodus" className="grid w-full grid-cols-2 gap-2 sm:w-[16rem]">
                                <Button
                                  type="button"
                                  variant={mileageRoundTrip ? "outline" : "secondary"}
                                  size="sm"
                                  aria-pressed={!mileageRoundTrip}
                                  onClick={() => setMileageRoundTrip(false)}
                                >
                                  Einfach
                                </Button>
                                <Button
                                  type="button"
                                  variant={mileageRoundTrip ? "secondary" : "outline"}
                                  size="sm"
                                  aria-pressed={mileageRoundTrip}
                                  onClick={() => setMileageRoundTrip(true)}
                                >
                                  Hin- und Rückfahrt
                                </Button>
                              </div>

                              <Button
                                type="button"
                                variant="secondary"
                                onClick={() => {
                                  void calculateMileageRoute();
                                }}
                                disabled={mileageRoutePending || !mileageStartLocation.trim() || !mileageDestination.trim()}
                              >
                                <Route className="h-4 w-4" />
                                {mileageRoutePending ? "Berechne…" : "Route berechnen"}
                              </Button>
                            </div>
                          </div>

                          {mileageRoutePreview && (
                            <div className="mt-3 text-xs text-gray-600 dark:text-gray-300">
                              Berechnet: {kmLabelFromMeters(mileageRoutePreview.oneWayMeters)}
                              {mileageRoundTrip ? ` (gesamt ${kmLabelFromMeters(mileageRoutePreview.oneWayMeters * 2)})` : ""}
                            </div>
                          )}

                          {mileageRouteError && (
                            <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
                              {mileageRouteError}
                            </div>
                          )}

                          {mileageRoutePreview && (
                            <div className="mt-3">
                              <MileageRouteMap route={mileageRoutePreview} />
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {isPrivateDiff && (
                    <>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label>Plattform / Quelle</Label>
                          <Select
                            value={sourcePlatformSelectValue}
                            onValueChange={(value) => {
                              if (value === PLATFORM_NONE) {
                                setSourcePlatform("");
                                return;
                              }
                              setSourcePlatform(value);
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Keine Angabe" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={PLATFORM_NONE}>Keine Angabe</SelectItem>
                              {sourcePlatformOptions.map((entry) => (
                                <SelectItem key={entry.value} value={entry.value}>
                                  <div className="flex items-center gap-2">
                                    <SourcePlatformLogo platform={entry} size="sm" />
                                    <span>{entry.label}</span>
                                  </div>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>Anzeige-URL (optional)</Label>
                          <Input value={listingUrl} onChange={(e) => setListingUrl(e.target.value)} placeholder="https://..." />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label>Notizen (optional)</Label>
                        <textarea
                          value={notes}
                          onChange={(e) => setNotes(e.target.value)}
                          rows={3}
                          placeholder="z.B. Zustand, Bundle-Inhalt, Verhandlungsnotiz ..."
                          className="w-full resize-y rounded-md border border-gray-200 bg-white px-3 py-2 text-[16px] shadow-sm placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus-visible:ring-gray-700 sm:text-sm"
                        />
                      </div>

                      <div className="grid gap-4 md:grid-cols-3">
                        <div className="space-y-2">
                          <Label>Versandkosten (EUR)</Label>
                          <Input value={shippingCost} onChange={(e) => setShippingCost(e.target.value)} />
                        </div>
                        <div className="space-y-2">
                          <Label>Käuferschutz / PayLivery (EUR)</Label>
                          <Input value={buyerProtectionFee} onChange={(e) => setBuyerProtectionFee(e.target.value)} />
                        </div>
                        <div className="space-y-2">
                          <Label>Gesamt bezahlt (EUR)</Label>
                          <Input value={formatEur(totalPaidCents)} readOnly />
                        </div>
                      </div>

                      <div className="space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-800">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="text-xs text-gray-500 dark:text-gray-400">Identitaetsdaten nur bei Bedarf</div>
                          <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => setIdentityFieldsOpen((open) => !open)}>
                            {identityFieldsOpen ? "Identitaet ausblenden" : "Identitaet einblenden"}
                          </Button>
                        </div>
                        {identityFieldsOpen ? (
                          <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                              <Label>Geburtsdatum (optional)</Label>
                              <Input type="date" value={counterpartyBirthdate} onChange={(e) => setCounterpartyBirthdate(e.target.value)} />
                            </div>
                            <div className="space-y-2">
                              <Label>Ausweisnummer (optional)</Label>
                              <Input value={counterpartyIdNumber} onChange={(e) => setCounterpartyIdNumber(e.target.value)} placeholder="z.B. Reisepass / Personalausweis" />
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </>
                  )}

                  {kind === "COMMERCIAL_REGULAR" && (
                    <div className="grid gap-4 md:grid-cols-4">
                      <div className="space-y-2">
                        <Label>Externe Rechnungsnummer</Label>
                        <Input value={externalInvoiceNumber} onChange={(e) => setExternalInvoiceNumber(e.target.value)} />
                      </div>
                      {vatEnabled ? (
                        <div className="space-y-2">
                          <Label>USt-Satz</Label>
                          <Select value={taxRateBp} onValueChange={setTaxRateBp}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="1000">10%</SelectItem>
                              <SelectItem value="2000">20%</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <Label>Umsatzsteuer</Label>
                          <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700 dark:border-gray-800 dark:bg-gray-900/50 dark:text-gray-200">
                            Kleinunternehmerregelung aktiv: keine USt-Berechnung.
                          </div>
                        </div>
                      )}
                      <div className="space-y-2 md:col-span-2">
                        <Label>Beleg-Upload</Label>
                        <div className="flex items-center gap-2">
                          <Input value={receiptUploadPath} readOnly placeholder="PDF/Bild hochladen…" />
                          <Input
                            type="file"
                            className="max-w-xs"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) upload.mutate(f);
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label>Warenbetrag (EUR, an Verkäufer)</Label>
                    <Input value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} />
                  </div>

                  <div className="flex items-center justify-end">
                    <Button type="button" variant="outline" onClick={() => setFormTab("POSITIONS")}>
                      Weiter zu Positionen
                    </Button>
                  </div>
                </TabsContent>

                <TabsContent value="POSITIONS" className="mt-0 min-h-0 space-y-3 rounded-xl border border-gray-200 bg-gray-50/40 p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950/20">
                  <div className="border-b border-gray-200 pb-3 dark:border-gray-800">
                    <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">Positionen</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      Produkte zuordnen, Zustand erfassen und EK sauber aufteilen.
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setLines((s) => [
                          ...s,
                          {
                            ui_id: newLineId(),
                            master_product_id: "",
                            condition: "GOOD",
                            purchase_price: "0,00",
                            market_value: "0,00",
                            held_privately_over_12_months: false,
                            valuation_reason: "",
                          },
                        ])
                      }
                    >
                      Position hinzufügen
                    </Button>
                    {master.isPending && <div className="text-xs text-gray-500 dark:text-gray-400">Produktstamm wird geladen…</div>}
                    {!master.isPending && !master.data?.length && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        Noch kein Produktstamm. Lege Produkte direkt in der Position an.
                      </div>
                    )}
                  </div>

                  <div className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium">Verteilung</div>
                      <Badge variant={splitOk ? "success" : "warning"}>
                        {sumLinesCents === null ? "ungültig" : `${formatEur(sumLinesCents)} €`} / {formatEur(totalCents)} €
                      </Badge>
                    </div>
                    {!splitOk && (
                      <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        Summen muessen identisch sein, sonst ist Speichern blockiert.
                      </div>
                    )}
                  </div>

                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Produkt</TableHead>
                        <TableHead>Zustand</TableHead>
                        <TableHead className="text-right">Amazon</TableHead>
                        <TableHead className="text-right">{isPrivateEquity ? "Einlagewert (EUR)" : "EK (EUR)"}</TableHead>
                        {isPrivateEquity && <TableHead>PAIV</TableHead>}
                        <TableHead className="text-right"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(() => {
                        const weights = lines.map((l) => linePurchaseCents(l, isPrivateEquity) ?? 0);
                        const shipAlloc = allocateProportional(isPrivateDiff ? shippingCostCents : 0, weights);
                        const buyerAlloc = allocateProportional(isPrivateDiff ? buyerProtectionFeeCents : 0, weights);
                        const feeTitle = `FBA Fees: referral ${(feeProfileValue.referral_fee_bp / 100).toFixed(2)}% + fulfillment ${formatEur(feeProfileValue.fulfillment_fee_cents)} € + inbound ${formatEur(feeProfileValue.inbound_shipping_cents)} €`;

                        return lines.map((l, idx) => {
                          const mp = l.master_product_id ? masterById.get(l.master_product_id) ?? null : null;
                          const market = estimateMarketPriceForInventoryCondition(mp, l.condition);
                          const payout = estimateFbaPayout(market.cents, feeProfileValue);
                          const purchaseCents = linePurchaseCents(l, isPrivateEquity);
                          const costBasis =
                            typeof purchaseCents === "number" ? purchaseCents + (shipAlloc[idx] ?? 0) + (buyerAlloc[idx] ?? 0) : null;
                          const margin = estimateMargin(payout.payout_cents, costBasis);

                          return (
                            <TableRow key={l.ui_id} className={TABLE_ROW_COMPACT_CLASS}>
                              <TableCell>
                                <MasterProductCombobox
                                  value={l.master_product_id}
                                  options={master.data ?? []}
                                  loading={master.isPending}
                                  placeholder="Suchen (SKU, Titel, EAN, …) oder neu anlegen…"
                                  onValueChange={(v) =>
                                    setLines((s) => s.map((x) => (x.ui_id === l.ui_id ? { ...x, master_product_id: v } : x)))
                                  }
                                  onCreateNew={(seed) => openQuickCreate(l.ui_id, seed)}
                                />
                              </TableCell>
                              <TableCell>
                                <Select
                                  value={l.condition}
                                  onValueChange={(v) => setLines((s) => s.map((x) => (x.ui_id === l.ui_id ? { ...x, condition: v } : x)))}
                                >
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {CONDITION_OPTIONS.map((c) => (
                                      <SelectItem key={c.value} value={c.value}>
                                        {c.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </TableCell>
                              <TableCell className="text-right text-xs" title={feeTitle}>
                                <div title="Amazon Market Value (Condition-mapped; fallback: Used best)">
                                  {typeof market.cents === "number" ? `${formatEur(market.cents)} €` : "—"}
                                </div>
                                <div
                                  className={
                                    margin === null
                                      ? "text-gray-400 dark:text-gray-500"
                                      : margin >= 0
                                        ? "text-emerald-700 dark:text-emerald-300"
                                        : "text-red-700 dark:text-red-300"
                                  }
                                  title="Margin estimate = payout - cost basis (EK + estimated NK allocation)"
                                >
                                  {margin === null ? "—" : `${formatEur(margin)} €`}
                                </div>
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="space-y-2">
                                  <Input
                                    className="text-right"
                                    value={l.purchase_price}
                                    onChange={(e) =>
                                      setLines((s) => s.map((x) => (x.ui_id === l.ui_id ? { ...x, purchase_price: e.target.value } : x)))
                                    }
                                  />
                                  {isPrivateEquity && (
                                    <Input
                                      className="text-right"
                                      placeholder="Marktwert (EUR)"
                                      value={l.market_value}
                                      onChange={(e) =>
                                        setLines((s) =>
                                          s.map((x) => {
                                            if (x.ui_id !== l.ui_id) return x;
                                            const parsedCurrentPurchase = parseMoneyInputToCents(x.purchase_price);
                                            const parsedMarket = parseMoneyInputToCents(e.target.value);
                                            const autoContribution =
                                              parsedMarket !== null ? formatEur(Math.floor((parsedMarket * 85) / 100)) : x.purchase_price;
                                            return {
                                              ...x,
                                              market_value: e.target.value,
                                              purchase_price:
                                                parsedCurrentPurchase === null || parsedCurrentPurchase === 0
                                                  ? autoContribution
                                                  : x.purchase_price,
                                            };
                                          }),
                                        )
                                      }
                                    />
                                  )}
                                </div>
                              </TableCell>
                              {isPrivateEquity && (
                                <TableCell>
                                  <div className="space-y-2">
                                    <label className="flex items-center gap-2 text-xs">
                                      <input
                                        type="checkbox"
                                        checked={l.held_privately_over_12_months}
                                        onChange={(e) =>
                                          setLines((s) =>
                                            s.map((x) =>
                                              x.ui_id === l.ui_id ? { ...x, held_privately_over_12_months: e.target.checked } : x,
                                            ),
                                          )
                                        }
                                      />
                                      {"\u003e"}12 Monate Privatbesitz
                                    </label>
                                    <Input
                                      placeholder="Begründung Korrektur (optional)"
                                      value={l.valuation_reason}
                                      onChange={(e) =>
                                        setLines((s) =>
                                          s.map((x) => (x.ui_id === l.ui_id ? { ...x, valuation_reason: e.target.value } : x)),
                                        )
                                      }
                                    />
                                  </div>
                                </TableCell>
                              )}
                              <TableCell className="text-right">
                                <Button variant="ghost" onClick={() => setLines((s) => s.filter((x) => x.ui_id !== l.ui_id))}>
                                  Entfernen
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        });
                      })()}
                      {!lines.length && (
                        <TableRow>
                          <TableCell colSpan={isPrivateEquity ? 6 : 5} className="text-sm text-gray-500 dark:text-gray-400">
                            Noch keine Positionen.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>

                  <div className="flex items-center justify-end gap-2">
                    <Button type="button" variant="outline" onClick={() => setFormTab("BASICS")}>
                      Zurück zu Eckdaten
                    </Button>
                    {isPrivateKind && (
                      <Button type="button" variant="outline" onClick={() => setFormTab("ATTACHMENTS")}>
                        Weiter zu Nachweisen
                      </Button>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="ATTACHMENTS" className="mt-0 min-h-0 space-y-4 rounded-xl border border-gray-200 bg-gray-50/40 p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950/20">
                  <div className="border-b border-gray-200 pb-3 dark:border-gray-800">
                    <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">Nachweise</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      Dateien hochladen, Typ mappen und gesammelt am Einkauf verknuepfen.
                    </div>
                  </div>
                  {!isPrivateKind ? (
                    <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-200">
                      Nachweise sind nur fuer Privatankaeufe vorgesehen.
                    </div>
                  ) : (
                    <>
                      <div className="rounded-md border border-dashed border-gray-300 p-4 dark:border-gray-700">
                        <div className="space-y-2">
                          <Label>Dateien hinzufuegen (werden sofort hochgeladen)</Label>
                          <Input
                            type="file"
                            multiple
                            onChange={(e) => {
                              void handleStageFileInput(e.target.files);
                              e.currentTarget.value = "";
                            }}
                            disabled={create.isPending || update.isPending || isLinkingStagedAttachments}
                          />
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            Danach Typ/Notiz pro Datei mappen und gesammelt am Einkauf speichern.
                          </div>
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-4">
                        <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-800 dark:bg-gray-900/40">
                          <div className="text-xs text-gray-500 dark:text-gray-400">In Staging</div>
                          <div className="text-lg font-semibold">{stagedUploadCount}</div>
                        </div>
                        <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-800 dark:bg-gray-900/40">
                          <div className="text-xs text-gray-500 dark:text-gray-400">Wartend</div>
                          <div className="text-lg font-semibold">{stagedQueuedCount}</div>
                        </div>
                        <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-800 dark:bg-gray-900/40">
                          <div className="text-xs text-gray-500 dark:text-gray-400">Upload laeuft</div>
                          <div className="text-lg font-semibold">{stagedUploadingCount}</div>
                        </div>
                        <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-800 dark:bg-gray-900/40">
                          <div className="text-xs text-gray-500 dark:text-gray-400">Bereit zum Verknuepfen</div>
                          <div className="text-lg font-semibold">{stagedReadyCount}</div>
                        </div>
                        <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-800 dark:bg-gray-900/40">
                          <div className="text-xs text-gray-500 dark:text-gray-400">Fehler</div>
                          <div className="text-lg font-semibold">{stagedErrorCount}</div>
                        </div>
                      </div>
                      {isPrivateEquity && !!paivComplianceWarnings.length && (
                        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
                          {paivComplianceWarnings.map((warning) => (
                            <div key={warning}>{warning}</div>
                          ))}
                        </div>
                      )}

                      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                        <div className="flex items-end gap-2">
                          <div className="space-y-2">
                            <Label>Typ fuer alle (optional)</Label>
                            <Select value={stagedAttachmentBulkKind} onValueChange={setStagedAttachmentBulkKind}>
                              <SelectTrigger className="w-44">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {PURCHASE_ATTACHMENT_KIND_OPTIONS.map((opt) => (
                                  <SelectItem key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <Button type="button" variant="outline" onClick={applyBulkAttachmentKindToStaged} disabled={!stagedUploadCount}>
                            Auf alle anwenden
                          </Button>
                        </div>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => void persistStagedAttachmentsNow()}
                          disabled={!editingPurchaseId || !stagedReadyCount || isLinkingStagedAttachments || stagedUploadingCount > 0}
                        >
                          {!editingPurchaseId ? "Zuerst Einkauf speichern" : isLinkingStagedAttachments ? "Verknüpfe…" : "Anhänge am Einkauf speichern"}
                        </Button>
                      </div>

                      {!!stagedAttachments.length && (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Datei</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead>Typ</TableHead>
                              {isPrivateEquity && <TableHead>Position</TableHead>}
                              <TableHead>Notiz</TableHead>
                              <TableHead className="text-right">Aktion</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {stagedAttachments.map((item) => (
                              <TableRow key={item.local_id} className={TABLE_ROW_COMPACT_CLASS}>
                                <TableCell>
                                  <div className="font-mono text-xs">{item.file_name}</div>
                                  <div className="text-xs text-gray-500 dark:text-gray-400">
                                    {formatFileSize(item.file_size)}
                                    {item.mime_type ? ` · ${item.mime_type}` : ""}
                                  </div>
                                </TableCell>
                                <TableCell>
                                  {item.status === "queued" && <span className="text-xs text-gray-500 dark:text-gray-400">Wartet…</span>}
                                  {item.status === "uploading" && <span className="text-xs text-gray-500 dark:text-gray-400">Upload läuft…</span>}
                                  {item.status === "uploaded" && <span className="text-xs text-emerald-700 dark:text-emerald-300">Hochgeladen</span>}
                                  {item.status === "error" && (
                                    <span className="text-xs text-red-700 dark:text-red-300">{item.error ?? "Fehler"}</span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <Select
                                    value={item.kind}
                                    onValueChange={(value) =>
                                      setStagedAttachments((prev) =>
                                        prev.map((row) =>
                                          row.local_id === item.local_id
                                            ? {
                                                ...row,
                                                kind: value,
                                                purchase_line_id: value === "MARKET_COMP" ? row.purchase_line_id : undefined,
                                              }
                                            : row,
                                        ),
                                      )
                                    }
                                  >
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {PURCHASE_ATTACHMENT_KIND_OPTIONS.map((opt) => (
                                        <SelectItem key={opt.value} value={opt.value}>
                                          {opt.label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </TableCell>
                                {isPrivateEquity && (
                                  <TableCell>
                                    {item.kind === "MARKET_COMP" ? (
                                      <Select
                                        value={item.purchase_line_id ?? ""}
                                        onValueChange={(value) =>
                                          setStagedAttachments((prev) =>
                                            prev.map((row) =>
                                              row.local_id === item.local_id ? { ...row, purchase_line_id: value || undefined } : row,
                                            ),
                                          )
                                        }
                                      >
                                        <SelectTrigger>
                                          <SelectValue placeholder={editingPurchaseId ? "Position wählen" : "Erst speichern"} />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {lineSelectOptions.map((opt) => (
                                            <SelectItem key={opt.value} value={opt.value}>
                                              {opt.label}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    ) : (
                                      <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                                    )}
                                  </TableCell>
                                )}
                                <TableCell>
                                  <Input
                                    value={item.note}
                                    onChange={(e) =>
                                      setStagedAttachments((prev) =>
                                        prev.map((row) => (row.local_id === item.local_id ? { ...row, note: e.target.value } : row)),
                                      )
                                    }
                                    placeholder="Notiz (optional)"
                                  />
                                </TableCell>
                                <TableCell className="text-right">
                                  <div className="inline-flex items-center gap-2">
                                    {item.status === "error" && (
                                      <Button type="button" size="sm" variant="outline" onClick={() => void handleRetryStagedUpload(item.local_id)}>
                                        Retry
                                      </Button>
                                    )}
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      onClick={() =>
                                        setStagedAttachments((prev) => prev.filter((row) => row.local_id !== item.local_id))
                                      }
                                    >
                                      Entfernen
                                    </Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}

                      {(purchaseAttachments.isError || deletePurchaseAttachment.isError || stagedAttachmentError) && (
                        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                          {stagedAttachmentError ??
                            (((purchaseAttachments.error ?? deletePurchaseAttachment.error) as Error) ?? new Error("Unbekannter Fehler")).message}
                        </div>
                      )}

                      {!!editingPurchaseId && (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Typ</TableHead>
                              <TableHead>Datei</TableHead>
                              {isPrivateEquity && <TableHead>Position</TableHead>}
                              <TableHead>Notiz</TableHead>
                              <TableHead className="text-right">Aktion</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {(purchaseAttachments.data ?? []).map((attachment) => (
                              <TableRow key={attachment.id} className={TABLE_ROW_COMPACT_CLASS}>
                                <TableCell>{optionLabel(PURCHASE_ATTACHMENT_KIND_OPTIONS, attachment.kind)}</TableCell>
                                <TableCell className="font-mono text-xs">{attachment.original_filename}</TableCell>
                                {isPrivateEquity && (
                                  <TableCell className="text-xs text-gray-600 dark:text-gray-300">
                                    {attachment.purchase_line_id
                                      ? lineSelectOptions.find((opt) => opt.value === attachment.purchase_line_id)?.label ??
                                        attachment.purchase_line_id
                                      : "—"}
                                  </TableCell>
                                )}
                                <TableCell>{attachment.note ?? "—"}</TableCell>
                                <TableCell className="text-right">
                                  <div className="inline-flex items-center justify-end gap-2">
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() => api.download(attachment.upload_path, attachment.original_filename)}
                                    >
                                      Download
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() =>
                                        deletePurchaseAttachment.mutate({
                                          purchaseId: editingPurchaseId,
                                          attachmentId: attachment.id,
                                        })}
                                      disabled={deletePurchaseAttachment.isPending}
                                    >
                                      Löschen
                                    </Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))}
                            {!purchaseAttachments.isPending && !purchaseAttachments.data?.length && (
                              <TableRow>
                                <TableCell colSpan={isPrivateEquity ? 5 : 4} className="text-sm text-gray-500 dark:text-gray-400">
                                  Noch keine verknüpften Anhänge.
                                </TableCell>
                              </TableRow>
                            )}
                          </TableBody>
                        </Table>
                      )}
                    </>
                  )}
                </TabsContent>
              </div>
            </Tabs>

            <div className="shrink-0 space-y-3 border-t border-gray-200 px-4 pb-4 pt-3 sm:px-6 dark:border-gray-800">
              {(create.isError || update.isError || mileageSyncError) && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                  {mileageSyncError ??
                    ((((create.error ?? update.error) as Error) ?? new Error("Unbekannter Fehler")).message)}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={splitOk ? "success" : "warning"}>
                  Aufteilung: {sumLinesCents === null ? "ungültig" : `${formatEur(sumLinesCents)} €`} / {formatEur(totalCents)} €
                </Badge>
                {!splitOk && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {editingPurchaseId ? "Speichern" : "Erstellen"} ist blockiert, bis die Summen übereinstimmen.
                  </div>
                )}
                {isPrivateDiff && !extraCostsValid && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Versand- und Käuferschutzbetrag müssen gültige, nicht-negative EUR-Werte sein.
                  </div>
                )}
                {isPrivateEquity && !paivLinesValid && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Für PAIV ist je Position ein gültiger Marktwert erforderlich.
                  </div>
                )}
                {isPrivateEquity && !!paivComplianceWarnings.length && (
                  <div className="text-xs text-amber-700 dark:text-amber-300">
                    PAIV-Hinweise vorhanden ({paivComplianceWarnings.length}); Speichern bleibt erlaubt.
                  </div>
                )}
                {splitOk && !allLinesHaveProduct && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">Jede Position braucht ein Produkt.</div>
                )}
                {stagedUploadingCount > 0 && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Es laufen noch Uploads. Speichern ist kurz blockiert.
                  </div>
                )}
                {stagedQueuedCount > 0 && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Dateien werden vorbereitet. Speichern ist kurz blockiert.
                  </div>
                )}
                {withMileage && !mileageInputValid && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Fahrt aktiv: Datum, Start, Ziel und km müssen gültig sein.
                  </div>
                )}
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
                <Button type="button" variant="secondary" onClick={closeForm} disabled={create.isPending || update.isPending}>
                  {editingPurchaseId ? "Abbrechen" : "Schließen"}
                </Button>
                <Button
                  onClick={() => (editingPurchaseId ? update.mutate() : create.mutate())}
                  disabled={
                    !canSubmit ||
                    create.isPending ||
                    update.isPending ||
                    stagedQueuedCount > 0 ||
                    stagedUploadingCount > 0 ||
                    isLinkingStagedAttachments
                  }
                >
                  {editingPurchaseId ? "Änderungen speichern" : "Erstellen"}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={quickCreateOpen}
        onOpenChange={(open) => {
          if (!open) {
            setQuickCreateOpen(false);
            setQuickCreateTargetLineId(null);
          }
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Neues Produkt anlegen</DialogTitle>
            <DialogDescription>
              Schnellanlage für den Einkauf. Details (EAN/ASIN/Hersteller/…) können später im Produktstamm ergänzt werden.
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              quickCreate.mutate();
            }}
            className="space-y-4"
          >
            <div className="grid gap-4 md:grid-cols-6">
              <div className="space-y-2 md:col-span-4">
                <Label>Titel</Label>
                <Input value={quickCreateTitle} onChange={(e) => setQuickCreateTitle(e.target.value)} autoFocus />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Typ</Label>
                <Select value={quickCreateKind} onValueChange={(v) => setQuickCreateKind(v as MasterProductKind)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MASTER_KIND_OPTIONS.map((k) => (
                      <SelectItem key={k.value} value={k.value}>
                        {k.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2 md:col-span-3">
                <Label>Plattform</Label>
                <Select
                  value={quickCreatePlatformSelectValue}
                  onValueChange={(value) => {
                    if (value === PLATFORM_OTHER) {
                      setQuickCreatePlatformMode("CUSTOM");
                      if (!quickCreatePlatform.trim()) setQuickCreatePlatform("");
                      return;
                    }
                    if (value === PLATFORM_NONE) {
                      setQuickCreatePlatformMode("CUSTOM");
                      setQuickCreatePlatform("");
                      return;
                    }
                    setQuickCreatePlatformMode("PRESET");
                    setQuickCreatePlatform(value);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={PLATFORM_NONE}>Keine Angabe</SelectItem>
                    {platformOptions.map((entry) => (
                      <SelectItem key={entry} value={entry}>
                        {entry}
                      </SelectItem>
                    ))}
                    <SelectItem value={PLATFORM_OTHER}>Andere …</SelectItem>
                  </SelectContent>
                </Select>
                {quickCreatePlatformMode === "CUSTOM" && (
                  <Input
                    value={quickCreatePlatform}
                    onChange={(e) => setQuickCreatePlatform(e.target.value)}
                    placeholder="z.B. Nintendo Gamecube"
                  />
                )}
              </div>

              <div className="space-y-2 md:col-span-3">
                <Label>Region</Label>
                <Input
                  value={quickCreateRegion}
                  onChange={(e) => setQuickCreateRegion(e.target.value)}
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

              <div className="space-y-2 md:col-span-6">
                <Label>Variante (optional)</Label>
                <Input
                  value={quickCreateVariant}
                  onChange={(e) => setQuickCreateVariant(e.target.value)}
                  placeholder="z.B. Player's Choice, Farbe, Bundle…"
                />
              </div>
            </div>

            {quickCreate.isError && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                {(quickCreate.error as Error).message}
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setQuickCreateOpen(false)} disabled={quickCreate.isPending}>
                Abbrechen
              </Button>
              <Button type="submit" disabled={quickCreate.isPending}>
                Anlegen
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
