import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import { useApi } from "../lib/api";
import { computeUsedBest, estimateSellThroughFromBsr, formatSellThroughRange } from "../lib/amazon";
import { formatEur, parseEurToCents } from "../lib/money";
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
type MasterProductsViewMode = "catalog" | "amazon";

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

  amazon_last_attempt_at?: string | null;
  amazon_last_success_at?: string | null;
  amazon_last_run_id?: string | null;

  amazon_blocked_last?: boolean | null;
  amazon_block_reason_last?: string | null;
  amazon_last_error?: string | null;

  amazon_rank_overall?: number | null;
  amazon_rank_overall_category?: string | null;
  amazon_rank_specific?: number | null;
  amazon_rank_specific_category?: string | null;

  amazon_price_new_cents?: number | null;
  amazon_price_used_like_new_cents?: number | null;
  amazon_price_used_very_good_cents?: number | null;
  amazon_price_used_good_cents?: number | null;
  amazon_price_used_acceptable_cents?: number | null;
  amazon_price_collectible_cents?: number | null;

  amazon_buybox_total_cents?: number | null;
  amazon_offers_count_total?: number | null;
  amazon_offers_count_priced_total?: number | null;
  amazon_offers_count_used_priced_total?: number | null;

  amazon_next_retry_at?: string | null;
  amazon_consecutive_failures?: number | null;
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

const MASTER_PRODUCTS_VIEW_KEY = "master-products:view";

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

function shortUrlLabel(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, "");
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts.at(-1);
    if (last && last.length <= 28) return `${host} · ${last}`;
    return host;
  } catch {
    return url.length > 32 ? `${url.slice(0, 29)}…` : url;
  }
}

function parseIsoMs(value?: string | null): number | null {
  const s = (value ?? "").trim();
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

function isAmazonStale(m: MasterProduct): boolean {
  if (!m.asin) return false;
  const ms = parseIsoMs(m.amazon_last_success_at);
  if (ms === null) return true;
  return Date.now() - ms > 24 * 60 * 60 * 1000;
}

function fmtMaybeEur(cents?: number | null): string {
  if (cents === null || cents === undefined) return "—";
  return `${formatEur(cents)} €`;
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

type AmazonHistoryPoint = {
  started_at: string;
  ok: boolean;
  blocked: boolean;
  used_best_cents: number | null;
};

type AmazonScrapeRunOut = {
  id: string;
  started_at: string;
  finished_at?: string | null;
  ok: boolean;
  blocked: boolean;
  block_reason?: string | null;
  offers_truncated: boolean;
  error?: string | null;
  dp_url?: string | null;
  offer_listing_url?: string | null;
};

function Sparkline({
  points,
  width = 180,
  height = 34,
}: {
  points: Array<number | null>;
  width?: number;
  height?: number;
}) {
  const xs = points.map((_, i) => (points.length <= 1 ? 0 : (i / (points.length - 1)) * (width - 2) + 1));
  const ysRaw = points.filter((p): p is number => typeof p === "number");
  const min = ysRaw.length ? Math.min(...ysRaw) : 0;
  const max = ysRaw.length ? Math.max(...ysRaw) : 0;
  const span = Math.max(1, max - min);

  function yFor(v: number): number {
    const t = (v - min) / span;
    return (1 - t) * (height - 2) + 1;
  }

  const segments: string[] = [];
  let cur: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const v = points[i];
    if (typeof v !== "number") {
      if (cur.length >= 2) segments.push(`M ${cur[0]} L ${cur.slice(1).join(" ")}`);
      cur = [];
      continue;
    }
    const x = xs[i];
    const y = yFor(v);
    cur.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  if (cur.length >= 2) segments.push(`M ${cur[0]} L ${cur.slice(1).join(" ")}`);

  const d = segments.join(" ");
  const hasData = ysRaw.length >= 2;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block">
      <rect x="0" y="0" width={width} height={height} rx="6" className="fill-gray-50 dark:fill-gray-950/30" />
      {hasData ? (
        <path d={d} fill="none" strokeWidth="2" className="stroke-amber-500 dark:stroke-amber-400" />
      ) : (
        <path
          d={`M 1 ${(height / 2).toFixed(2)} L ${(width - 1).toFixed(2)} ${(height / 2).toFixed(2)}`}
          fill="none"
          strokeWidth="2"
          className="stroke-gray-200 dark:stroke-gray-800"
        />
      )}
    </svg>
  );
}

function AmazonDetails({
  masterProductId,
  lastRunId,
  expanded,
}: {
  masterProductId: string;
  lastRunId: string | null | undefined;
  expanded: boolean;
}) {
  const api = useApi();

  const history = useQuery({
    queryKey: ["amazon-history", masterProductId],
    enabled: expanded,
    queryFn: () =>
      api.request<AmazonHistoryPoint[]>(
        `/amazon-scrapes/history?master_product_id=${encodeURIComponent(masterProductId)}&limit=60`,
      ),
  });

  const run = useQuery({
    queryKey: ["amazon-run", lastRunId ?? ""],
    enabled: expanded && !!lastRunId,
    queryFn: () => api.request<AmazonScrapeRunOut>(`/amazon-scrapes/runs/${encodeURIComponent(lastRunId!)}`),
  });

  const usedSeries = (history.data ?? []).map((p) => p.used_best_cents);

  return (
    <div className="mt-2 rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700 dark:border-gray-800 dark:bg-gray-950/30 dark:text-gray-200">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-medium text-gray-900 dark:text-gray-100">Amazon Details</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
            {run.data?.offer_listing_url ? (
              <a
                href={run.data.offer_listing_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                title={run.data.offer_listing_url}
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Offer listing
              </a>
            ) : null}
            {run.data?.dp_url ? (
              <a
                href={run.data.dp_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                title={run.data.dp_url}
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                PDP
              </a>
            ) : null}
            {run.data?.offers_truncated ? <Badge variant="warning">offers_truncated</Badge> : null}
          </div>
          {run.isError ? (
            <div className="mt-1 text-[11px] text-red-700 dark:text-red-300">Run: {(run.error as Error).message}</div>
          ) : null}
          {history.isError ? (
            <div className="mt-1 text-[11px] text-red-700 dark:text-red-300">
              History: {(history.error as Error).message}
            </div>
          ) : null}
        </div>

        <div className="shrink-0">
          <div className="text-[11px] text-gray-500 dark:text-gray-400">Used best (History)</div>
          <div className="mt-1">
            <Sparkline points={usedSeries} />
          </div>
        </div>
      </div>
    </div>
  );
}

function tryParseEurCents(input: string): number | null {
  const s = input.trim();
  if (!s) return null;
  try {
    return parseEurToCents(s);
  } catch {
    return null;
  }
}

function normalizeViewParam(value?: string | null): MasterProductsViewMode | null {
  if (value === "catalog" || value === "amazon") return value;
  return null;
}

function readPersistedViewMode(): MasterProductsViewMode | null {
  if (typeof window === "undefined") return null;
  const getItem = window.localStorage?.getItem;
  if (typeof getItem !== "function") return null;
  try {
    return normalizeViewParam(getItem.call(window.localStorage, MASTER_PRODUCTS_VIEW_KEY));
  } catch {
    return null;
  }
}

function persistViewMode(viewMode: MasterProductsViewMode): void {
  if (typeof window === "undefined") return;
  const setItem = window.localStorage?.setItem;
  if (typeof setItem !== "function") return;
  try {
    setItem.call(window.localStorage, MASTER_PRODUCTS_VIEW_KEY, viewMode);
  } catch {
    // Ignore storage write failures (private mode, blocked storage, test shims).
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

function ReferenceImageThumb({
  url,
  alt,
  size = 56,
}: {
  url?: string | null;
  alt: string;
  size?: number;
}) {
  const src = (url ?? "").trim();
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setErrored(false);
  }, [src]);

  const hasSrc = !!src;

  return (
    <a
      href={hasSrc ? src : undefined}
      target={hasSrc ? "_blank" : undefined}
      rel={hasSrc ? "noreferrer" : undefined}
      aria-label={hasSrc ? "Referenzbild öffnen" : "Kein Referenzbild"}
      className={[
        "group relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm",
        "dark:border-gray-800 dark:bg-gray-950/40",
        hasSrc ? "cursor-pointer hover:ring-2 hover:ring-gray-900/10 dark:hover:ring-gray-100/10" : "cursor-default",
      ].join(" ")}
      style={{ width: size, height: size }}
      onClick={(e) => {
        e.stopPropagation();
        if (!hasSrc) e.preventDefault();
      }}
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

      {hasSrc && (
        <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100">
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 dark:group-hover:bg-black/20" />
          <div className="absolute bottom-1 right-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] font-medium text-white">
            Öffnen
          </div>
        </div>
      )}
    </a>
  );
}

function CopyIdPill({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <button
      type="button"
      className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-0.5 text-[11px] text-gray-700 shadow-sm hover:bg-gray-50 active:bg-gray-100 dark:border-gray-800 dark:bg-gray-950/40 dark:text-gray-200 dark:hover:bg-gray-950/60 dark:active:bg-gray-950/80"
      title={`${label} kopieren`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void copyToClipboard(value);
      }}
    >
      <span className="shrink-0 text-gray-500 dark:text-gray-400">{label}:</span>
      <span className="min-w-0 break-all font-mono">{value}</span>
    </button>
  );
}

function MetaPill({ children }: { children: string | number }) {
  return (
    <span className="inline-flex max-w-[18rem] items-center truncate rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] text-gray-700 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-200">
      {children}
    </span>
  );
}

export function MasterProductsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const viewParam = normalizeViewParam(searchParams.get("view"));
  const missingAsinOnly = searchParams.get("missing") === "asin";
  const createParam = searchParams.get("create");
  const handledCreateRef = useRef(false);
  const [viewMode, setViewMode] = useState<MasterProductsViewMode>(() => {
    const fromUrl = normalizeViewParam(searchParams.get("view"));
    if (fromUrl) return fromUrl;
    const fromStorage = readPersistedViewMode();
    if (fromStorage) return fromStorage;
    return "catalog";
  });
  const [filtersOpen, setFiltersOpen] = useState(() => searchParams.get("missing") === "asin");
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<MasterProductKind | "ALL">("ALL");
  const [amazonStaleOnly, setAmazonStaleOnly] = useState(false);
  const [amazonBlockedOnly, setAmazonBlockedOnly] = useState(false);
  const [amazonMaxNew, setAmazonMaxNew] = useState("");
  const [amazonMaxLikeNew, setAmazonMaxLikeNew] = useState("");
  const [expanded, setExpanded] = useState<Record<string, true>>({});

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

  useEffect(() => {
    if (viewParam && viewParam !== viewMode) setViewMode(viewParam);
  }, [viewMode, viewParam]);

  useEffect(() => {
    if (missingAsinOnly) setFiltersOpen(true);
  }, [missingAsinOnly]);

  useEffect(() => {
    persistViewMode(viewMode);
  }, [viewMode]);

  useEffect(() => {
    if (createParam !== "1") {
      handledCreateRef.current = false;
      return;
    }
    if (handledCreateRef.current) return;
    handledCreateRef.current = true;

    setEditorMode("create");
    setActiveProduct(null);
    setForm({ ...EMPTY_FORM });
    setShowAdvanced(false);
    setEditorOpen(true);

    const next = new URLSearchParams(searchParams);
    next.delete("create");
    setSearchParams(next, { replace: true });
  }, [createParam, searchParams, setSearchParams]);

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

  const scrapeNow = useMutation({
    mutationFn: (masterProductId: string) =>
      api.request<{ run_id: string; ok: boolean; blocked: boolean; error?: string | null }>(`/amazon-scrapes/trigger`, {
        method: "POST",
        json: { master_product_id: masterProductId },
      }),
    onSuccess: async () => {
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

  function setViewModePersisted(nextMode: MasterProductsViewMode) {
    setViewMode(nextMode);
    const next = new URLSearchParams(searchParams);
    next.set("view", nextMode);
    setSearchParams(next);
  }

  function setMissingAsinParam(nextEnabled: boolean) {
    const next = new URLSearchParams(searchParams);
    if (nextEnabled) next.set("missing", "asin");
    else next.delete("missing");
    setSearchParams(next);
  }

  function resetAllFilters() {
    setSearch("");
    setKindFilter("ALL");
    setAmazonStaleOnly(false);
    setAmazonBlockedOnly(false);
    setAmazonMaxNew("");
    setAmazonMaxLikeNew("");
    setFiltersOpen(false);
    const next = new URLSearchParams(searchParams);
    next.delete("missing");
    setSearchParams(next, { replace: true });
  }

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let all = list.data ?? [];
    if (kindFilter !== "ALL") all = all.filter((m) => m.kind === kindFilter);
    if (missingAsinOnly) all = all.filter((m) => !m.asin?.trim());
    if (viewMode === "amazon" && amazonStaleOnly) all = all.filter((m) => isAmazonStale(m));
    if (viewMode === "amazon" && amazonBlockedOnly) all = all.filter((m) => !!m.amazon_blocked_last);

    const maxNew = tryParseEurCents(amazonMaxNew);
    if (viewMode === "amazon" && maxNew !== null) {
      all = all.filter((m) => typeof m.amazon_price_new_cents === "number" && m.amazon_price_new_cents <= maxNew);
    }
    const maxLikeNew = tryParseEurCents(amazonMaxLikeNew);
    if (viewMode === "amazon" && maxLikeNew !== null) {
      all = all.filter(
        (m) => typeof m.amazon_price_used_like_new_cents === "number" && m.amazon_price_used_like_new_cents <= maxLikeNew,
      );
    }
    if (!q) return all;
    return all.filter((m) =>
      `${m.kind} ${m.sku} ${m.title} ${m.manufacturer ?? ""} ${m.model ?? ""} ${m.platform} ${m.region} ${m.variant} ${m.ean ?? ""} ${m.asin ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [amazonBlockedOnly, amazonMaxLikeNew, amazonMaxNew, amazonStaleOnly, kindFilter, list.data, missingAsinOnly, search]);

  function isExpanded(id: string): boolean {
    return !!expanded[id];
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });
  }

  const totalCount = list.data?.length ?? 0;
  const parsedMaxNew = tryParseEurCents(amazonMaxNew);
  const parsedMaxLikeNew = tryParseEurCents(amazonMaxLikeNew);
  const activeFilterCount =
    (search.trim() ? 1 : 0) +
    (kindFilter !== "ALL" ? 1 : 0) +
    (missingAsinOnly ? 1 : 0) +
    (viewMode === "amazon" && amazonStaleOnly ? 1 : 0) +
    (viewMode === "amazon" && amazonBlockedOnly ? 1 : 0) +
    (viewMode === "amazon" && parsedMaxNew !== null ? 1 : 0) +
    (viewMode === "amazon" && parsedMaxLikeNew !== null ? 1 : 0);
  const hasActiveFilters = activeFilterCount > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-xl font-semibold">Produktstamm</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Masterdaten (SKU) für Produkte. Hier anlegen, pflegen und bei Bedarf löschen.
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button variant="secondary" className="w-full sm:w-auto" onClick={() => list.refetch()} disabled={list.isFetching}>
            <RefreshCw className="h-4 w-4" />
            Aktualisieren
          </Button>
          <Button className="w-full sm:w-auto" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            Produkt anlegen
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-col gap-1">
              <CardTitle>Produkte</CardTitle>
              <CardDescription>
                {list.isPending ? "Lade…" : `${rows.length}${rows.length !== totalCount ? ` / ${totalCount}` : ""} Produkte`}
              </CardDescription>
            </div>
            <div className="inline-flex items-center gap-1 rounded-md border border-gray-200 p-1 dark:border-gray-800">
              <Button
                type="button"
                size="sm"
                variant={viewMode === "catalog" ? "secondary" : "ghost"}
                onClick={() => setViewModePersisted("catalog")}
              >
                Stammdaten
              </Button>
              <Button
                type="button"
                size="sm"
                variant={viewMode === "amazon" ? "secondary" : "ghost"}
                onClick={() => setViewModePersisted("amazon")}
              >
                Amazon Status
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
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

              <div className="flex flex-wrap items-center gap-2">
                <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as MasterProductKind | "ALL")}>
                  <SelectTrigger className="w-full min-w-[190px] sm:w-[190px]">
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

                <Button
                  type="button"
                  variant={filtersOpen || hasActiveFilters ? "secondary" : "ghost"}
                  onClick={() => setFiltersOpen((prev) => !prev)}
                >
                  <SlidersHorizontal className="h-4 w-4" />
                  Filter
                  {activeFilterCount > 0 ? (
                    <span className="rounded-full bg-gray-900 px-1.5 py-0.5 text-[10px] leading-none text-white dark:bg-gray-100 dark:text-gray-900">
                      {activeFilterCount}
                    </span>
                  ) : null}
                </Button>
                {hasActiveFilters ? (
                  <Button type="button" variant="ghost" onClick={resetAllFilters}>
                    Reset
                  </Button>
                ) : null}
              </div>
            </div>

            {filtersOpen ? (
              <div className="rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950/30">
                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="space-y-2">
                    <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Fokus / Datenqualität</div>
                    <Button
                      type="button"
                      variant={missingAsinOnly ? "secondary" : "outline"}
                      onClick={() => setMissingAsinParam(!missingAsinOnly)}
                    >
                      Ohne ASIN
                    </Button>
                  </div>

                  {viewMode === "amazon" ? (
                    <div className="space-y-2">
                      <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Amazon</div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          variant={amazonStaleOnly ? "secondary" : "outline"}
                          onClick={() => setAmazonStaleOnly((v) => !v)}
                          title="Nur Produkte mit veralteten Amazon-Daten (>24h)"
                        >
                          Amazon stale
                        </Button>
                        <Button
                          type="button"
                          variant={amazonBlockedOnly ? "secondary" : "outline"}
                          onClick={() => setAmazonBlockedOnly((v) => !v)}
                          title="Nur Produkte, die zuletzt geblockt waren"
                        >
                          Blocked
                        </Button>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Input
                          value={amazonMaxNew}
                          onChange={(e) => setAmazonMaxNew(e.target.value)}
                          placeholder="Neu <= 12,34"
                          title="Filter: Amazon Preis Neu (Total inkl. Versand) maximal"
                        />
                        <Input
                          value={amazonMaxLikeNew}
                          onChange={(e) => setAmazonMaxLikeNew(e.target.value)}
                          placeholder="Wie neu <= 12,34"
                          title="Filter: Amazon Preis Wie neu (Total inkl. Versand) maximal"
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          {list.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200">
              {(list.error as Error).message}
            </div>
          )}

          <div className="space-y-2 md:hidden">
            {list.isPending &&
              Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={`skel-m-${i}`}
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

            {!list.isPending &&
              rows.map((m) => (
                <div
                  key={m.id}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openEdit(m);
                    }
                  }}
                  onClick={() => openEdit(m)}
                  className={[
                    "cursor-pointer rounded-md border border-gray-200 bg-white p-3 shadow-sm transition-colors",
                    "hover:bg-gray-50 active:bg-gray-100",
                    "dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-gray-800/60 dark:active:bg-gray-800/80",
                  ].join(" ")}
                >
                  <div className="flex items-start gap-3">
                    <ReferenceImageThumb url={m.reference_image_url} alt={m.title} />

                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-gray-900 dark:text-gray-100">{m.title}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            <Badge variant="secondary">{kindLabel(m.kind)}</Badge>
                            <Badge variant="outline" className="font-mono text-[11px]">
                              {m.sku}
                            </Badge>
                          </div>
                        </div>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="outline"
                              size="icon"
                              aria-label="Aktionen"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              disabled={!m.asin || scrapeNow.isPending}
                              onSelect={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                scrapeNow.mutate(m.id);
                              }}
                            >
                              <RefreshCw className="h-4 w-4" />
                              Amazon scrape jetzt
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={(e) => {
                                e.preventDefault();
                                openEdit(m);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                              Bearbeiten
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                void copyToClipboard(m.id);
                              }}
                            >
                              <Copy className="h-4 w-4" />
                              UUID kopieren
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
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                        <span>{m.platform}</span>
                        <span className="text-gray-300 dark:text-gray-700">•</span>
                        <span>{m.region}</span>
                        {m.variant ? (
                          <>
                            <span className="text-gray-300 dark:text-gray-700">•</span>
                            <span className="truncate">{m.variant}</span>
                          </>
                        ) : null}
                      </div>

                      {viewMode === "catalog" && (m.ean || m.asin) ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {m.ean ? <CopyIdPill label="EAN" value={m.ean} /> : null}
                          {m.asin ? <CopyIdPill label="ASIN" value={m.asin} /> : null}
                        </div>
                      ) : null}

                      {viewMode === "amazon" && m.asin ? (
                        <div className="mt-2 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            {m.amazon_blocked_last ? <Badge variant="danger">blocked</Badge> : null}
                            {isAmazonStale(m) ? <Badge variant="warning">stale</Badge> : <Badge variant="success">fresh</Badge>}
                            {m.amazon_last_success_at ? (
                              <span className="text-xs text-gray-500 dark:text-gray-400" title={m.amazon_last_success_at}>
                                {new Date(m.amazon_last_success_at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}
                              </span>
                            ) : (
                              <span className="text-xs text-gray-500 dark:text-gray-400">noch nie</span>
                            )}
                            <CopyIdPill label="ASIN" value={m.asin} />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              aria-label={isExpanded(m.id) ? "Details einklappen" : "Details ausklappen"}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleExpanded(m.id);
                              }}
                            >
                              Details
                              {isExpanded(m.id) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </Button>
                          </div>
                          <div className="text-[11px] text-gray-500 dark:text-gray-400">
                            Failures {typeof m.amazon_consecutive_failures === "number" ? m.amazon_consecutive_failures : "—"} · Next retry{" "}
                            {m.amazon_next_retry_at
                              ? new Date(m.amazon_next_retry_at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })
                              : "—"}
                          </div>

                          {isExpanded(m.id) ? (
                            <div
                              className="pt-1"
                              onClick={(e) => {
                                e.stopPropagation();
                              }}
                            >
                              {(() => {
                                const used = computeUsedBest(m);
                                const sell = estimateSellThroughFromBsr(m);
                                const sellRange = formatSellThroughRange(sell.range_days);
                                const sellDisplay = sellRange === "—" ? "—" : `~${sellRange}`;
                                const rank = typeof m.amazon_rank_overall === "number" ? m.amazon_rank_overall : m.amazon_rank_specific;
                                const rankCat = m.amazon_rank_overall_category ?? m.amazon_rank_specific_category ?? null;
                                const usedOffers =
                                  typeof m.amazon_offers_count_used_priced_total === "number"
                                    ? m.amazon_offers_count_used_priced_total
                                    : null;
                                const offers = typeof m.amazon_offers_count_total === "number" ? m.amazon_offers_count_total : null;

                                return (
                                  <div className="mb-2 grid gap-2 sm:grid-cols-2">
                                    <div className="rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-950/30">
                                      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                        Used best
                                      </div>
                                      <div className="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                                        {used.cents !== null ? fmtMaybeEur(used.cents) : "—"}
                                      </div>
                                      <div className="text-[11px] text-gray-500 dark:text-gray-400">
                                        {used.cents !== null ? used.label : "—"}
                                      </div>
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
                                      <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                                        <Badge variant={sellThroughConfidenceVariant(sell.confidence)}>{sell.confidence}</Badge>
                                      </div>
                                    </div>

                                    <div className="rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-950/30">
                                      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                        BSR
                                      </div>
                                      <div className="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                                        {typeof rank === "number" ? `#${rank}` : "—"}
                                      </div>
                                      <div className="text-[11px] text-gray-500 dark:text-gray-400">{rankCat ?? "—"}</div>
                                    </div>

                                    <div className="rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-950/30">
                                      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                        Offers
                                      </div>
                                      <div className="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                                        {usedOffers !== null ? `${usedOffers} used` : offers !== null ? `${offers}` : "—"}
                                      </div>
                                      <div className="text-[11px] text-gray-500 dark:text-gray-400">
                                        Buybox {fmtMaybeEur(m.amazon_buybox_total_cents)}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })()}

                              <div className="grid grid-cols-2 gap-2 text-[11px] text-gray-700 dark:text-gray-200">
                                <div>Neu: {fmtMaybeEur(m.amazon_price_new_cents)}</div>
                                <div>Wie neu: {fmtMaybeEur(m.amazon_price_used_like_new_cents)}</div>
                                <div>Sehr gut: {fmtMaybeEur(m.amazon_price_used_very_good_cents)}</div>
                                <div>Gut: {fmtMaybeEur(m.amazon_price_used_good_cents)}</div>
                                <div>Akzeptabel: {fmtMaybeEur(m.amazon_price_used_acceptable_cents)}</div>
                                <div>Sammlerst.: {fmtMaybeEur(m.amazon_price_collectible_cents)}</div>
                                <div>
                                  Offers priced:{" "}
                                  {typeof m.amazon_offers_count_priced_total === "number" ? m.amazon_offers_count_priced_total : "—"}
                                </div>
                                <div>
                                  Next retry:{" "}
                                  {m.amazon_next_retry_at
                                    ? new Date(m.amazon_next_retry_at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })
                                    : "—"}
                                </div>
                              </div>

                              {m.amazon_last_error ? (
                                <div className="mt-2 text-[11px] text-red-700 dark:text-red-300">Last error: {m.amazon_last_error}</div>
                              ) : null}

                              <AmazonDetails masterProductId={m.id} lastRunId={m.amazon_last_run_id} expanded={true} />
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                    </div>
                  </div>
                </div>
              ))}

            {!list.isPending && !rows.length && (
              <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-300">
                <div className="flex flex-col items-start gap-2">
                  <div>Keine Produkte gefunden.</div>
                  <div className="flex w-full flex-col gap-2 sm:flex-row">
                    <Button
                      type="button"
                      variant="secondary"
                      className="w-full sm:w-auto"
                      onClick={resetAllFilters}
                      disabled={!hasActiveFilters}
                    >
                      Filter zurücksetzen
                    </Button>
                    <Button type="button" className="w-full sm:w-auto" onClick={openCreate}>
                      <Plus className="h-4 w-4" />
                      Produkt anlegen
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produkt</TableHead>
                  <TableHead>{viewMode === "catalog" ? "IDs" : "Amazon Status"}</TableHead>
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
                        <div className="flex items-start gap-3">
                          <div className="h-14 w-14 rounded-md bg-gray-100 dark:bg-gray-800" />
                          <div className="space-y-2 pt-1">
                            <div className="h-4 w-64 rounded bg-gray-200 dark:bg-gray-800" />
                            <div className="h-3 w-48 rounded bg-gray-100 dark:bg-gray-800" />
                          </div>
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
                    <Fragment key={m.id}>
                      <TableRow>
                        <TableCell>
                          <div className="flex items-start gap-3">
                            <ReferenceImageThumb url={m.reference_image_url} alt={m.title} />

                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="min-w-0 truncate font-medium">{m.title}</div>
                                <Badge variant="secondary">{kindLabel(m.kind)}</Badge>
                                <Badge variant="outline" className="font-mono text-[11px]">
                                  {m.sku}
                                </Badge>
                              </div>

                              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                                <span>{m.platform}</span>
                                <span className="text-gray-300 dark:text-gray-700">•</span>
                                <span>{m.region}</span>
                                {m.variant ? (
                                  <>
                                    <span className="text-gray-300 dark:text-gray-700">•</span>
                                    <span className="truncate">{m.variant}</span>
                                  </>
                                ) : null}
                              </div>

                              {viewMode === "catalog" && (m.manufacturer || m.model || m.genre || m.release_year) ? (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {m.manufacturer ? <MetaPill>{m.manufacturer}</MetaPill> : null}
                                  {m.model ? <MetaPill>{m.model}</MetaPill> : null}
                                  {m.genre ? <MetaPill>{m.genre}</MetaPill> : null}
                                  {m.release_year ? <MetaPill>{m.release_year}</MetaPill> : null}
                                </div>
                              ) : null}

                              {viewMode === "catalog" && m.reference_image_url?.trim() ? (
                                <a
                                  href={m.reference_image_url.trim()}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-2 inline-flex items-center gap-1 text-xs text-gray-500 underline-offset-2 hover:underline dark:text-gray-400"
                                  title={m.reference_image_url.trim()}
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                  {shortUrlLabel(m.reference_image_url.trim())}
                                </a>
                              ) : null}

                              {viewMode === "amazon" && m.asin ? (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  <CopyIdPill label="ASIN" value={m.asin} />
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </TableCell>

                        {viewMode === "catalog" ? (
                          <TableCell className="text-sm">
                            {m.ean || m.asin ? (
                              <div className="flex flex-wrap gap-1">
                                {m.ean ? <CopyIdPill label="EAN" value={m.ean} /> : null}
                                {m.asin ? <CopyIdPill label="ASIN" value={m.asin} /> : null}
                              </div>
                            ) : (
                              <span className="text-gray-500 dark:text-gray-400">—</span>
                            )}
                          </TableCell>
                        ) : (
                          <TableCell className="text-sm">
                            {!m.asin ? (
                              <span className="text-gray-500 dark:text-gray-400">—</span>
                            ) : (
                              <div className="space-y-2">
                                <div className="flex flex-wrap items-center gap-2">
                                  {m.amazon_blocked_last ? <Badge variant="danger">blocked</Badge> : null}
                                  {isAmazonStale(m) ? <Badge variant="warning">stale</Badge> : <Badge variant="success">fresh</Badge>}
                                  {m.amazon_last_success_at ? (
                                    <span className="text-xs text-gray-500 dark:text-gray-400" title={m.amazon_last_success_at}>
                                      {new Date(m.amazon_last_success_at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}
                                    </span>
                                  ) : (
                                    <span className="text-xs text-gray-500 dark:text-gray-400">noch nie</span>
                                  )}
                                  <CopyIdPill label="ASIN" value={m.asin} />
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2"
                                    aria-label={isExpanded(m.id) ? "Details einklappen" : "Details ausklappen"}
                                    onClick={(e) => {
                                      e.preventDefault();
                                      toggleExpanded(m.id);
                                    }}
                                  >
                                    Details
                                    {isExpanded(m.id) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                  </Button>
                                </div>
                                <div className="text-[11px] text-gray-500 dark:text-gray-400">
                                  Failures {typeof m.amazon_consecutive_failures === "number" ? m.amazon_consecutive_failures : "—"} · Next retry{" "}
                                  {m.amazon_next_retry_at
                                    ? new Date(m.amazon_next_retry_at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })
                                    : "—"}
                                </div>
                              </div>
                            )}
                          </TableCell>
                        )}

                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" aria-label="Aktionen">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                disabled={!m.asin || scrapeNow.isPending}
                                onSelect={(e) => {
                                  e.preventDefault();
                                  scrapeNow.mutate(m.id);
                                }}
                              >
                                <RefreshCw className="h-4 w-4" />
                                Amazon scrape jetzt
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={(e) => {
                                  e.preventDefault();
                                  openEdit(m);
                                }}
                              >
                                <Pencil className="h-4 w-4" />
                                Bearbeiten
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={(e) => {
                                  e.preventDefault();
                                  void copyToClipboard(m.id);
                                }}
                              >
                                <Copy className="h-4 w-4" />
                                UUID kopieren
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
                      {viewMode === "amazon" && m.asin && isExpanded(m.id) ? (
                        <TableRow>
                          <TableCell colSpan={3} className="bg-gray-50/60 py-0 dark:bg-gray-950/30">
                            <div className="py-3">
                              {(() => {
                                const used = computeUsedBest(m);
                                const sell = estimateSellThroughFromBsr(m);
                                const sellRange = formatSellThroughRange(sell.range_days);
                                const sellDisplay = sellRange === "—" ? "—" : `~${sellRange}`;
                                const rank = typeof m.amazon_rank_overall === "number" ? m.amazon_rank_overall : m.amazon_rank_specific;
                                const rankCat = m.amazon_rank_overall_category ?? m.amazon_rank_specific_category ?? null;
                                const usedOffers =
                                  typeof m.amazon_offers_count_used_priced_total === "number"
                                    ? m.amazon_offers_count_used_priced_total
                                    : null;
                                const offers = typeof m.amazon_offers_count_total === "number" ? m.amazon_offers_count_total : null;

                                return (
                                  <div className="mb-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                                    <div className="rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-950/30">
                                      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                        Used best
                                      </div>
                                      <div className="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                                        {used.cents !== null ? fmtMaybeEur(used.cents) : "—"}
                                      </div>
                                      <div className="text-[11px] text-gray-500 dark:text-gray-400">
                                        {used.cents !== null ? used.label : "—"}
                                      </div>
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
                                      <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                                        <Badge variant={sellThroughConfidenceVariant(sell.confidence)}>{sell.confidence}</Badge>
                                      </div>
                                    </div>

                                    <div className="rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-950/30">
                                      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                        BSR
                                      </div>
                                      <div className="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                                        {typeof rank === "number" ? `#${rank}` : "—"}
                                      </div>
                                      <div className="text-[11px] text-gray-500 dark:text-gray-400">{rankCat ?? "—"}</div>
                                    </div>

                                    <div className="rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-950/30">
                                      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                        Offers
                                      </div>
                                      <div className="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                                        {usedOffers !== null ? `${usedOffers} used` : offers !== null ? `${offers}` : "—"}
                                      </div>
                                      <div className="text-[11px] text-gray-500 dark:text-gray-400">
                                        Buybox {fmtMaybeEur(m.amazon_buybox_total_cents)}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })()}

                              <div className="grid grid-cols-4 gap-2 text-[11px] text-gray-700 dark:text-gray-200">
                                <div>Neu: {fmtMaybeEur(m.amazon_price_new_cents)}</div>
                                <div>Wie neu: {fmtMaybeEur(m.amazon_price_used_like_new_cents)}</div>
                                <div>Sehr gut: {fmtMaybeEur(m.amazon_price_used_very_good_cents)}</div>
                                <div>Gut: {fmtMaybeEur(m.amazon_price_used_good_cents)}</div>
                                <div>Akzeptabel: {fmtMaybeEur(m.amazon_price_used_acceptable_cents)}</div>
                                <div>Sammlerst.: {fmtMaybeEur(m.amazon_price_collectible_cents)}</div>
                                <div>Buybox: {fmtMaybeEur(m.amazon_buybox_total_cents)}</div>
                                <div>Offers: {typeof m.amazon_offers_count_total === "number" ? m.amazon_offers_count_total : "—"}</div>
                                <div>
                                  Offers priced:{" "}
                                  {typeof m.amazon_offers_count_priced_total === "number" ? m.amazon_offers_count_priced_total : "—"}
                                </div>
                                <div>
                                  Used priced:{" "}
                                  {typeof m.amazon_offers_count_used_priced_total === "number"
                                    ? m.amazon_offers_count_used_priced_total
                                    : "—"}
                                </div>
                                <div>
                                  Next retry:{" "}
                                  {m.amazon_next_retry_at
                                    ? new Date(m.amazon_next_retry_at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })
                                    : "—"}
                                </div>
                                <div>Failures: {typeof m.amazon_consecutive_failures === "number" ? m.amazon_consecutive_failures : "—"}</div>
                              </div>

                              {m.amazon_last_error ? (
                                <div className="mt-2 text-[11px] text-red-700 dark:text-red-300">Last error: {m.amazon_last_error}</div>
                              ) : null}

                              <AmazonDetails masterProductId={m.id} lastRunId={m.amazon_last_run_id} expanded={true} />
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  ))}

                {!rows.length && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-sm text-gray-500 dark:text-gray-400">
                      <div className="flex flex-col items-start gap-2 py-3">
                        <div>Keine Produkte gefunden.</div>
                        <div className="flex items-center gap-2">
                          <Button type="button" variant="secondary" onClick={resetAllFilters} disabled={!hasActiveFilters}>
                            Filter zurücksetzen
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
          </div>
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

                  {form.reference_image_url.trim() && (
                    <div className="md:col-span-6">
                      <div className="flex items-start gap-4 rounded-md border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950/40">
                        <ReferenceImageThumb url={form.reference_image_url} alt={form.title || "Referenzbild"} size={96} />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-gray-700 dark:text-gray-300">Vorschau</div>
                          <a
                            href={form.reference_image_url.trim()}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 block break-all text-xs text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
                          >
                            {form.reference_image_url.trim()}
                          </a>
                          <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                            Tipp: Klick auf das Bild öffnet die URL in einem neuen Tab.
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
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
