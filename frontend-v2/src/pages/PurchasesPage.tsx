import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { latLngBounds } from "leaflet";
import { Download, FilePlus, MapPinned, Pencil, RefreshCw, Save, Trash2, Undo2, UploadCloud } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap } from "react-leaflet";
import { useSearchParams } from "react-router-dom";

import { useApi } from "../api/api";
import { calculateOsrmRoute, geocodeAddress, type GeoPoint, type RoutePreview } from "../lib/geo";
import { formatDateTimeLocal } from "../lib/dates";
import { formatEur, fmtEur, parseEurToCents } from "../lib/money";
import { paginateItems } from "../lib/pagination";
import { useTaxProfile } from "../lib/taxProfile";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { InlineAlert } from "../ui/InlineAlert";
import { Modal } from "../ui/Modal";
import { Pagination } from "../ui/Pagination";
import { SearchCombo } from "../ui/SearchCombo";

type PurchaseKind = "PRIVATE_DIFF" | "PRIVATE_EQUITY" | "COMMERCIAL_REGULAR";
type PurchaseType = "DIFF" | "REGULAR";
type PaymentSource = "CASH" | "BANK" | "PRIVATE_EQUITY";
type InventoryCondition = "NEW" | "LIKE_NEW" | "GOOD" | "ACCEPTABLE" | "DEFECT";

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
  kind: PurchaseKind;
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
  total_net_cents: number;
  total_tax_cents: number;
  tax_rate_bp: number;
  payment_source: PaymentSource;
  document_number?: string | null;
  pdf_path?: string | null;
  external_invoice_number?: string | null;
  receipt_upload_path?: string | null;
  primary_mileage_log_id?: string | null;
  created_at: string;
  updated_at: string;
  lines: Array<{
    id: string;
    master_product_id: string;
    condition: InventoryCondition;
    purchase_type: PurchaseType;
    purchase_price_cents: number;
    shipping_allocated_cents: number;
    buyer_protection_fee_allocated_cents: number;
    market_value_cents?: number | null;
    held_privately_over_12_months?: boolean | null;
    valuation_reason?: string | null;
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
  purpose_text?: string | null;
  distance_meters: number;
  rate_cents_per_km: number;
  amount_cents: number;
};

type MileageLinkOut = {
  id: string;
  purchase_ids?: string[];
};

type AmazonFeeProfile = { referral_fee_bp: number; fulfillment_fee_cents: number; inbound_shipping_cents: number };

type DraftLine = {
  ui_id: string;
  purchase_line_id?: string;
  master_product_id: string;
  condition: InventoryCondition;
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

const DEFAULT_MAP_CENTER: GeoPoint = [47.5, 9.74];

const KIND_OPTIONS: Array<{ value: PurchaseKind; label: string }> = [
  { value: "PRIVATE_DIFF", label: "Privat (Differenz)" },
  { value: "PRIVATE_EQUITY", label: "Private Sacheinlage (PAIV)" },
  { value: "COMMERCIAL_REGULAR", label: "Gewerblich (Regulär)" },
];

const PAYMENT_SOURCE_OPTIONS: Array<{ value: PaymentSource; label: string }> = [
  { value: "CASH", label: "Bar" },
  { value: "BANK", label: "Bank" },
  { value: "PRIVATE_EQUITY", label: "Privateinlage" },
];

const CONDITION_OPTIONS: Array<{ value: InventoryCondition; label: string }> = [
  { value: "NEW", label: "Neu" },
  { value: "LIKE_NEW", label: "Wie neu" },
  { value: "GOOD", label: "Gut" },
  { value: "ACCEPTABLE", label: "Akzeptabel" },
  { value: "DEFECT", label: "Defekt" },
];

const ATTACHMENT_KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "LISTING", label: "Anzeige" },
  { value: "MARKET_COMP", label: "Marktvergleich" },
  { value: "CHAT", label: "Chat" },
  { value: "PAYMENT", label: "Zahlung" },
  { value: "DELIVERY", label: "Versand" },
  { value: "OTHER", label: "Sonstiges" },
];

const TAX_RATE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "0", label: "0%" },
  { value: "1000", label: "10%" },
  { value: "1300", label: "13%" },
  { value: "2000", label: "20%" },
];

function optionLabel(options: Array<{ value: string; label: string }>, value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

function todayIsoLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function parseMoneyInputToCents(input: string): number | null {
  try {
    return parseEurToCents(input);
  } catch {
    return null;
  }
}

function lineEffectiveCents(line: DraftLine, kind: PurchaseKind): number | null {
  const explicit = parseMoneyInputToCents(line.purchase_price);
  if (explicit !== null && (kind !== "PRIVATE_EQUITY" || explicit > 0)) return explicit;
  if (kind !== "PRIVATE_EQUITY") return null;
  const market = parseMoneyInputToCents(line.market_value);
  if (market === null) return null;
  return Math.floor((market * 85) / 100);
}

function masterLabel(m: MasterProduct): string {
  return `${m.sku} · ${m.title} · ${m.platform} · ${m.region}${m.variant ? ` · ${m.variant}` : ""}`;
}

function masterSearchKey(m: MasterProduct): string {
  return `${m.sku} ${m.title} ${m.platform} ${m.region} ${m.variant} ${m.ean ?? ""} ${m.asin ?? ""} ${m.manufacturer ?? ""} ${m.model ?? ""}`.toLowerCase();
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

function estimateMarketPriceCents(mp: MasterProduct | null, condition: InventoryCondition): number | null {
  if (!mp) return null;
  if (condition === "NEW") return mp.amazon_price_new_cents ?? null;
  if (condition === "LIKE_NEW") return mp.amazon_price_used_like_new_cents ?? null;
  if (condition === "GOOD") return mp.amazon_price_used_good_cents ?? mp.amazon_price_used_very_good_cents ?? null;
  if (condition === "ACCEPTABLE") return mp.amazon_price_used_acceptable_cents ?? null;
  return mp.amazon_price_used_acceptable_cents ?? mp.amazon_price_used_good_cents ?? mp.amazon_price_used_very_good_cents ?? null;
}

function estimateFbaPayoutCents(grossCents: number | null, feeProfile: AmazonFeeProfile): number | null {
  if (grossCents === null) return null;
  const referral = Math.round((grossCents * feeProfile.referral_fee_bp) / 10000);
  const totalFees = referral + feeProfile.fulfillment_fee_cents + feeProfile.inbound_shipping_cents;
  return Math.max(0, grossCents - totalFees);
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

function kmFromMetersString(distanceMeters: number): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) return "";
  return (distanceMeters / 1000).toFixed(2);
}

function kmFromMetersInput(distanceMeters: number): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) return "";
  return (distanceMeters / 1000).toFixed(2).replace(".", ",");
}

function normalizeKm(value: string): string {
  return value.trim().replace(",", ".");
}

function hasLinkedMileage(purchaseId: string, mileage: MileageLinkOut[] | undefined): boolean {
  for (const log of mileage ?? []) {
    if ((log.purchase_ids ?? []).includes(purchaseId)) return true;
  }
  return false;
}

export function PurchasesPage() {
  const api = useApi();
  const qc = useQueryClient();
  const taxProfile = useTaxProfile();
  const vatEnabled = taxProfile.data?.vat_enabled ?? true;

  const [params, setParams] = useSearchParams();
  const [message, setMessage] = useState<string | null>(null);

  const selectedId = params.get("selected") ?? "";
  const modeParam = params.get("mode") ?? "";
  const mode: "view" | "edit" = selectedId === "new" ? "edit" : modeParam === "edit" ? "edit" : "view";

  const search = params.get("q") ?? "";
  const kindFilter = (params.get("kind") as any) ?? "ALL";
  const page = Number(params.get("page") ?? "1") || 1;

  const master = useQuery({
    queryKey: ["master-products"],
    queryFn: () => api.request<MasterProduct[]>("/master-products"),
  });
  const mpById = useMemo(() => new Map((master.data ?? []).map((m) => [m.id, m] as const)), [master.data]);

  const feeProfile = useQuery({
    queryKey: ["amazon-fee-profile"],
    queryFn: () => api.request<AmazonFeeProfile>("/amazon-scrapes/fee-profile"),
  });
  const feeProfileValue: AmazonFeeProfile = feeProfile.data ?? {
    referral_fee_bp: 1500,
    fulfillment_fee_cents: 350,
    inbound_shipping_cents: 0,
  };

  const list = useQuery({
    queryKey: ["purchases"],
    queryFn: () => api.request<PurchaseOut[]>("/purchases"),
  });

  const mileageLinks = useQuery({
    queryKey: ["mileage"],
    queryFn: () => api.request<MileageLinkOut[]>("/mileage"),
  });

  const sourcePlatforms = useQuery({
    queryKey: ["purchase-source-platforms"],
    queryFn: () => api.request<string[]>("/purchases/source-platforms"),
  });

  const purchasesAll = list.data ?? [];
  const purchasesFiltered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rows = purchasesAll.filter((p) => (kindFilter === "ALL" ? true : p.kind === kindFilter));
    if (!needle) return rows;
    return rows.filter((p) => {
      const extra = p.shipping_cost_cents + p.buyer_protection_fee_cents;
      const totalPaid = p.total_amount_cents + extra;
      const hay = [
        p.purchase_date,
        p.kind,
        p.counterparty_name,
        p.source_platform ?? "",
        p.document_number ?? "",
        p.external_invoice_number ?? "",
        String(totalPaid),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [kindFilter, purchasesAll, search]);

  const paged = useMemo(() => paginateItems(purchasesFiltered, page, 30), [page, purchasesFiltered]);

  useEffect(() => {
    if (page !== paged.page) {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("page", String(paged.page));
        return next;
      });
    }
  }, [page, paged.page, setParams]);

  const selectedPurchase: PurchaseOut | null = useMemo(() => {
    if (!selectedId || selectedId === "new") return null;
    return purchasesAll.find((p) => p.id === selectedId) ?? null;
  }, [purchasesAll, selectedId]);

  const canEditSelected = Boolean(selectedPurchase && !selectedPurchase.pdf_path);
  const lockedSelected = Boolean(selectedPurchase && selectedPurchase.pdf_path);

  const generatePdf = useMutation({
    mutationFn: (purchaseId: string) => api.request<PurchaseOut>(`/purchases/${purchaseId}/generate-pdf`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["purchases"] });
      setMessage("PDF erstellt.");
    },
  });

  const reopenPurchase = useMutation({
    mutationFn: (purchaseId: string) => api.request<PurchaseOut>(`/purchases/${purchaseId}/reopen`, { method: "POST" }),
    onSuccess: async (purchase) => {
      await qc.invalidateQueries({ queryKey: ["purchases"] });
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("selected", purchase.id);
        next.set("mode", "edit");
        return next;
      });
      setMessage("Zur Bearbeitung geöffnet (PDF gelöscht).");
    },
  });

  const deletePurchase = useMutation({
    mutationFn: async (purchaseId: string) => {
      await api.request<void>(`/purchases/${purchaseId}`, { method: "DELETE" });
    },
    onSuccess: async (_out, purchaseId) => {
      await qc.invalidateQueries({ queryKey: ["purchases"] });
      await qc.invalidateQueries({ queryKey: ["inventory"] });
      await qc.invalidateQueries({ queryKey: ["mileage"] });
      if (selectedId === purchaseId) {
        setParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete("selected");
          next.delete("mode");
          return next;
        });
      }
      setMessage("Einkauf gelöscht.");
    },
  });

  // --- Editor state ---
  const [draftPurchaseId, setDraftPurchaseId] = useState<string | null>(null);
  const [kind, setKind] = useState<PurchaseKind>("PRIVATE_DIFF");
  const [purchaseDate, setPurchaseDate] = useState<string>(() => todayIsoLocal());
  const [counterpartyName, setCounterpartyName] = useState("");
  const [counterpartyAddress, setCounterpartyAddress] = useState("");
  const [counterpartyBirthdate, setCounterpartyBirthdate] = useState("");
  const [counterpartyIdNumber, setCounterpartyIdNumber] = useState("");
  const [identityOpen, setIdentityOpen] = useState(false);
  const [sourcePlatform, setSourcePlatform] = useState("");
  const [listingUrl, setListingUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [paymentSource, setPaymentSource] = useState<PaymentSource>("CASH");
  const [totalAmount, setTotalAmount] = useState("0,00");
  const [shippingCost, setShippingCost] = useState("0,00");
  const [buyerProtectionFee, setBuyerProtectionFee] = useState("0,00");
  const [taxRateBp, setTaxRateBp] = useState("2000");
  const [externalInvoiceNumber, setExternalInvoiceNumber] = useState("");
  const [receiptUploadPath, setReceiptUploadPath] = useState("");

  const [lines, setLines] = useState<DraftLine[]>([]);

  const [withMileage, setWithMileage] = useState(false);
  const [mileageLogDate, setMileageLogDate] = useState<string>(() => todayIsoLocal());
  const [mileageStartLocation, setMileageStartLocation] = useState("");
  const [mileageDestination, setMileageDestination] = useState("");
  const [mileageKm, setMileageKm] = useState("");
  const [mileagePurposeText, setMileagePurposeText] = useState("");
  const [mileageRoundTrip, setMileageRoundTrip] = useState(false);
  const [mileageRoutePreview, setMileageRoutePreview] = useState<RoutePreview | null>(null);
  const [mileageRoutePending, setMileageRoutePending] = useState(false);
  const [mileageRouteError, setMileageRouteError] = useState<string | null>(null);

  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([]);
  const [stagedAttachmentError, setStagedAttachmentError] = useState<string | null>(null);
  const [stagedAttachmentBulkKind, setStagedAttachmentBulkKind] = useState("OTHER");
  const [isLinkingStagedAttachments, setIsLinkingStagedAttachments] = useState(false);

  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [quickCreateTargetLineId, setQuickCreateTargetLineId] = useState<string | null>(null);
  const [quickCreateKind, setQuickCreateKind] = useState<MasterProductKind>("GAME");
  const [quickCreateTitle, setQuickCreateTitle] = useState("");
  const [quickCreatePlatform, setQuickCreatePlatform] = useState("");
  const [quickCreateRegion, setQuickCreateRegion] = useState("EU");
  const [quickCreateVariant, setQuickCreateVariant] = useState("");

  const purchaseAttachments = useQuery({
    queryKey: ["purchase-attachments", draftPurchaseId],
    enabled: Boolean(draftPurchaseId),
    queryFn: () => api.request<PurchaseAttachmentOut[]>(`/purchases/${draftPurchaseId}/attachments`),
  });

  const purchaseMileage = useQuery({
    queryKey: ["purchase-mileage", draftPurchaseId],
    enabled: Boolean(draftPurchaseId),
    queryFn: () => api.request<MileageOut | null>(`/purchases/${draftPurchaseId}/mileage`),
  });

  useEffect(() => {
    if (mode !== "edit") return;
    if (selectedId === "new") {
      if (draftPurchaseId === null) {
        resetDraft();
        setDraftPurchaseId(null);
      }
      return;
    }
    if (!selectedPurchase) return;
    if (draftPurchaseId === selectedPurchase.id) return;
    startEdit(selectedPurchase);
  }, [draftPurchaseId, mode, selectedId, selectedPurchase]);

  useEffect(() => {
    if (!withMileage) {
      setMileageRoundTrip(false);
      setMileageRoutePreview(null);
      setMileageRouteError(null);
      setMileageRoutePending(false);
      return;
    }
  }, [withMileage]);

  useEffect(() => {
    if (!mileageRoutePreview) return;
    const computedMeters = mileageRoundTrip ? mileageRoutePreview.oneWayMeters * 2 : mileageRoutePreview.oneWayMeters;
    setMileageKm(kmFromMetersInput(computedMeters));
  }, [mileageRoutePreview, mileageRoundTrip]);

  useEffect(() => {
    setMileageRoutePreview(null);
    setMileageRouteError(null);
  }, [mileageStartLocation, mileageDestination]);

  useEffect(() => {
    if (mode !== "edit") return;
    if (!draftPurchaseId) {
      if (!withMileage) setMileageLogDate(purchaseDate);
      return;
    }
    if (!purchaseMileage.isSuccess) return;
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
    setMileageKm(kmFromMetersInput(linked.distance_meters));
    setMileagePurposeText(linked.purpose_text ?? "");
    setMileageRoundTrip(false);
    setMileageRoutePreview(null);
    setMileageRouteError(null);
    setMileageRoutePending(false);
  }, [draftPurchaseId, mode, purchaseDate, purchaseMileage.data, purchaseMileage.isSuccess, withMileage]);

  useEffect(() => {
    if (kind === "PRIVATE_EQUITY") setPaymentSource("PRIVATE_EQUITY");
    else if (paymentSource === "PRIVATE_EQUITY") setPaymentSource("CASH");
  }, [kind, paymentSource]);

  const isPrivateDiff = kind === "PRIVATE_DIFF";
  const isPrivateEquity = kind === "PRIVATE_EQUITY";
  const isPrivateKind = isPrivateDiff || isPrivateEquity;
  const purchaseType: PurchaseType = isPrivateKind ? "DIFF" : "REGULAR";

  const purchaseDateValid = /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate);

  const totalCentsParsed = useMemo(() => parseMoneyInputToCents(totalAmount), [totalAmount]);
  const shippingCostCentsParsed = useMemo(() => (isPrivateDiff ? parseMoneyInputToCents(shippingCost) : 0), [isPrivateDiff, shippingCost]);
  const buyerProtectionFeeCentsParsed = useMemo(
    () => (isPrivateDiff ? parseMoneyInputToCents(buyerProtectionFee) : 0),
    [buyerProtectionFee, isPrivateDiff],
  );

  const totalCents = totalCentsParsed ?? 0;
  const shippingCostCents = shippingCostCentsParsed ?? 0;
  const buyerProtectionFeeCents = buyerProtectionFeeCentsParsed ?? 0;
  const extraCostsValid =
    shippingCostCentsParsed !== null &&
    buyerProtectionFeeCentsParsed !== null &&
    shippingCostCents >= 0 &&
    buyerProtectionFeeCents >= 0;

  const sumLinesCents = useMemo(() => {
    let sum = 0;
    for (const l of lines) {
      const cents = lineEffectiveCents(l, kind);
      if (cents === null) return null;
      sum += cents;
    }
    return sum;
  }, [kind, lines]);

  const splitOk = sumLinesCents !== null && sumLinesCents === totalCents;
  const allLinesHaveProduct = lines.every((l) => !!l.master_product_id.trim());
  const paivLinesValid = !isPrivateEquity || lines.every((l) => parseMoneyInputToCents(l.market_value) !== null);

  const mileageKmNormalized = normalizeKm(mileageKm);
  const mileageKmValue = mileageKmNormalized ? Number(mileageKmNormalized) : NaN;
  const mileageDateValid = /^\d{4}-\d{2}-\d{2}$/.test(mileageLogDate);
  const mileageInputValid =
    !withMileage ||
    (mileageDateValid &&
      !!mileageStartLocation.trim() &&
      !!mileageDestination.trim() &&
      Number.isFinite(mileageKmValue) &&
      mileageKmValue > 0);

  const stagedReady = stagedAttachments.filter((a) => a.status === "uploaded" && a.upload_path);
  const stagedHasMarketComp = stagedReady.some((a) => a.kind === "MARKET_COMP");

  const canSubmit =
    purchaseDateValid &&
    counterpartyName.trim() &&
    lines.length > 0 &&
    allLinesHaveProduct &&
    splitOk &&
    totalCentsParsed !== null &&
    (!isPrivateDiff || extraCostsValid) &&
    (!vatEnabled || kind !== "COMMERCIAL_REGULAR" || Number(taxRateBp) > 0) &&
    (kind !== "COMMERCIAL_REGULAR" || (externalInvoiceNumber.trim() && receiptUploadPath.trim())) &&
    paivLinesValid &&
    mileageInputValid;

  const saveDraft = useMutation({
    mutationFn: async () => {
      if (!purchaseDateValid) throw new Error("Datum fehlt");
      if (counterpartyBirthdate && !/^\d{4}-\d{2}-\d{2}$/.test(counterpartyBirthdate)) {
        throw new Error("Geburtsdatum muss als Datum gesetzt sein");
      }

      const payload = {
        kind,
        purchase_date: purchaseDate,
        counterparty_name: counterpartyName.trim(),
        counterparty_address: counterpartyAddress.trim() ? counterpartyAddress.trim() : null,
        counterparty_birthdate: isPrivateKind ? (counterpartyBirthdate.trim() ? counterpartyBirthdate.trim() : null) : null,
        counterparty_id_number: isPrivateKind ? (counterpartyIdNumber.trim() ? counterpartyIdNumber.trim() : null) : null,
        source_platform: isPrivateDiff ? (sourcePlatform.trim() ? sourcePlatform.trim() : null) : null,
        listing_url: isPrivateDiff ? (listingUrl.trim() ? listingUrl.trim() : null) : null,
        notes: isPrivateKind ? (notes.trim() ? notes.trim() : null) : null,
        total_amount_cents: totalCents,
        shipping_cost_cents: isPrivateDiff ? shippingCostCents : 0,
        buyer_protection_fee_cents: isPrivateDiff ? buyerProtectionFeeCents : 0,
        tax_rate_bp: kind === "COMMERCIAL_REGULAR" ? (vatEnabled ? Number(taxRateBp) : 0) : 0,
        payment_source: isPrivateEquity ? "PRIVATE_EQUITY" : paymentSource,
        external_invoice_number: kind === "COMMERCIAL_REGULAR" ? externalInvoiceNumber.trim() : null,
        receipt_upload_path: kind === "COMMERCIAL_REGULAR" ? receiptUploadPath.trim() : null,
        lines: lines.map((l) => ({
          id: draftPurchaseId ? (l.purchase_line_id ?? null) : undefined,
          master_product_id: l.master_product_id,
          condition: l.condition,
          purchase_type: purchaseType,
          purchase_price_cents:
            kind === "PRIVATE_EQUITY"
              ? (() => {
                  const parsed = parseMoneyInputToCents(l.purchase_price);
                  if (parsed === null || parsed <= 0) return null;
                  return parsed;
                })()
              : parseMoneyInputToCents(l.purchase_price),
          market_value_cents: isPrivateEquity ? parseMoneyInputToCents(l.market_value) : null,
          held_privately_over_12_months: isPrivateEquity ? l.held_privately_over_12_months : null,
          valuation_reason: isPrivateEquity ? (l.valuation_reason.trim() ? l.valuation_reason.trim() : null) : null,
        })),
      };

      if (draftPurchaseId) {
        return api.request<PurchaseOut>(`/purchases/${draftPurchaseId}`, { method: "PUT", json: payload });
      }
      return api.request<PurchaseOut>("/purchases", { method: "POST", json: payload });
    },
    onSuccess: async (purchase) => {
      const created = !draftPurchaseId;
      setDraftPurchaseId(purchase.id);
      await qc.invalidateQueries({ queryKey: ["purchases"] });
      await qc.invalidateQueries({ queryKey: ["inventory"] });

      try {
        if (isPrivateDiff) {
          await linkStagedAttachmentsToPurchase(purchase.id);
        } else if (isPrivateEquity && stagedHasMarketComp) {
          setStagedAttachmentError("MARKET_COMP benötigt eine zugeordnete Position. Bitte nach dem Speichern zuordnen.");
        } else if (isPrivateKind) {
          await linkStagedAttachmentsToPurchase(purchase.id);
        }
      } catch (error) {
        setStagedAttachmentError((error as Error)?.message ?? "Anhänge konnten nicht verknüpft werden");
      }

      try {
        await syncPurchaseMileage(purchase.id, { deleteIfDisabled: !created });
      } catch (error) {
        setMessage((error as Error)?.message ?? "Fahrt konnte nicht gespeichert werden");
      }

      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("selected", purchase.id);
        next.set("mode", "view");
        return next;
      });

      setMessage(created ? "Einkauf erstellt." : "Einkauf gespeichert.");
    },
  });

  const deletePurchaseAttachment = useMutation({
    mutationFn: ({ purchaseId, attachmentId }: { purchaseId: string; attachmentId: string }) =>
      api.request<void>(`/purchases/${purchaseId}/attachments/${attachmentId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["purchase-attachments", draftPurchaseId] });
      setMessage("Anhang gelöscht.");
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
      if (quickCreateTargetLineId) {
        setLines((s) => s.map((l) => (l.ui_id === quickCreateTargetLineId ? { ...l, master_product_id: mp.id } : l)));
      }
      setQuickCreateOpen(false);
      setQuickCreateTargetLineId(null);
      setQuickCreateTitle("");
      setQuickCreatePlatform("");
      setQuickCreateVariant("");
      setMessage("Produkt angelegt.");
    },
  });

  async function uploadStagedAttachment(localId: string, file: File): Promise<void> {
    setStagedAttachments((prev) =>
      prev.map((item) => (item.local_id === localId ? { ...item, status: "uploading", error: undefined, upload_path: undefined } : item)),
    );
    try {
      const out = await api.uploadFile(file);
      setStagedAttachments((prev) =>
        prev.map((item) => (item.local_id === localId ? { ...item, status: "uploaded", upload_path: out.upload_path, error: undefined } : item)),
      );
    } catch (error) {
      setStagedAttachments((prev) =>
        prev.map((item) =>
          item.local_id === localId
            ? { ...item, status: "error", error: (error as Error)?.message ?? "Upload fehlgeschlagen", upload_path: undefined }
            : item,
        ),
      );
    }
  }

  async function stageAttachmentFiles(files: File[]): Promise<void> {
    if (!files.length) return;
    setStagedAttachmentError(null);
    const staged = files.map((file) => ({
      local_id: newId(),
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
      if (invalidMarketComp) throw new Error("MARKET_COMP benötigt eine zugeordnete Position.");

      const payload = ready.map((item) => ({
        upload_path: item.upload_path!,
        purchase_line_id: item.purchase_line_id ?? null,
        original_filename: item.file_name,
        kind: item.kind,
        note: item.note.trim() ? item.note.trim() : null,
      }));
      for (let i = 0; i < payload.length; i += 30) {
        await api.request<PurchaseAttachmentOut[]>(`/purchases/${purchaseId}/attachments`, {
          method: "POST",
          json: { attachments: payload.slice(i, i + 30) },
        });
      }
      setStagedAttachments((prev) => prev.filter((item) => !(item.status === "uploaded" && item.upload_path)));
      await qc.invalidateQueries({ queryKey: ["purchase-attachments", purchaseId] });
    } finally {
      setIsLinkingStagedAttachments(false);
    }
  }

  async function syncPurchaseMileage(purchaseId: string, options?: { deleteIfDisabled?: boolean }): Promise<void> {
    if (!withMileage) {
      if (options?.deleteIfDisabled) {
        await api.request<void>(`/purchases/${purchaseId}/mileage`, { method: "DELETE" });
        await qc.invalidateQueries({ queryKey: ["purchase-mileage", purchaseId] });
        await qc.invalidateQueries({ queryKey: ["mileage"] });
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
    await qc.invalidateQueries({ queryKey: ["purchase-mileage", purchaseId] });
    await qc.invalidateQueries({ queryKey: ["mileage"] });
    await qc.invalidateQueries({ queryKey: ["purchases"] });
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
      const route = await calculateOsrmRoute(startPoint, destinationPoint);
      setMileageRoutePreview(route);
      const distanceMeters = mileageRoundTrip ? route.oneWayMeters * 2 : route.oneWayMeters;
      setMileageKm(kmFromMetersInput(distanceMeters));
    } catch (error) {
      setMileageRoutePreview(null);
      setMileageRouteError((error as Error)?.message ?? "Route konnte nicht berechnet werden");
    } finally {
      setMileageRoutePending(false);
    }
  }

  function resetDraft() {
    setDraftPurchaseId(null);
    setKind("PRIVATE_DIFF");
    setPurchaseDate(todayIsoLocal());
    setCounterpartyName("");
    setCounterpartyAddress("");
    setCounterpartyBirthdate("");
    setCounterpartyIdNumber("");
    setIdentityOpen(false);
    setSourcePlatform("");
    setListingUrl("");
    setNotes("");
    setPaymentSource("CASH");
    setTotalAmount("0,00");
    setShippingCost("0,00");
    setBuyerProtectionFee("0,00");
    setTaxRateBp("2000");
    setExternalInvoiceNumber("");
    setReceiptUploadPath("");
    setLines([]);
    setWithMileage(false);
    setMileageLogDate(todayIsoLocal());
    setMileageStartLocation("");
    setMileageDestination("");
    setMileageKm("");
    setMileagePurposeText("");
    setMileageRoundTrip(false);
    setMileageRoutePreview(null);
    setMileageRoutePending(false);
    setMileageRouteError(null);
    setStagedAttachments([]);
    setStagedAttachmentError(null);
    setStagedAttachmentBulkKind("OTHER");
    setIsLinkingStagedAttachments(false);
    saveDraft.reset();
  }

  function startEdit(p: PurchaseOut) {
    setDraftPurchaseId(p.id);
    setKind(p.kind);
    setPurchaseDate(p.purchase_date);
    setCounterpartyName(p.counterparty_name);
    setCounterpartyAddress(p.counterparty_address ?? "");
    setCounterpartyBirthdate(p.counterparty_birthdate ?? "");
    setCounterpartyIdNumber(p.counterparty_id_number ?? "");
    setIdentityOpen(false);
    setSourcePlatform(p.source_platform ?? "");
    setListingUrl(p.listing_url ?? "");
    setNotes(p.notes ?? "");
    setPaymentSource(p.payment_source);
    setTotalAmount(formatEur(p.total_amount_cents));
    setShippingCost(formatEur(p.shipping_cost_cents ?? 0));
    setBuyerProtectionFee(formatEur(p.buyer_protection_fee_cents ?? 0));
    setTaxRateBp(String(p.tax_rate_bp ?? 2000));
    setExternalInvoiceNumber(p.external_invoice_number ?? "");
    setReceiptUploadPath(p.receipt_upload_path ?? "");
    setLines(
      (p.lines ?? []).map((pl) => ({
        ui_id: pl.id,
        purchase_line_id: pl.id,
        master_product_id: pl.master_product_id,
        condition: pl.condition,
        purchase_price: formatEur(pl.purchase_price_cents),
        market_value: formatEur(pl.market_value_cents ?? 0),
        held_privately_over_12_months: Boolean(pl.held_privately_over_12_months),
        valuation_reason: pl.valuation_reason ?? "",
      })),
    );
    setStagedAttachments([]);
    setStagedAttachmentError(null);
    setWithMileage(false);
    setMileageLogDate(p.purchase_date);
    setMileageStartLocation("");
    setMileageDestination("");
    setMileageKm("");
    setMileagePurposeText("");
    setMileageRoundTrip(false);
    setMileageRoutePreview(null);
    setMileageRoutePending(false);
    setMileageRouteError(null);
    saveDraft.reset();
  }

  function requestNewPurchase() {
    if (mode === "edit" && hasDraftChanges()) {
      const ok = window.confirm("Ungespeicherte Eingaben gehen verloren. Trotzdem neuen Einkauf starten?");
      if (!ok) return;
    }
    resetDraft();
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("selected", "new");
      next.set("mode", "edit");
      return next;
    });
  }

  function hasDraftChanges(): boolean {
    if (!draftPurchaseId) {
      if (withMileage) return true;
      if (mileageStartLocation.trim() || mileageDestination.trim() || mileageKm.trim() || mileagePurposeText.trim()) return true;
      if (lines.length) return true;
      if (counterpartyName.trim() || counterpartyAddress.trim() || counterpartyBirthdate.trim() || counterpartyIdNumber.trim()) return true;
      if (sourcePlatform.trim() || listingUrl.trim() || notes.trim()) return true;
      if (externalInvoiceNumber.trim() || receiptUploadPath.trim()) return true;
      if (totalAmount !== "0,00" || shippingCost !== "0,00" || buyerProtectionFee !== "0,00") return true;
    }
    if (stagedAttachments.length) return true;
    return false;
  }

  function closeEditor() {
    if (mode !== "edit") return;
    if (hasDraftChanges()) {
      const ok = window.confirm("Ungespeicherte Eingaben oder Uploads gehen verloren. Trotzdem schließen?");
      if (!ok) return;
    }
    resetDraft();
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("mode", "view");
      if (selectedId === "new") next.delete("selected");
      return next;
    });
  }

  function openEditorForSelected() {
    if (!selectedPurchase) return;
    if (lockedSelected) return;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("selected", selectedPurchase.id);
      next.set("mode", "edit");
      return next;
    });
  }

  const paivComplianceWarnings = useMemo(() => {
    if (kind !== "PRIVATE_EQUITY") return [];
    const marketCompByLine = new Map<string, number>();
    for (const a of purchaseAttachments.data ?? []) {
      if (a.kind !== "MARKET_COMP" || !a.purchase_line_id) continue;
      marketCompByLine.set(a.purchase_line_id, (marketCompByLine.get(a.purchase_line_id) ?? 0) + 1);
    }
    for (const a of stagedAttachments) {
      if (a.kind !== "MARKET_COMP" || !a.purchase_line_id || a.status !== "uploaded") continue;
      marketCompByLine.set(a.purchase_line_id, (marketCompByLine.get(a.purchase_line_id) ?? 0) + 1);
    }
    const warnings: string[] = [];
    for (const line of lines) {
      const title = mpById.get(line.master_product_id)?.title ?? "Unbekannt";
      const lineId = line.purchase_line_id ?? line.ui_id;
      const count = marketCompByLine.get(lineId) ?? 0;
      if (count < 3) warnings.push(`${title}: nur ${count} Marktvergleich(e).`);
      if (!line.held_privately_over_12_months) warnings.push(`${title}: 12-Monats-Besitz nicht bestätigt.`);
    }
    return warnings;
  }, [kind, lines, mpById, purchaseAttachments.data, stagedAttachments]);

  const lineSelectOptions = useMemo(
    () =>
      lines
        .filter((l) => Boolean(l.purchase_line_id))
        .map((l) => ({
          id: l.purchase_line_id!,
          label: mpById.get(l.master_product_id)?.title ?? l.purchase_line_id!,
        })),
    [lines, mpById],
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Einkäufe</div>
          <div className="page-subtitle">Einkäufe erfassen, Anhänge/Mileage verknüpfen, Eigenbelege (PDF) erstellen.</div>
        </div>
        <div className="page-actions">
          <Button variant="secondary" size="sm" onClick={() => list.refetch()} disabled={list.isFetching}>
            <RefreshCw size={16} /> Aktualisieren
          </Button>
          <Button variant="primary" size="sm" onClick={requestNewPurchase}>
            <FilePlus size={16} /> Neu
          </Button>
        </div>
      </div>

      {message ? (
        <InlineAlert tone="info" onDismiss={() => setMessage(null)}>
          {message}
        </InlineAlert>
      ) : null}

      {(list.isError ||
        saveDraft.isError ||
        generatePdf.isError ||
        reopenPurchase.isError ||
        deletePurchase.isError ||
        deletePurchaseAttachment.isError ||
        quickCreate.isError) && (
        <InlineAlert tone="error">
          {String(
            (
              (list.error as Error) ??
              (saveDraft.error as Error) ??
              (generatePdf.error as Error) ??
              (reopenPurchase.error as Error) ??
              (deletePurchase.error as Error) ??
              (deletePurchaseAttachment.error as Error) ??
              (quickCreate.error as Error)
            )?.message ?? "Unbekannter Fehler",
          )}
        </InlineAlert>
      )}

      <div className="split" style={{ gridTemplateColumns: "1fr 540px" }}>
        <div className="panel">
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <input
              className="input"
              placeholder="Suche (Name, Datum, Belegnr, …)"
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
            <select
              className="input"
              style={{ width: 240 }}
              value={kindFilter}
              onChange={(e) =>
                setParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.set("kind", e.target.value);
                  next.set("page", "1");
                  return next;
                })
              }
            >
              <option value="ALL">Alle Arten</option>
              {KIND_OPTIONS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
            <div className="toolbar-spacer" />
            <Pagination page={paged.page} pageSize={paged.pageSize} total={paged.totalItems} onPageChange={(p) => setParams((prev) => {
              const next = new URLSearchParams(prev);
              next.set("page", String(p));
              return next;
            })} />
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>Datum</th>
                <th>Art</th>
                <th>Gegenpartei</th>
                <th className="numeric">Bezahlt</th>
                <th>Beleg</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((p) => {
                const extra = p.shipping_cost_cents + p.buyer_protection_fee_cents;
                const totalPaid = p.total_amount_cents + extra;
                const selected = p.id === selectedId;
                const mileageMissing = p.payment_source === "CASH" && !p.primary_mileage_log_id && mileageLinks.isSuccess && !hasLinkedMileage(p.id, mileageLinks.data);
                return (
                  <tr
                    key={p.id}
                    style={{ cursor: "pointer", background: selected ? "var(--surface-2)" : undefined }}
                    onClick={() =>
                      setParams((prev) => {
                        const next = new URLSearchParams(prev);
                        next.set("selected", p.id);
                        next.set("mode", "view");
                        return next;
                      })
                    }
                  >
                    <td className="nowrap mono">{p.purchase_date}</td>
                    <td>{optionLabel(KIND_OPTIONS, p.kind)}</td>
                    <td>
                      <div style={{ fontWeight: 650 }}>{p.counterparty_name}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {p.source_platform ?? "—"}
                        {mileageMissing ? " · Bar ohne Fahrt" : ""}
                      </div>
                    </td>
                    <td className="numeric mono">
                      {fmtEur(totalPaid)}
                      {!!extra ? (
                        <div className="muted" style={{ fontSize: 12 }}>
                          Waren {fmtEur(p.total_amount_cents)} · NK {fmtEur(extra)}
                        </div>
                      ) : (
                        <div className="muted" style={{ fontSize: 12 }}>
                          Waren {fmtEur(p.total_amount_cents)}
                        </div>
                      )}
                    </td>
                    <td className="nowrap">
                      {p.document_number ? <span className="badge mono">{p.document_number}</span> : <span className="muted">—</span>}
                    </td>
                  </tr>
                );
              })}
              {!paged.items.length ? (
                <tr>
                  <td colSpan={5} className="muted">
                    Keine Daten.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="panel">
          {selectedId === "new" || mode === "edit" ? (
            <div className="stack">
              <div className="toolbar" style={{ justifyContent: "space-between" }}>
                <div>
                  <div className="panel-title">{draftPurchaseId ? "Einkauf bearbeiten" : "Einkauf erfassen"}</div>
                  <div className="panel-sub">
                    {draftPurchaseId ? (
                      <>
                        ID <span className="mono">{draftPurchaseId}</span> · zuletzt {formatDateTimeLocal(new Date().toISOString())}
                      </>
                    ) : (
                      "Draft wird erst beim Speichern erstellt."
                    )}
                  </div>
                </div>
                <div className="toolbar">
                  <Button variant="secondary" size="sm" onClick={closeEditor}>
                    <Undo2 size={16} /> Schließen
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => saveDraft.mutate()} disabled={!canSubmit || saveDraft.isPending}>
                    <Save size={16} /> {saveDraft.isPending ? "Speichere…" : "Speichern"}
                  </Button>
                </div>
              </div>

              <details open>
                <summary className="panel-title" style={{ cursor: "pointer" }}>
                  Basis
                </summary>
                <div className="stack" style={{ marginTop: 10 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <Field label="Art">
                      <select className="input" value={kind} disabled={Boolean(draftPurchaseId)} onChange={(e) => setKind(e.target.value as PurchaseKind)}>
                        {KIND_OPTIONS.map((k) => (
                          <option key={k.value} value={k.value}>
                            {k.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Datum">
                      <input className="input" type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
                    </Field>
                  </div>

                  <Field label="Gegenpartei">
                    <input className="input" value={counterpartyName} onChange={(e) => setCounterpartyName(e.target.value)} placeholder="Name" />
                  </Field>

                  <Field label="Adresse (optional)">
                    <textarea className="input" value={counterpartyAddress} onChange={(e) => setCounterpartyAddress(e.target.value)} rows={2} />
                  </Field>

                  {isPrivateKind ? (
                    <div className="toolbar">
                      <label className="checkbox">
                        <input type="checkbox" checked={identityOpen} onChange={(e) => setIdentityOpen(e.target.checked)} /> Identität erfassen
                      </label>
                    </div>
                  ) : null}

                  {isPrivateKind && identityOpen ? (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <Field label="Geburtsdatum (optional)">
                        <input className="input" type="date" value={counterpartyBirthdate} onChange={(e) => setCounterpartyBirthdate(e.target.value)} />
                      </Field>
                      <Field label="Ausweisnummer (optional)">
                        <input className="input" value={counterpartyIdNumber} onChange={(e) => setCounterpartyIdNumber(e.target.value)} placeholder="z.B. Personalausweis" />
                      </Field>
                    </div>
                  ) : null}

                  {isPrivateDiff ? (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <Field label="Plattform (optional)">
                        <input
                          className="input"
                          list="purchase-source-platforms"
                          value={sourcePlatform}
                          onChange={(e) => setSourcePlatform(e.target.value)}
                          placeholder="Kleinanzeigen, eBay, …"
                        />
                        <datalist id="purchase-source-platforms">
                          {(sourcePlatforms.data ?? []).map((p) => (
                            <option key={p} value={p} />
                          ))}
                        </datalist>
                      </Field>
                      <Field label="Listing URL (optional)">
                        <input className="input" value={listingUrl} onChange={(e) => setListingUrl(e.target.value)} placeholder="https://…" />
                      </Field>
                    </div>
                  ) : null}

                  {isPrivateKind ? (
                    <Field label="Notizen (optional)">
                      <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
                    </Field>
                  ) : null}

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <Field label="Zahlungsquelle">
                      <select className="input" value={paymentSource} onChange={(e) => setPaymentSource(e.target.value as PaymentSource)} disabled={kind === "PRIVATE_EQUITY"}>
                        {PAYMENT_SOURCE_OPTIONS.filter((p) => (kind === "PRIVATE_EQUITY" ? p.value === "PRIVATE_EQUITY" : p.value !== "PRIVATE_EQUITY")).map((p) => (
                          <option key={p.value} value={p.value}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Warenbetrag (EUR)">
                      <input className="input" value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} />
                    </Field>
                  </div>

                  {isPrivateDiff ? (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <Field label="Versandkosten (EUR)">
                        <input className="input" value={shippingCost} onChange={(e) => setShippingCost(e.target.value)} />
                      </Field>
                      <Field label="Käuferschutz (EUR)">
                        <input className="input" value={buyerProtectionFee} onChange={(e) => setBuyerProtectionFee(e.target.value)} />
                      </Field>
                    </div>
                  ) : null}

                  {kind === "COMMERCIAL_REGULAR" ? (
                    <>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        <Field label="USt-Satz">
                          <select className="input" value={taxRateBp} onChange={(e) => setTaxRateBp(e.target.value)} disabled={!vatEnabled}>
                            {TAX_RATE_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Externe Rechnungsnr.">
                          <input className="input" value={externalInvoiceNumber} onChange={(e) => setExternalInvoiceNumber(e.target.value)} placeholder="z.B. A-1234" />
                        </Field>
                      </div>
                      <Field label="Beleg Upload">
                        <div className="toolbar">
                          <input
                            className="input"
                            value={receiptUploadPath}
                            onChange={(e) => setReceiptUploadPath(e.target.value)}
                            placeholder="uploads/…"
                          />
                          <label className="btn btn--secondary btn--sm" style={{ cursor: "pointer" }}>
                            <input
                              type="file"
                              style={{ display: "none" }}
                              onChange={async (e) => {
                                const f = e.target.files?.[0];
                                if (!f) return;
                                const out = await api.uploadFile(f);
                                setReceiptUploadPath(out.upload_path);
                                e.currentTarget.value = "";
                              }}
                            />
                            <UploadCloud size={16} /> Datei
                          </label>
                          {receiptUploadPath.trim() ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => api.download(receiptUploadPath.trim(), receiptUploadPath.trim().split("/").pop() ?? "beleg")}
                            >
                              <Download size={16} /> Öffnen
                            </Button>
                          ) : null}
                        </div>
                      </Field>
                    </>
                  ) : null}

                  {!splitOk ? (
                    <InlineAlert tone="error">
                      Verteilung stimmt nicht: Summe Positionen{" "}
                      <span className="mono">{sumLinesCents === null ? "—" : fmtEur(sumLinesCents)}</span> ≠ Warenbetrag{" "}
                      <span className="mono">{fmtEur(totalCents)}</span>.
                    </InlineAlert>
                  ) : null}
                </div>
              </details>

              <details open>
                <summary className="panel-title" style={{ cursor: "pointer" }}>
                  Positionen ({lines.length})
                </summary>
                <div className="stack" style={{ marginTop: 10 }}>
                  <div className="toolbar">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        setLines((s) => [
                          ...s,
                          {
                            ui_id: newId(),
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
                      + Position
                    </Button>
                    <div className="toolbar-spacer" />
                    <span className={splitOk ? "badge badge--ok mono" : "badge badge--warn mono"}>
                      {sumLinesCents === null ? "—" : fmtEur(sumLinesCents)} / {fmtEur(totalCents)}
                    </span>
                  </div>

                  <table className="table">
                    <thead>
                      <tr>
                        <th>Produkt</th>
                        <th>Zustand</th>
                        <th className="numeric">Amazon</th>
                        <th className="numeric">{isPrivateEquity ? "Einlage / EK" : "EK"}</th>
                        {isPrivateEquity ? <th>PAIV</th> : null}
                        <th className="numeric"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l, idx) => {
                        const mp = l.master_product_id ? mpById.get(l.master_product_id) ?? null : null;
                        const market = estimateMarketPriceCents(mp, l.condition);
                        const payout = estimateFbaPayoutCents(market, feeProfileValue);
                        const weights = lines.map((x) => lineEffectiveCents(x, kind) ?? 0);
                        const shipAlloc = allocateProportional(isPrivateDiff ? shippingCostCents : 0, weights);
                        const buyerAlloc = allocateProportional(isPrivateDiff ? buyerProtectionFeeCents : 0, weights);
                        const costBasis = (() => {
                          const cents = lineEffectiveCents(l, kind);
                          if (cents === null) return null;
                          return cents + (shipAlloc[idx] ?? 0) + (buyerAlloc[idx] ?? 0);
                        })();
                        const margin = payout === null || costBasis === null ? null : payout - costBasis;

                        return (
                          <tr key={l.ui_id}>
                            <td style={{ minWidth: 260 }}>
                              <SearchCombo
                                value={l.master_product_id}
                                items={master.data ?? []}
                                loading={master.isPending}
                                getId={(m) => m.id}
                                getLabel={(m) => masterLabel(m)}
                                searchKey={(m) => masterSearchKey(m)}
                                placeholder="Suchen (SKU, Titel, EAN, …)"
                                renderItem={(m) => (
                                  <div>
                                    <div style={{ fontWeight: 650 }}>{m.title}</div>
                                    <div className="muted" style={{ fontSize: 12 }}>
                                      <span className="mono">{m.sku}</span> · {m.platform} · {m.region}
                                      {m.variant ? ` · ${m.variant}` : ""}
                                    </div>
                                  </div>
                                )}
                                onChange={(v) => setLines((s) => s.map((x) => (x.ui_id === l.ui_id ? { ...x, master_product_id: v } : x)))}
                                onCreateNew={(seed) => {
                                  setQuickCreateTargetLineId(l.ui_id);
                                  setQuickCreateTitle(seed.trim());
                                  setQuickCreateOpen(true);
                                }}
                                createLabel={(seed) => (seed ? `Neu anlegen: “${seed}”` : "Neu anlegen")}
                              />
                            </td>
                            <td className="nowrap">
                              <select
                                className="input"
                                value={l.condition}
                                onChange={(e) => setLines((s) => s.map((x) => (x.ui_id === l.ui_id ? { ...x, condition: e.target.value as InventoryCondition } : x)))}
                              >
                                {CONDITION_OPTIONS.map((c) => (
                                  <option key={c.value} value={c.value}>
                                    {c.label}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="numeric mono">
                              <div>{market === null ? "—" : fmtEur(market)}</div>
                              <div className={margin === null ? "muted" : margin >= 0 ? "mono" : "mono"} style={{ fontSize: 12, color: margin === null ? "var(--muted)" : margin >= 0 ? "inherit" : "var(--danger)" }}>
                                {margin === null ? "—" : `${formatEur(margin)} €`}
                              </div>
                            </td>
                            <td className="numeric">
                              <input
                                className="input"
                                style={{ textAlign: "right" }}
                                value={l.purchase_price}
                                onChange={(e) => setLines((s) => s.map((x) => (x.ui_id === l.ui_id ? { ...x, purchase_price: e.target.value } : x)))}
                              />
                              {isPrivateEquity ? (
                                <div style={{ marginTop: 6 }}>
                                  <input
                                    className="input"
                                    style={{ textAlign: "right" }}
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
                                </div>
                              ) : null}
                              {isPrivateDiff ? (
                                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                                  NK-Alloc: {fmtEur((shipAlloc[idx] ?? 0) + (buyerAlloc[idx] ?? 0))}
                                </div>
                              ) : null}
                            </td>
                            {isPrivateEquity ? (
                              <td>
                                <div className="stack" style={{ gap: 8 }}>
                                  <label className="checkbox" style={{ color: "var(--text)", fontSize: 12 }}>
                                    <input
                                      type="checkbox"
                                      checked={l.held_privately_over_12_months}
                                      onChange={(e) =>
                                        setLines((s) =>
                                          s.map((x) => (x.ui_id === l.ui_id ? { ...x, held_privately_over_12_months: e.target.checked } : x)),
                                        )
                                      }
                                    />{" "}
                                    &gt;12 Monate Privatbesitz
                                  </label>
                                  <input
                                    className="input"
                                    placeholder="Begründung Korrektur (optional)"
                                    value={l.valuation_reason}
                                    onChange={(e) =>
                                      setLines((s) => s.map((x) => (x.ui_id === l.ui_id ? { ...x, valuation_reason: e.target.value } : x)))
                                    }
                                  />
                                </div>
                              </td>
                            ) : null}
                            <td className="numeric">
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => setLines((s) => s.filter((x) => x.ui_id !== l.ui_id))}
                              >
                                <Trash2 size={16} />
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                      {!lines.length ? (
                        <tr>
                          <td colSpan={isPrivateEquity ? 6 : 5} className="muted">
                            Keine Positionen.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>

                  {isPrivateEquity ? (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div className="panel" style={{ padding: 12 }}>
                        <div className="panel-title" style={{ fontSize: 13 }}>
                          PAIV Hinweise
                        </div>
                        <div className="panel-sub">Marktvergleich + Besitz 12 Monate (empfohlen).</div>
                        {paivComplianceWarnings.length ? (
                          <ul className="muted" style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12 }}>
                            {paivComplianceWarnings.map((w) => (
                              <li key={w}>{w}</li>
                            ))}
                          </ul>
                        ) : (
                          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                            Keine Warnungen.
                          </div>
                        )}
                      </div>

                      <div className="panel" style={{ padding: 12 }}>
                        <div className="panel-title" style={{ fontSize: 13 }}>
                          Pro Position
                        </div>
                        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                          In der Tabelle: Marktwert + Checkbox + Grund.
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {isPrivateEquity ? (
                    <div className="panel" style={{ padding: 12 }}>
                      <div className="panel-title" style={{ fontSize: 13 }}>
                        PAIV Felder
                      </div>
                      <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                        In den Positionen: Marktwert (EUR) erfassen. Optional: Besitz 12 Monate + Valuation Reason.
                      </div>
                    </div>
                  ) : null}
                </div>
              </details>

              {isPrivateKind ? (
                <details>
                  <summary className="panel-title" style={{ cursor: "pointer" }}>
                    Anhänge
                  </summary>
                  <div className="stack" style={{ marginTop: 10 }}>
                    {stagedAttachmentError ? (
                      <InlineAlert tone="error" onDismiss={() => setStagedAttachmentError(null)}>
                        {stagedAttachmentError}
                      </InlineAlert>
                    ) : null}

                    <div className="toolbar">
                      <label className="btn btn--secondary btn--sm" style={{ cursor: "pointer" }}>
                        <input
                          type="file"
                          multiple
                          style={{ display: "none" }}
                          onChange={async (e) => {
                            const files = Array.from(e.target.files ?? []);
                            e.currentTarget.value = "";
                            await stageAttachmentFiles(files);
                          }}
                        />
                        <UploadCloud size={16} /> Dateien hinzufügen
                      </label>

                      <select className="input" style={{ width: 220 }} value={stagedAttachmentBulkKind} onChange={(e) => setStagedAttachmentBulkKind(e.target.value)}>
                        {ATTACHMENT_KIND_OPTIONS.map((k) => (
                          <option key={k.value} value={k.value}>
                            {k.label}
                          </option>
                        ))}
                      </select>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => setStagedAttachments((prev) => prev.map((a) => ({ ...a, kind: stagedAttachmentBulkKind })))}
                        disabled={!stagedAttachments.length}
                      >
                        Kind anwenden
                      </Button>

                      <div className="toolbar-spacer" />
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        onClick={() => (draftPurchaseId ? linkStagedAttachmentsToPurchase(draftPurchaseId) : setStagedAttachmentError("Einkauf zuerst speichern."))}
                        disabled={!draftPurchaseId || !stagedReady.length || isLinkingStagedAttachments}
                      >
                        {isLinkingStagedAttachments ? "Verknüpfe…" : "Jetzt verknüpfen"}
                      </Button>
                    </div>

                    {stagedAttachments.length ? (
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Datei</th>
                            <th>Kind</th>
                            <th>Position</th>
                            <th className="numeric">Status</th>
                            <th className="numeric"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {stagedAttachments.map((a) => (
                            <tr key={a.local_id}>
                              <td>
                                <div style={{ fontWeight: 650 }}>{a.file_name}</div>
                                <div className="muted" style={{ fontSize: 12 }}>
                                  {formatFileSize(a.file_size)}
                                </div>
                              </td>
                              <td className="nowrap">
                                <select
                                  className="input"
                                  value={a.kind}
                                  onChange={(e) => setStagedAttachments((s) => s.map((x) => (x.local_id === a.local_id ? { ...x, kind: e.target.value } : x)))}
                                >
                                  {ATTACHMENT_KIND_OPTIONS.map((k) => (
                                    <option key={k.value} value={k.value}>
                                      {k.label}
                                    </option>
                                  ))}
                                </select>
                                <input
                                  className="input"
                                  style={{ marginTop: 6 }}
                                  placeholder="Notiz (optional)"
                                  value={a.note}
                                  onChange={(e) => setStagedAttachments((s) => s.map((x) => (x.local_id === a.local_id ? { ...x, note: e.target.value } : x)))}
                                />
                              </td>
                              <td className="nowrap">
                                {kind === "PRIVATE_EQUITY" ? (
                                  <select
                                    className="input"
                                    value={a.purchase_line_id ?? ""}
                                    onChange={(e) =>
                                      setStagedAttachments((s) =>
                                        s.map((x) =>
                                          x.local_id === a.local_id ? { ...x, purchase_line_id: e.target.value || undefined } : x,
                                        ),
                                      )
                                    }
                                  >
                                    <option value="">—</option>
                                    {lineSelectOptions.map((o) => (
                                      <option key={o.id} value={o.id}>
                                        {o.label}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <span className="muted">—</span>
                                )}
                              </td>
                              <td className="numeric mono">
                                {a.status === "uploaded" ? "ok" : a.status === "uploading" ? "…" : a.status}
                                {a.error ? <div style={{ color: "var(--danger)", fontSize: 12 }}>{a.error}</div> : null}
                              </td>
                              <td className="numeric">
                                <Button type="button" size="sm" variant="ghost" onClick={() => setStagedAttachments((s) => s.filter((x) => x.local_id !== a.local_id))}>
                                  <Trash2 size={16} />
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="muted" style={{ fontSize: 13 }}>
                        Keine staged Uploads.
                      </div>
                    )}

                    {draftPurchaseId ? (
                      <>
                        <div className="panel" style={{ padding: 12 }}>
                          <div className="panel-title" style={{ fontSize: 13 }}>
                            Verknüpfte Anhänge
                          </div>
                          <div className="panel-sub">Upload → Link. MARKET_COMP benötigt Position.</div>
                        </div>

                        {purchaseAttachments.isError ? <InlineAlert tone="error">Anhänge konnten nicht geladen werden.</InlineAlert> : null}
                        {purchaseAttachments.data?.length ? (
                          <table className="table">
                            <thead>
                              <tr>
                                <th>Datei</th>
                                <th>Kind</th>
                                <th>Position</th>
                                <th className="numeric"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {(purchaseAttachments.data ?? []).map((a) => (
                                <tr key={a.id}>
                                  <td>
                                    <div style={{ fontWeight: 650 }}>{a.original_filename}</div>
                                    <div className="muted" style={{ fontSize: 12 }}>
                                      {a.note ?? "—"}
                                    </div>
                                  </td>
                                  <td className="mono">{a.kind}</td>
                                  <td className="muted" style={{ fontSize: 12 }}>
                                    {a.purchase_line_id ? (mpById.get(lines.find((l) => l.purchase_line_id === a.purchase_line_id)?.master_product_id ?? "")?.title ?? a.purchase_line_id) : "—"}
                                  </td>
                                  <td className="numeric nowrap">
                                    <Button type="button" size="sm" variant="ghost" onClick={() => api.download(a.upload_path, a.original_filename)}>
                                      <Download size={16} /> Öffnen
                                    </Button>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => deletePurchaseAttachment.mutate({ purchaseId: draftPurchaseId, attachmentId: a.id })}
                                      disabled={deletePurchaseAttachment.isPending}
                                    >
                                      <Trash2 size={16} />
                                    </Button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <div className="muted" style={{ fontSize: 13 }}>
                            Noch keine Anhänge verknüpft.
                          </div>
                        )}
                      </>
                    ) : null}
                  </div>
                </details>
              ) : null}

              <details>
                <summary className="panel-title" style={{ cursor: "pointer" }}>
                  Fahrt (optional)
                </summary>
                <div className="stack" style={{ marginTop: 10 }}>
                  <label className="checkbox">
                    <input type="checkbox" checked={withMileage} onChange={(e) => setWithMileage(e.target.checked)} /> Fahrt verknüpfen
                  </label>

                  {withMileage ? (
                    <>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        <Field label="Datum">
                          <input className="input" type="date" value={mileageLogDate} onChange={(e) => setMileageLogDate(e.target.value)} />
                        </Field>
                        <Field label="km">
                          <input className="input" value={mileageKm} onChange={(e) => setMileageKm(e.target.value)} placeholder="z.B. 12,40" />
                        </Field>
                      </div>
                      <Field label="Start">
                        <input className="input" value={mileageStartLocation} onChange={(e) => setMileageStartLocation(e.target.value)} placeholder="Adresse / Ort" />
                      </Field>
                      <Field label="Ziel">
                        <input className="input" value={mileageDestination} onChange={(e) => setMileageDestination(e.target.value)} placeholder="Adresse / Ort" />
                      </Field>
                      <Field label="Zweck (optional)">
                        <input className="input" value={mileagePurposeText} onChange={(e) => setMileagePurposeText(e.target.value)} placeholder="z.B. Einkauf, Post, …" />
                      </Field>

                      <div className="toolbar">
                        <Button type="button" size="sm" variant="secondary" onClick={calculateMileageRoute} disabled={mileageRoutePending}>
                          <MapPinned size={16} /> {mileageRoutePending ? "Berechne…" : "Route berechnen"}
                        </Button>
                        <label className="checkbox">
                          <input type="checkbox" checked={mileageRoundTrip} onChange={(e) => setMileageRoundTrip(e.target.checked)} /> Hin & zurück
                        </label>
                        <div className="toolbar-spacer" />
                        {mileageRouteError ? <span style={{ color: "var(--danger)", fontSize: 12 }}>{mileageRouteError}</span> : null}
                      </div>

                      {mileageRoutePreview ? <RouteMap route={mileageRoutePreview} /> : null}
                    </>
                  ) : (
                    <div className="muted" style={{ fontSize: 13 }}>
                      Kein Fahrteintrag.
                    </div>
                  )}
                </div>
              </details>
            </div>
          ) : selectedPurchase ? (
            <div className="stack">
              <div className="toolbar" style={{ justifyContent: "space-between" }}>
                <div>
                  <div className="panel-title">Einkauf</div>
                  <div className="panel-sub">
                    <span className="mono">{selectedPurchase.id}</span>
                  </div>
                </div>
                <div className="toolbar">
                  {selectedPurchase.pdf_path ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => api.download(selectedPurchase.pdf_path!, selectedPurchase.pdf_path!.split("/").pop() ?? "eigenbeleg.pdf")}
                    >
                      <Download size={16} /> PDF
                    </Button>
                  ) : selectedPurchase.kind === "PRIVATE_DIFF" || selectedPurchase.kind === "PRIVATE_EQUITY" ? (
                    <Button variant="secondary" size="sm" onClick={() => generatePdf.mutate(selectedPurchase.id)} disabled={generatePdf.isPending}>
                      <Download size={16} /> PDF erstellen
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" disabled>
                      PDF —
                    </Button>
                  )}

                  {lockedSelected ? (
                    <Button variant="primary" size="sm" onClick={() => reopenPurchase.mutate(selectedPurchase.id)} disabled={reopenPurchase.isPending}>
                      <Undo2 size={16} /> Reopen
                    </Button>
                  ) : (
                    <Button variant="primary" size="sm" onClick={openEditorForSelected} disabled={!canEditSelected}>
                      <Pencil size={16} /> Bearbeiten
                    </Button>
                  )}

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const ok = window.confirm("Einkauf wirklich löschen? (Nur möglich, solange Items noch verfügbar sind.)");
                      if (!ok) return;
                      deletePurchase.mutate(selectedPurchase.id);
                    }}
                    disabled={deletePurchase.isPending}
                  >
                    <Trash2 size={16} /> Löschen
                  </Button>
                </div>
              </div>

              <div className="kv">
                <div className="k">Datum</div>
                <div className="v mono">{selectedPurchase.purchase_date}</div>
                <div className="k">Art</div>
                <div className="v">{optionLabel(KIND_OPTIONS, selectedPurchase.kind)}</div>
                <div className="k">Gegenpartei</div>
                <div className="v">{selectedPurchase.counterparty_name}</div>
                <div className="k">Quelle</div>
                <div className="v">{selectedPurchase.source_platform ?? "—"}</div>
                <div className="k">Waren</div>
                <div className="v mono">{fmtEur(selectedPurchase.total_amount_cents)}</div>
                <div className="k">NK</div>
                <div className="v mono">{fmtEur(selectedPurchase.shipping_cost_cents + selectedPurchase.buyer_protection_fee_cents)}</div>
                <div className="k">Bezahlt</div>
                <div className="v mono">{fmtEur(selectedPurchase.total_amount_cents + selectedPurchase.shipping_cost_cents + selectedPurchase.buyer_protection_fee_cents)}</div>
                <div className="k">Beleg</div>
                <div className="v">{selectedPurchase.document_number ? <span className="badge mono">{selectedPurchase.document_number}</span> : "—"}</div>
                <div className="k">PDF</div>
                <div className="v">{selectedPurchase.pdf_path ? selectedPurchase.pdf_path.split("/").pop() : "—"}</div>
                <div className="k">Fahrt</div>
                <div className="v">{selectedPurchase.primary_mileage_log_id ? <span className="badge badge--ok mono">linked</span> : "—"}</div>
              </div>

              <div className="panel" style={{ padding: 12 }}>
                <div className="panel-title" style={{ fontSize: 13 }}>
                  Positionen
                </div>
                <div className="panel-sub">Summe: {fmtEur(selectedPurchase.total_amount_cents)}</div>
                <table className="table" style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>Produkt</th>
                      <th>Zustand</th>
                      <th className="numeric">EK</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedPurchase.lines.map((l) => {
                      const mp = mpById.get(l.master_product_id) ?? null;
                      return (
                        <tr key={l.id}>
                          <td>
                            <div style={{ fontWeight: 650 }}>{mp?.title ?? l.master_product_id}</div>
                            <div className="muted" style={{ fontSize: 12 }}>
                              {mp ? <span className="mono">{mp.sku}</span> : null} {mp ? `· ${mp.platform} · ${mp.region}` : ""}
                            </div>
                          </td>
                          <td>{optionLabel(CONDITION_OPTIONS, l.condition)}</td>
                          <td className="numeric mono">{fmtEur(l.purchase_price_cents)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 13 }}>
              Einkauf auswählen oder „Neu“ starten.
            </div>
          )}
        </div>
      </div>

      <Modal
        open={quickCreateOpen}
        title="Produkt anlegen"
        description="Minimaler Quick-Create (kann später in Produktstamm ergänzt werden)."
        onClose={() => {
          if (quickCreate.isPending) return;
          setQuickCreateOpen(false);
        }}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setQuickCreateOpen(false)} disabled={quickCreate.isPending}>
              Abbrechen
            </Button>
            <Button type="button" variant="primary" onClick={() => quickCreate.mutate()} disabled={quickCreate.isPending}>
              {quickCreate.isPending ? "Speichere…" : "Anlegen"}
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label="Art">
            <select className="input" value={quickCreateKind} onChange={(e) => setQuickCreateKind(e.target.value as MasterProductKind)}>
              <option value="GAME">Spiel</option>
              <option value="CONSOLE">Konsole</option>
              <option value="ACCESSORY">Zubehör</option>
              <option value="OTHER">Sonstiges</option>
            </select>
          </Field>
          <Field label="Titel">
            <input className="input" value={quickCreateTitle} onChange={(e) => setQuickCreateTitle(e.target.value)} />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Plattform">
              <input className="input" value={quickCreatePlatform} onChange={(e) => setQuickCreatePlatform(e.target.value)} placeholder="z.B. GameCube" />
            </Field>
            <Field label="Region">
              <input className="input" value={quickCreateRegion} onChange={(e) => setQuickCreateRegion(e.target.value)} placeholder="EU" />
            </Field>
          </div>
          <Field label="Variante (optional)">
            <input className="input" value={quickCreateVariant} onChange={(e) => setQuickCreateVariant(e.target.value)} placeholder="z.B. Black Label" />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
