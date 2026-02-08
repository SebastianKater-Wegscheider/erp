import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { useTaxProfile } from "../lib/taxProfile";
import { formatEur, parseEurToCents } from "../lib/money";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
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

function parseDateEuToIso(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;

  // Allow already-ISO values (useful for copy/paste).
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const m = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/.exec(raw);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return null;
  if (year < 1900 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseMoneyInputToCents(input: string): number | null {
  try {
    return parseEurToCents(input);
  } catch {
    return null;
  }
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
  const formRef = useRef<HTMLDivElement | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const master = useQuery({
    queryKey: ["master-products"],
    queryFn: () => api.request<MasterProduct[]>("/master-products"),
  });

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

  const [editingPurchaseId, setEditingPurchaseId] = useState<string | null>(null);
  const [kind, setKind] = useState<string>("PRIVATE_DIFF");
  const [purchaseDate, setPurchaseDate] = useState<string>(() => formatDateEuFromIso(todayIsoLocal()));
  const [counterpartyName, setCounterpartyName] = useState("");
  const [counterpartyAddress, setCounterpartyAddress] = useState("");
  const [counterpartyBirthdate, setCounterpartyBirthdate] = useState("");
  const [counterpartyIdNumber, setCounterpartyIdNumber] = useState("");
  const [sourcePlatform, setSourcePlatform] = useState("");
  const [listingUrl, setListingUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [paymentSource, setPaymentSource] = useState<string>("CASH");
  const [totalAmount, setTotalAmount] = useState<string>("0,00");
  const [shippingCost, setShippingCost] = useState<string>("0,00");
  const [buyerProtectionFee, setBuyerProtectionFee] = useState<string>("0,00");

  const [externalInvoiceNumber, setExternalInvoiceNumber] = useState<string>("");
  const [receiptUploadPath, setReceiptUploadPath] = useState<string>("");
  const [taxRateBp, setTaxRateBp] = useState<string>("2000");
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [attachmentKind, setAttachmentKind] = useState<string>("OTHER");
  const [attachmentNote, setAttachmentNote] = useState<string>("");

  const [lines, setLines] = useState<Line[]>([]);

  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [quickCreateTargetLineId, setQuickCreateTargetLineId] = useState<string | null>(null);
  const [quickCreateKind, setQuickCreateKind] = useState<MasterProductKind>("GAME");
  const [quickCreateTitle, setQuickCreateTitle] = useState("");
  const [quickCreatePlatform, setQuickCreatePlatform] = useState("");
  const [quickCreateRegion, setQuickCreateRegion] = useState("EU");
  const [quickCreateVariant, setQuickCreateVariant] = useState("");

  const purchaseType = kind === "PRIVATE_DIFF" ? "DIFF" : "REGULAR";

  const purchaseDateIso = useMemo(() => parseDateEuToIso(purchaseDate), [purchaseDate]);
  const purchaseDateValid = !!purchaseDateIso;

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

  const addPurchaseAttachments = useMutation({
    mutationFn: async () => {
      if (!editingPurchaseId) throw new Error("Einkauf zuerst speichern");
      if (!attachmentFiles.length) throw new Error("Keine Dateien ausgewählt");

      const uploaded = [];
      for (const file of attachmentFiles) {
        const fd = new FormData();
        fd.append("file", file);
        const out = await api.request<UploadOut>("/uploads", { method: "POST", body: fd });
        uploaded.push({
          upload_path: out.upload_path,
          original_filename: file.name,
          kind: attachmentKind,
          note: attachmentNote.trim() ? attachmentNote.trim() : null,
        });
      }

      return api.request<PurchaseAttachmentOut[]>(`/purchases/${editingPurchaseId}/attachments`, {
        method: "POST",
        json: { attachments: uploaded },
      });
    },
    onSuccess: async () => {
      setAttachmentFiles([]);
      setAttachmentNote("");
      await qc.invalidateQueries({ queryKey: ["purchase-attachments", editingPurchaseId] });
    },
  });

  const deletePurchaseAttachment = useMutation({
    mutationFn: ({ purchaseId, attachmentId }: { purchaseId: string; attachmentId: string }) =>
      api.request<void>(`/purchases/${purchaseId}/attachments/${attachmentId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["purchase-attachments", editingPurchaseId] });
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const purchase_date_iso = parseDateEuToIso(purchaseDate);
      if (!purchase_date_iso) throw new Error("Datum muss im Format TT.MM.JJJJ sein");
      const counterparty_birthdate_iso = parseDateEuToIso(counterpartyBirthdate);
      if (counterpartyBirthdate.trim() && !counterparty_birthdate_iso) {
        throw new Error("Geburtsdatum muss im Format TT.MM.JJJJ sein");
      }
      const payload = {
        kind,
        purchase_date: purchase_date_iso,
        counterparty_name: counterpartyName,
        counterparty_address: counterpartyAddress || null,
        counterparty_birthdate: kind === "PRIVATE_DIFF" ? counterparty_birthdate_iso : null,
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
    onSuccess: async () => {
      setEditingPurchaseId(null);
      setCounterpartyName("");
      setCounterpartyAddress("");
      setCounterpartyBirthdate("");
      setCounterpartyIdNumber("");
      setSourcePlatform("");
      setListingUrl("");
      setNotes("");
      setExternalInvoiceNumber("");
      setReceiptUploadPath("");
      setTotalAmount("0,00");
      setShippingCost("0,00");
      setBuyerProtectionFee("0,00");
      setAttachmentFiles([]);
      setAttachmentNote("");
      setAttachmentKind("OTHER");
      setLines([]);
      setFormOpen(false);
      await qc.invalidateQueries({ queryKey: ["purchases"] });
      await qc.invalidateQueries({ queryKey: ["purchases", "source-platforms"] });
    },
  });

  const update = useMutation({
    mutationFn: async () => {
      if (!editingPurchaseId) throw new Error("Kein Einkauf ausgewählt");
      const purchase_date_iso = parseDateEuToIso(purchaseDate);
      if (!purchase_date_iso) throw new Error("Datum muss im Format TT.MM.JJJJ sein");
      const counterparty_birthdate_iso = parseDateEuToIso(counterpartyBirthdate);
      if (counterpartyBirthdate.trim() && !counterparty_birthdate_iso) {
        throw new Error("Geburtsdatum muss im Format TT.MM.JJJJ sein");
      }
      const payload = {
        kind,
        purchase_date: purchase_date_iso,
        counterparty_name: counterpartyName,
        counterparty_address: counterpartyAddress || null,
        counterparty_birthdate: kind === "PRIVATE_DIFF" ? counterparty_birthdate_iso : null,
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
    onSuccess: async () => {
      setEditingPurchaseId(null);
      setCounterpartyName("");
      setCounterpartyAddress("");
      setCounterpartyBirthdate("");
      setCounterpartyIdNumber("");
      setSourcePlatform("");
      setListingUrl("");
      setNotes("");
      setExternalInvoiceNumber("");
      setReceiptUploadPath("");
      setTotalAmount("0,00");
      setShippingCost("0,00");
      setBuyerProtectionFee("0,00");
      setAttachmentFiles([]);
      setAttachmentNote("");
      setAttachmentKind("OTHER");
      setLines([]);
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

  function openQuickCreate(lineId: string, seedTitle: string) {
    const lastSelected = [...lines]
      .reverse()
      .map((l) => master.data?.find((m) => m.id === l.master_product_id) ?? null)
      .find((m) => m !== null);

    setQuickCreateTargetLineId(lineId);
    setQuickCreateKind(lastSelected?.kind ?? "GAME");
    setQuickCreateTitle(seedTitle.trim());
    setQuickCreatePlatform(lastSelected?.platform ?? "");
    setQuickCreateRegion(lastSelected?.region ?? "EU");
    setQuickCreateVariant("");
    quickCreate.reset();
    setQuickCreateOpen(true);
  }

  function startEdit(p: PurchaseOut) {
    setEditingPurchaseId(p.id);
    setKind(p.kind);
    setPurchaseDate(formatDateEuFromIso(p.purchase_date));
    setCounterpartyName(p.counterparty_name);
    setCounterpartyAddress(p.counterparty_address ?? "");
    setCounterpartyBirthdate(p.counterparty_birthdate ? formatDateEuFromIso(p.counterparty_birthdate) : "");
    setCounterpartyIdNumber(p.counterparty_id_number ?? "");
    setSourcePlatform(p.source_platform ?? "");
    setListingUrl(p.listing_url ?? "");
    setNotes(p.notes ?? "");
    setPaymentSource(p.payment_source);
    setTotalAmount(formatEur(p.total_amount_cents));
    setShippingCost(formatEur(p.shipping_cost_cents ?? 0));
    setBuyerProtectionFee(formatEur(p.buyer_protection_fee_cents ?? 0));
    setExternalInvoiceNumber(p.external_invoice_number ?? "");
    setReceiptUploadPath(p.receipt_upload_path ?? "");
    setTaxRateBp(String(p.tax_rate_bp ?? 2000));
    setAttachmentFiles([]);
    setAttachmentNote("");
    setAttachmentKind("OTHER");
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
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function cancelEdit() {
    setEditingPurchaseId(null);
    setKind("PRIVATE_DIFF");
    setPurchaseDate(formatDateEuFromIso(todayIsoLocal()));
    setCounterpartyName("");
    setCounterpartyAddress("");
    setCounterpartyBirthdate("");
    setCounterpartyIdNumber("");
    setSourcePlatform("");
    setListingUrl("");
    setNotes("");
    setPaymentSource("CASH");
    setTotalAmount("0,00");
    setShippingCost("0,00");
    setBuyerProtectionFee("0,00");
    setExternalInvoiceNumber("");
    setReceiptUploadPath("");
    setTaxRateBp("2000");
    setAttachmentFiles([]);
    setAttachmentNote("");
    setAttachmentKind("OTHER");
    setLines([]);
    create.reset();
    update.reset();
  }

  function openCreateForm() {
    cancelEdit();
    setFormOpen(true);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function closeForm() {
    cancelEdit();
    setFormOpen(false);
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
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => list.refetch()} disabled={list.isFetching}>
            <RefreshCw className="h-4 w-4" />
            Aktualisieren
          </Button>
          <Button onClick={openCreateForm}>
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
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => generatePdf.mutate(p.id)}
                          disabled={generatePdf.isPending}
                        >
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
        </CardContent>
      </Card>

      {(formOpen || editingPurchaseId) && (
        <Card ref={formRef}>
          <CardHeader>
            <CardTitle>{editingPurchaseId ? "Einkauf bearbeiten" : "Einkauf erfassen"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
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
                <Input
                  value={purchaseDate}
                  onChange={(e) => setPurchaseDate(e.target.value)}
                  placeholder="TT.MM.JJJJ"
                  inputMode="numeric"
                />
                {!purchaseDateValid && <div className="text-xs text-red-700 dark:text-red-300">Format: TT.MM.JJJJ</div>}
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
              <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Geburtsdatum (optional)</Label>
                    <Input
                      value={counterpartyBirthdate}
                      onChange={(e) => setCounterpartyBirthdate(e.target.value)}
                      placeholder="TT.MM.JJJJ"
                      inputMode="numeric"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Ausweisnummer (optional)</Label>
                    <Input
                      value={counterpartyIdNumber}
                      onChange={(e) => setCounterpartyIdNumber(e.target.value)}
                      placeholder="z.B. Reisepass / Personalausweis"
                    />
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Plattform / Quelle (optional)</Label>
                    <Input
                      value={sourcePlatform}
                      onChange={(e) => setSourcePlatform(e.target.value)}
                      placeholder="kleinanzeigen, ebay, willhaben.at, ..."
                      list="purchase-source-platform-options"
                    />
                    <datalist id="purchase-source-platform-options">
                      {sourcePlatformOptions.map((entry) => (
                        <option key={entry} value={entry} />
                      ))}
                    </datalist>
                  </div>
                  <div className="space-y-2">
                    <Label>Anzeige-URL (optional)</Label>
                    <Input
                      value={listingUrl}
                      onChange={(e) => setListingUrl(e.target.value)}
                      placeholder="https://..."
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Notizen (optional)</Label>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    placeholder="z.B. Zustand, Bundle-Inhalt, Verhandlungsnotiz ..."
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
              </div>
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

            {kind === "PRIVATE_DIFF" && (
              <Card className="border-dashed">
                <CardHeader>
                  <CardTitle>Evidenzanhänge</CardTitle>
                  <CardDescription>
                    Screenshots, Chatverläufe, Anzeige-Screens oder Zahlungsnachweise am Einkauf hinterlegen.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {!editingPurchaseId ? (
                    <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-200">
                      Anhänge können nach dem ersten Speichern im Bearbeiten-Modus hinzugefügt werden.
                    </div>
                  ) : (
                    <>
                      <div className="grid gap-3 md:grid-cols-4">
                        <div className="space-y-2">
                          <Label>Typ</Label>
                          <Select value={attachmentKind} onValueChange={setAttachmentKind}>
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
                        </div>
                        <div className="space-y-2 md:col-span-2">
                          <Label>Notiz (optional)</Label>
                          <Input value={attachmentNote} onChange={(e) => setAttachmentNote(e.target.value)} placeholder="z.B. Chat bis Preisvereinbarung" />
                        </div>
                        <div className="space-y-2">
                          <Label>Dateien</Label>
                          <Input
                            type="file"
                            multiple
                            onChange={(e) => setAttachmentFiles(Array.from(e.target.files ?? []))}
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {attachmentFiles.length ? `${attachmentFiles.length} Datei(en) ausgewählt` : "Keine Dateien ausgewählt"}
                        </div>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => addPurchaseAttachments.mutate()}
                          disabled={!attachmentFiles.length || addPurchaseAttachments.isPending}
                        >
                          Anhänge hochladen
                        </Button>
                      </div>

                      {(purchaseAttachments.isError || addPurchaseAttachments.isError || deletePurchaseAttachment.isError) && (
                        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                          {(((purchaseAttachments.error ?? addPurchaseAttachments.error ?? deletePurchaseAttachment.error) as Error) ?? new Error("Unbekannter Fehler")).message}
                        </div>
                      )}

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
                                        purchaseId: editingPurchaseId!,
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
                                Noch keine Anhänge.
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </>
                  )}
                </CardContent>
              </Card>
            )}

            <div className="space-y-2">
              <Label>Warenbetrag (EUR, an Verkäufer)</Label>
              <Input value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} />
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
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
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="secondary" onClick={closeForm} disabled={create.isPending || update.isPending}>
                  {editingPurchaseId ? "Abbrechen" : "Schließen"}
                </Button>
                <Button
                  onClick={() => (editingPurchaseId ? update.mutate() : create.mutate())}
                  disabled={!canSubmit || create.isPending || update.isPending}
                >
                  {editingPurchaseId ? "Änderungen speichern" : "Erstellen"}
                </Button>
              </div>
            </div>

            {(create.isError || update.isError) && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
                {(((create.error ?? update.error) as Error) ?? new Error("Unbekannter Fehler")).message}
              </div>
            )}

            <Card className="border-dashed">
              <CardHeader>
                <CardTitle>Positionen</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
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

                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Produkt</TableHead>
                      <TableHead>Zustand</TableHead>
                      <TableHead className="text-right">EK (EUR)</TableHead>
                      <TableHead className="text-right"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map((l) => (
                      <TableRow key={l.ui_id}>
                        <TableCell>
                          <MasterProductCombobox
                            value={l.master_product_id}
                            options={master.data ?? []}
                            loading={master.isPending}
                            placeholder="Suchen (SKU, Titel, EAN, …) oder neu anlegen…"
                            onValueChange={(v) => setLines((s) => s.map((x) => (x.ui_id === l.ui_id ? { ...x, master_product_id: v } : x)))}
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
                        <TableCell className="text-right">
                          <Input
                            className="text-right"
                            value={l.purchase_price}
                            onChange={(e) =>
                              setLines((s) =>
                                s.map((x) => (x.ui_id === l.ui_id ? { ...x, purchase_price: e.target.value } : x)),
                              )
                            }
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" onClick={() => setLines((s) => s.filter((x) => x.ui_id !== l.ui_id))}>
                            Entfernen
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {!lines.length && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-sm text-gray-500 dark:text-gray-400">
                          Noch keine Positionen.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </CardContent>
        </Card>
      )}

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
                <Input
                  value={quickCreatePlatform}
                  onChange={(e) => setQuickCreatePlatform(e.target.value)}
                  placeholder="z.B. Nintendo Gamecube"
                  list="platform-options"
                />
                <datalist id="platform-options">
                  {platformOptions.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
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
