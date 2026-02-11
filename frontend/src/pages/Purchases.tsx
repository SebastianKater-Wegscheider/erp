import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { useTaxProfile } from "../lib/taxProfile";
import { AmazonFeeProfile, estimateFbaPayout, estimateMargin, estimateMarketPriceForInventoryCondition } from "../lib/amazon";
import { formatEur, parseEurToCents } from "../lib/money";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
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
  lines: Array<{
    id: string;
    master_product_id: string;
    condition: string;
    purchase_type: string;
    purchase_price_cents: number;
    shipping_allocated_cents: number;
    buyer_protection_fee_allocated_cents: number;
  }>;
};

type PurchaseAttachmentOut = {
  id: string;
  purchase_id: string;
  upload_path: string;
  original_filename: string;
  kind: string;
  note?: string | null;
  created_at: string;
  updated_at: string;
};

type UploadOut = { upload_path: string };

type Line = {
  ui_id: string;
  purchase_line_id?: string;
  master_product_id: string;
  condition: string;
  purchase_price: string;
};

type StagedAttachment = {
  local_id: string;
  file: File;
  file_name: string;
  file_size: number;
  mime_type: string;
  kind: string;
  note: string;
  status: "queued" | "uploading" | "uploaded" | "error";
  upload_path?: string;
  error?: string;
};

const PURCHASE_KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "PRIVATE_DIFF", label: "Privat (Differenz)" },
  { value: "COMMERCIAL_REGULAR", label: "Gewerblich (Regulär)" },
];

const PAYMENT_SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "CASH", label: "Bar" },
  { value: "BANK", label: "Bank" },
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

const DEFAULT_SOURCE_PLATFORMS = ["kleinanzeigen", "ebay", "willhaben.at", "ländleanzeiger.at"];

const PURCHASE_ATTACHMENT_KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "LISTING", label: "Anzeige" },
  { value: "CHAT", label: "Konversation" },
  { value: "PAYMENT", label: "Zahlung" },
  { value: "DELIVERY", label: "Versand" },
  { value: "OTHER", label: "Sonstiges" },
];

const PLATFORM_NONE = "__NONE__";
const PLATFORM_OTHER = "__OTHER__";

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

function inferAttachmentKind(file: File): string {
  const normalizedName = file.name.toLowerCase();
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
            className="z-[45] overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-950"
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
          document.body,
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

  const sourcePlatformSuggestions = useQuery({
    queryKey: ["purchases", "source-platforms"],
    queryFn: () => api.request<string[]>("/purchases/source-platforms"),
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

  const [editingPurchaseId, setEditingPurchaseId] = useState<string | null>(null);
  const [kind, setKind] = useState<string>("PRIVATE_DIFF");
  const [purchaseDate, setPurchaseDate] = useState<string>(() => todayIsoLocal());
  const [counterpartyName, setCounterpartyName] = useState("");
  const [counterpartyAddress, setCounterpartyAddress] = useState("");
  const [counterpartyBirthdate, setCounterpartyBirthdate] = useState("");
  const [counterpartyIdNumber, setCounterpartyIdNumber] = useState("");
  const [sourcePlatform, setSourcePlatform] = useState("");
  const [sourcePlatformMode, setSourcePlatformMode] = useState<"PRESET" | "CUSTOM">("PRESET");
  const [listingUrl, setListingUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [identityFieldsOpen, setIdentityFieldsOpen] = useState(false);
  const [paymentSource, setPaymentSource] = useState<string>("CASH");
  const [totalAmount, setTotalAmount] = useState<string>("0,00");
  const [shippingCost, setShippingCost] = useState<string>("0,00");
  const [buyerProtectionFee, setBuyerProtectionFee] = useState<string>("0,00");

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

  const purchaseType = kind === "PRIVATE_DIFF" ? "DIFF" : "REGULAR";
  const purchaseDateValid = /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate);

  const totalCentsParsed = useMemo(() => parseMoneyInputToCents(totalAmount), [totalAmount]);
  const shippingCostCentsParsed = useMemo(
    () => (kind === "PRIVATE_DIFF" ? parseMoneyInputToCents(shippingCost) : 0),
    [kind, shippingCost],
  );
  const buyerProtectionFeeCentsParsed = useMemo(
    () => (kind === "PRIVATE_DIFF" ? parseMoneyInputToCents(buyerProtectionFee) : 0),
    [kind, buyerProtectionFee],
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
      try {
        sum += parseEurToCents(l.purchase_price);
      } catch {
        return null;
      }
    }
    return sum;
  }, [lines]);

  const splitOk = sumLinesCents !== null && sumLinesCents === totalCents;
  const allLinesHaveProduct = lines.every((l) => !!l.master_product_id.trim());

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
      const payload = ready.map((item) => ({
        upload_path: item.upload_path!,
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
        counterparty_birthdate: kind === "PRIVATE_DIFF" ? counterpartyBirthdate || null : null,
        counterparty_id_number:
          kind === "PRIVATE_DIFF" ? (counterpartyIdNumber.trim() ? counterpartyIdNumber.trim() : null) : null,
        source_platform: kind === "PRIVATE_DIFF" ? (sourcePlatform.trim() ? sourcePlatform.trim() : null) : null,
        listing_url: kind === "PRIVATE_DIFF" ? (listingUrl.trim() ? listingUrl.trim() : null) : null,
        notes: kind === "PRIVATE_DIFF" ? (notes.trim() ? notes.trim() : null) : null,
        total_amount_cents: totalCents,
        shipping_cost_cents: kind === "PRIVATE_DIFF" ? shippingCostCents : 0,
        buyer_protection_fee_cents: kind === "PRIVATE_DIFF" ? buyerProtectionFeeCents : 0,
        tax_rate_bp: kind === "COMMERCIAL_REGULAR" ? (vatEnabled ? Number(taxRateBp) : 0) : 0,
        payment_source: paymentSource,
        external_invoice_number: kind === "COMMERCIAL_REGULAR" ? externalInvoiceNumber : null,
        receipt_upload_path: kind === "COMMERCIAL_REGULAR" ? receiptUploadPath : null,
        lines: lines.map((l) => ({
          master_product_id: l.master_product_id,
          condition: l.condition,
          purchase_type: purchaseType,
          purchase_price_cents: parseEurToCents(l.purchase_price),
        })),
      };
      return api.request<PurchaseOut>("/purchases", { method: "POST", json: payload });
    },
    onSuccess: async (created) => {
      if (kind === "PRIVATE_DIFF") {
        try {
          await linkStagedAttachmentsToPurchase(created.id);
        } catch (error) {
          setStagedAttachmentError((error as Error)?.message ?? "Anhaenge konnten nicht verknuepft werden");
          setEditingPurchaseId(created.id);
          setFormOpen(true);
          setFormTab("ATTACHMENTS");
          await qc.invalidateQueries({ queryKey: ["purchases"] });
          await qc.invalidateQueries({ queryKey: ["purchases", "source-platforms"] });
          return;
        }
      }
      resetFormDraft();
      setFormOpen(false);
      await qc.invalidateQueries({ queryKey: ["purchases"] });
      await qc.invalidateQueries({ queryKey: ["purchases", "source-platforms"] });
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
        counterparty_birthdate: kind === "PRIVATE_DIFF" ? counterpartyBirthdate || null : null,
        counterparty_id_number:
          kind === "PRIVATE_DIFF" ? (counterpartyIdNumber.trim() ? counterpartyIdNumber.trim() : null) : null,
        source_platform: kind === "PRIVATE_DIFF" ? (sourcePlatform.trim() ? sourcePlatform.trim() : null) : null,
        listing_url: kind === "PRIVATE_DIFF" ? (listingUrl.trim() ? listingUrl.trim() : null) : null,
        notes: kind === "PRIVATE_DIFF" ? (notes.trim() ? notes.trim() : null) : null,
        total_amount_cents: totalCents,
        shipping_cost_cents: kind === "PRIVATE_DIFF" ? shippingCostCents : 0,
        buyer_protection_fee_cents: kind === "PRIVATE_DIFF" ? buyerProtectionFeeCents : 0,
        tax_rate_bp: kind === "COMMERCIAL_REGULAR" ? (vatEnabled ? Number(taxRateBp) : 0) : 0,
        payment_source: paymentSource,
        external_invoice_number: kind === "COMMERCIAL_REGULAR" ? externalInvoiceNumber : null,
        receipt_upload_path: kind === "COMMERCIAL_REGULAR" ? receiptUploadPath : null,
        lines: lines.map((l) => ({
          id: l.purchase_line_id ?? null,
          master_product_id: l.master_product_id,
          condition: l.condition,
          purchase_type: purchaseType,
          purchase_price_cents: parseEurToCents(l.purchase_price),
        })),
      };
      return api.request<PurchaseOut>(`/purchases/${editingPurchaseId}`, { method: "PUT", json: payload });
    },
    onSuccess: async (updatedPurchase) => {
      if (kind === "PRIVATE_DIFF") {
        try {
          await linkStagedAttachmentsToPurchase(updatedPurchase.id);
        } catch (error) {
          setStagedAttachmentError((error as Error)?.message ?? "Anhaenge konnten nicht verknuepft werden");
          setFormTab("ATTACHMENTS");
          setFormOpen(true);
          await qc.invalidateQueries({ queryKey: ["purchases"] });
          await qc.invalidateQueries({ queryKey: ["purchases", "source-platforms"] });
          return;
        }
      }
      resetFormDraft();
      setFormOpen(false);
      await qc.invalidateQueries({ queryKey: ["purchases"] });
      await qc.invalidateQueries({ queryKey: ["purchases", "source-platforms"] });
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

  const canSubmit =
    purchaseDateValid &&
    counterpartyName.trim() &&
    lines.length > 0 &&
    allLinesHaveProduct &&
    splitOk &&
    totalCentsParsed !== null &&
    (kind !== "PRIVATE_DIFF" || extraCostsValid) &&
    (kind === "PRIVATE_DIFF" || (externalInvoiceNumber.trim() && receiptUploadPath.trim()));

  const platformOptions = useMemo(() => {
    const set = new Set<string>();
    for (const m of master.data ?? []) {
      if (m.platform?.trim()) set.add(m.platform.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [master.data]);

  const sourcePlatformOptions = useMemo(() => {
    const out = new Set<string>(DEFAULT_SOURCE_PLATFORMS);
    for (const entry of sourcePlatformSuggestions.data ?? []) {
      const normalized = (entry ?? "").trim();
      if (normalized) out.add(normalized);
    }
    return Array.from(out).sort((a, b) => a.localeCompare(b));
  }, [sourcePlatformSuggestions.data]);

  const sourcePlatformSelectValue =
    sourcePlatformMode === "CUSTOM"
      ? PLATFORM_OTHER
      : sourcePlatform.trim()
        ? sourcePlatform.trim()
        : PLATFORM_NONE;

  const quickCreatePlatformSelectValue =
    quickCreatePlatformMode === "CUSTOM"
      ? PLATFORM_OTHER
      : quickCreatePlatform.trim()
        ? quickCreatePlatform.trim()
        : PLATFORM_NONE;

  useEffect(() => {
    if (kind !== "PRIVATE_DIFF" && formTab === "ATTACHMENTS") {
      setFormTab("BASICS");
    }
  }, [kind, formTab]);

  const stagedUploadCount = stagedAttachments.length;
  const stagedReadyCount = stagedAttachments.filter((item) => item.status === "uploaded" && item.upload_path).length;
  const stagedUploadingCount = stagedAttachments.filter((item) => item.status === "uploading").length;
  const stagedQueuedCount = stagedAttachments.filter((item) => item.status === "queued").length;
  const stagedErrorCount = stagedAttachments.filter((item) => item.status === "error").length;

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
    setSourcePlatformMode("PRESET");
    setListingUrl("");
    setNotes("");
    setIdentityFieldsOpen(false);
    setPaymentSource("CASH");
    setTotalAmount("0,00");
    setShippingCost("0,00");
    setBuyerProtectionFee("0,00");
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
    setSourcePlatform(p.source_platform ?? "");
    setSourcePlatformMode(p.source_platform?.trim() ? (sourcePlatformOptions.includes(p.source_platform.trim()) ? "PRESET" : "CUSTOM") : "PRESET");
    setListingUrl(p.listing_url ?? "");
    setNotes(p.notes ?? "");
    setIdentityFieldsOpen(false);
    setPaymentSource(p.payment_source);
    setTotalAmount(formatEur(p.total_amount_cents));
    setShippingCost(formatEur(p.shipping_cost_cents ?? 0));
    setBuyerProtectionFee(formatEur(p.buyer_protection_fee_cents ?? 0));
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
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-xl font-semibold">Einkäufe</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Einkäufe erfassen, Belege hochladen und Eigenbelege als PDF erstellen.
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button variant="secondary" className="w-full sm:w-auto" onClick={() => list.refetch()} disabled={list.isFetching}>
            <RefreshCw className="h-4 w-4" />
            Aktualisieren
          </Button>
          <Button className="w-full sm:w-auto" onClick={openCreateForm}>
            <Plus className="h-4 w-4" />
            {editingPurchaseId ? "Neuer Einkauf" : "Einkauf erfassen"}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-col gap-1">
            <CardTitle>Historie</CardTitle>
            <CardDescription>
              {list.isPending ? "Lade…" : `${(list.data ?? []).length} Einkäufe`}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">

          {list.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
              {(list.error as Error).message}
            </div>
          )}
          {(generatePdf.isError || reopenPurchase.isError) && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
              {String(((generatePdf.error as Error) ?? (reopenPurchase.error as Error))?.message ?? "Unbekannter Fehler")}
            </div>
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
              (list.data ?? []).map((p) => {
                const extraCosts = (p.shipping_cost_cents ?? 0) + (p.buyer_protection_fee_cents ?? 0);
                const totalPaid = (p.total_amount_cents ?? 0) + extraCosts;
                return (
                  <div
                    key={p.id}
                    className="rounded-md border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-800 dark:bg-gray-900"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
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
                        </div>

                        <div className="mt-2">
                          <div className="truncate font-medium text-gray-900 dark:text-gray-100">{p.counterparty_name}</div>
                          {p.source_platform ? (
                            <div className="truncate text-xs text-gray-500 dark:text-gray-400">{p.source_platform}</div>
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
                      ) : p.kind === "PRIVATE_DIFF" ? (
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
                          disabled={create.isPending || update.isPending}
                        >
                          Bearbeiten
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          className="w-full sm:flex-1"
                          onClick={() => reopenPurchase.mutate(p.id)}
                          disabled={reopenPurchase.isPending || create.isPending || update.isPending}
                        >
                          Zur Bearbeitung öffnen
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}

            {!list.isPending && !list.data?.length && (
              <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-300">
                Keine Daten.
              </div>
            )}
          </div>

          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
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
                {(list.data ?? []).map((p) => (
                  <TableRow key={p.id}>
                    {(() => {
                      const extraCosts = (p.shipping_cost_cents ?? 0) + (p.buyer_protection_fee_cents ?? 0);
                      const totalPaid = (p.total_amount_cents ?? 0) + extraCosts;
                      return (
                        <>
                          <TableCell>{formatDateEuFromIso(p.purchase_date)}</TableCell>
                          <TableCell>{optionLabel(PURCHASE_KIND_OPTIONS, p.kind)}</TableCell>
                          <TableCell>
                            <div>{p.counterparty_name}</div>
                            {p.source_platform ? (
                              <div className="text-xs text-gray-500 dark:text-gray-400">{p.source_platform}</div>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right">{formatEur(p.total_amount_cents)} €</TableCell>
                          <TableCell className="text-right">{formatEur(extraCosts)} €</TableCell>
                          <TableCell className="text-right">{formatEur(totalPaid)} €</TableCell>
                        </>
                      );
                    })()}
                    <TableCell className="text-right">
                      <div className="inline-flex items-center justify-end gap-2">
                        {p.pdf_path ? (
                          <Dialog>
                            <DialogTrigger asChild>
                              <Button variant="outline">PDF</Button>
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
                        ) : p.kind === "PRIVATE_DIFF" ? (
                          <Button size="sm" variant="outline" onClick={() => generatePdf.mutate(p.id)} disabled={generatePdf.isPending}>
                            Eigenbeleg erstellen
                          </Button>
                        ) : (
                          <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                        )}

                        {!p.pdf_path && (
                          <Button size="sm" variant="secondary" onClick={() => startEdit(p)} disabled={create.isPending || update.isPending}>
                            Bearbeiten
                          </Button>
                        )}
                        {p.pdf_path && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => reopenPurchase.mutate(p.id)}
                            disabled={reopenPurchase.isPending || create.isPending || update.isPending}
                          >
                            Zur Bearbeitung öffnen
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {!list.data?.length && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-sm text-gray-500 dark:text-gray-400">
                      Keine Daten.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={formOpen || !!editingPurchaseId}
        onOpenChange={(open) => {
          if (!open) closeForm();
        }}
      >
        <DialogContent className="flex h-[min(92dvh,900px)] w-[min(96vw,1180px)] max-w-6xl flex-col overflow-hidden p-0">
          <DialogHeader className="border-b border-gray-200 bg-gray-50/70 px-6 pb-4 pt-5 dark:border-gray-800 dark:bg-gray-900/30">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Einkauf</div>
            <DialogTitle className="text-2xl">{editingPurchaseId ? "Einkauf bearbeiten" : "Einkauf erfassen"}</DialogTitle>
            <DialogDescription>
              {editingPurchaseId ? `ID: ${editingPurchaseId}` : "Schnellerfassung in Tabs: Eckdaten, Positionen, Nachweise."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col bg-white dark:bg-gray-900">
            <Tabs value={formTab} onValueChange={(value) => setFormTab(value as "BASICS" | "POSITIONS" | "ATTACHMENTS")} className="flex min-h-0 flex-1 flex-col">
              <TabsList className="mx-6 mt-4 h-auto w-full justify-start gap-1 overflow-x-auto">
                <TabsTrigger value="BASICS">Eckdaten</TabsTrigger>
                <TabsTrigger value="POSITIONS">Positionen</TabsTrigger>
                <TabsTrigger value="ATTACHMENTS" disabled={kind !== "PRIVATE_DIFF"}>
                  Nachweise
                </TabsTrigger>
              </TabsList>

              <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-6 pb-4">
                <TabsContent value="BASICS" className="space-y-4 rounded-xl border border-gray-200 bg-gray-50/40 p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950/20">
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
                      <Select value={paymentSource} onValueChange={setPaymentSource}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PAYMENT_SOURCE_OPTIONS.map((p) => (
                            <SelectItem key={p.value} value={p.value}>
                              {p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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

                  {kind === "PRIVATE_DIFF" && (
                    <>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label>Plattform / Quelle</Label>
                          <Select
                            value={sourcePlatformSelectValue}
                            onValueChange={(value) => {
                              if (value === PLATFORM_OTHER) {
                                setSourcePlatformMode("CUSTOM");
                                if (!sourcePlatform.trim()) setSourcePlatform("");
                                return;
                              }
                              if (value === PLATFORM_NONE) {
                                setSourcePlatformMode("PRESET");
                                setSourcePlatform("");
                                return;
                              }
                              setSourcePlatformMode("PRESET");
                              setSourcePlatform(value);
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={PLATFORM_NONE}>Keine Angabe</SelectItem>
                              {sourcePlatformOptions.map((entry) => (
                                <SelectItem key={entry} value={entry}>
                                  {entry}
                                </SelectItem>
                              ))}
                              <SelectItem value={PLATFORM_OTHER}>Andere …</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>Anzeige-URL (optional)</Label>
                          <Input value={listingUrl} onChange={(e) => setListingUrl(e.target.value)} placeholder="https://..." />
                        </div>
                      </div>

                      {sourcePlatformMode === "CUSTOM" && (
                        <div className="space-y-2">
                          <Label>Eigene Plattform</Label>
                          <Input
                            value={sourcePlatform}
                            onChange={(e) => setSourcePlatform(e.target.value)}
                            placeholder="z.B. Flohmarkt, Forum, local trade"
                          />
                        </div>
                      )}

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

                      <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium">Identitaetsdaten (selten benoetigt)</div>
                          <Button type="button" variant="outline" onClick={() => setIdentityFieldsOpen((open) => !open)}>
                            {identityFieldsOpen ? "Ausblenden" : "Einblenden"}
                          </Button>
                        </div>
                        {identityFieldsOpen && (
                          <div className="mt-3 grid gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                              <Label>Geburtsdatum (optional)</Label>
                              <Input type="date" value={counterpartyBirthdate} onChange={(e) => setCounterpartyBirthdate(e.target.value)} />
                            </div>
                            <div className="space-y-2">
                              <Label>Ausweisnummer (optional)</Label>
                              <Input value={counterpartyIdNumber} onChange={(e) => setCounterpartyIdNumber(e.target.value)} placeholder="z.B. Reisepass / Personalausweis" />
                            </div>
                          </div>
                        )}
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

                <TabsContent value="POSITIONS" className="space-y-3 rounded-xl border border-gray-200 bg-gray-50/40 p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950/20">
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
                          { ui_id: newLineId(), master_product_id: "", condition: "GOOD", purchase_price: "0,00" },
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
                        <TableHead className="text-right">EK (EUR)</TableHead>
                        <TableHead className="text-right"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(() => {
                        const weights = lines.map((l) => parseMoneyInputToCents(l.purchase_price) ?? 0);
                        const shipAlloc = allocateProportional(kind === "PRIVATE_DIFF" ? shippingCostCents : 0, weights);
                        const buyerAlloc = allocateProportional(kind === "PRIVATE_DIFF" ? buyerProtectionFeeCents : 0, weights);
                        const feeTitle = `FBA Fees: referral ${(feeProfileValue.referral_fee_bp / 100).toFixed(2)}% + fulfillment ${formatEur(feeProfileValue.fulfillment_fee_cents)} € + inbound ${formatEur(feeProfileValue.inbound_shipping_cents)} €`;

                        return lines.map((l, idx) => {
                          const mp = l.master_product_id ? masterById.get(l.master_product_id) ?? null : null;
                          const market = estimateMarketPriceForInventoryCondition(mp, l.condition);
                          const payout = estimateFbaPayout(market.cents, feeProfileValue);
                          const purchaseCents = parseMoneyInputToCents(l.purchase_price);
                          const costBasis =
                            typeof purchaseCents === "number" ? purchaseCents + (shipAlloc[idx] ?? 0) + (buyerAlloc[idx] ?? 0) : null;
                          const margin = estimateMargin(payout.payout_cents, costBasis);

                          return (
                            <TableRow key={l.ui_id}>
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
                                <Input
                                  className="text-right"
                                  value={l.purchase_price}
                                  onChange={(e) =>
                                    setLines((s) => s.map((x) => (x.ui_id === l.ui_id ? { ...x, purchase_price: e.target.value } : x)))
                                  }
                                />
                              </TableCell>
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
                          <TableCell colSpan={5} className="text-sm text-gray-500 dark:text-gray-400">
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
                    {kind === "PRIVATE_DIFF" && (
                      <Button type="button" variant="outline" onClick={() => setFormTab("ATTACHMENTS")}>
                        Weiter zu Nachweisen
                      </Button>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="ATTACHMENTS" className="space-y-4 rounded-xl border border-gray-200 bg-gray-50/40 p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950/20">
                  <div className="border-b border-gray-200 pb-3 dark:border-gray-800">
                    <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">Nachweise</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      Dateien hochladen, Typ mappen und gesammelt am Einkauf verknuepfen.
                    </div>
                  </div>
                  {kind !== "PRIVATE_DIFF" ? (
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
                              <TableHead>Notiz</TableHead>
                              <TableHead className="text-right">Aktion</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {stagedAttachments.map((item) => (
                              <TableRow key={item.local_id}>
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
                                        prev.map((row) => (row.local_id === item.local_id ? { ...row, kind: value } : row)),
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
                              <TableHead>Notiz</TableHead>
                              <TableHead className="text-right">Aktion</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {(purchaseAttachments.data ?? []).map((attachment) => (
                              <TableRow key={attachment.id}>
                                <TableCell>{optionLabel(PURCHASE_ATTACHMENT_KIND_OPTIONS, attachment.kind)}</TableCell>
                                <TableCell className="font-mono text-xs">{attachment.original_filename}</TableCell>
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
                                <TableCell colSpan={4} className="text-sm text-gray-500 dark:text-gray-400">
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

            <div className="mx-6 mt-3 space-y-2 border-t border-gray-200 pb-4 pt-3 dark:border-gray-800">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={splitOk ? "success" : "warning"}>
                  Aufteilung: {sumLinesCents === null ? "ungültig" : `${formatEur(sumLinesCents)} €`} / {formatEur(totalCents)} €
                </Badge>
                {!splitOk && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {editingPurchaseId ? "Speichern" : "Erstellen"} ist blockiert, bis die Summen übereinstimmen.
                  </div>
                )}
                {kind === "PRIVATE_DIFF" && !extraCostsValid && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Versand- und Käuferschutzbetrag müssen gültige, nicht-negative EUR-Werte sein.
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
              </div>
              <div className="flex items-center justify-end gap-2">
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

            {(create.isError || update.isError) && (
              <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                {(((create.error ?? update.error) as Error) ?? new Error("Unbekannter Fehler")).message}
              </div>
            )}
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
