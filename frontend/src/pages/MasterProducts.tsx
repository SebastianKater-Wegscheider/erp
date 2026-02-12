import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Image as ImageIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import { useApi } from "../lib/api";
import { computeUsedBest, estimateSellThroughFromBsr, formatSellThroughRange } from "../lib/amazon";
import { formatEur, parseEurToCents } from "../lib/money";
import { amazonListingUrl, resolveReferenceImageSrc } from "../lib/referenceImages";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { InlineMessage } from "../components/ui/inline-message";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PageHeader } from "../components/ui/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { SearchField } from "../components/ui/search-field";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import {
  TABLE_ACTION_CELL_CLASS,
  TABLE_ACTION_GROUP_CLASS,
  TABLE_CELL_META_CLASS,
  TABLE_ROW_COMPACT_CLASS,
} from "../components/ui/table-row-layout";

type MasterProductKind = "GAME" | "CONSOLE" | "ACCESSORY" | "OTHER";
type MasterProductsViewMode = "catalog" | "amazon";
type MasterProductsSortKey = "TARGET_POTENTIAL_DESC" | "BSR_OVERALL_ASC" | "TITLE_ASC" | "AMAZON_FRESH_DESC";

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

type MasterProductBulkImportRowError = {
  row_number: number;
  message: string;
  title?: string | null;
};

type MasterProductBulkImportOut = {
  total_rows: number;
  imported_count: number;
  failed_count: number;
  skipped_count: number;
  errors: MasterProductBulkImportRowError[];
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
const RESALE_PRICE_GOOD_CENTS = 4_000;

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

function overallBsrRank(m: MasterProduct): number {
  if (typeof m.amazon_rank_overall === "number" && m.amazon_rank_overall > 0) return m.amazon_rank_overall;
  return Number.POSITIVE_INFINITY;
}

type ResellerTargetTier = "TOP" | "STRONG" | "WATCH" | "LOW" | "UNKNOWN";

type ResellerTargetSignal = {
  tier: ResellerTargetTier;
  score: number;
  bsrRank: number | null;
  bsrCategory: string;
  salesPriceCents: number | null;
  salesPriceLabel: string;
  priceMeetsGoal: boolean;
  summary: string;
};

function resellerSalesPriceSignal(m: MasterProduct): { cents: number | null; label: string } {
  const used = computeUsedBest(m);
  if (used.cents !== null) return { cents: used.cents, label: `Used best (${used.label})` };
  if (typeof m.amazon_buybox_total_cents === "number") return { cents: m.amazon_buybox_total_cents, label: "Buybox" };
  if (typeof m.amazon_price_new_cents === "number") return { cents: m.amazon_price_new_cents, label: "Neu" };
  return { cents: null, label: "—" };
}

function resellerBsrScore(rank: number | null): number {
  if (rank === null) return -1;
  if (rank <= 2_500) return 5;
  if (rank <= 10_000) return 4;
  if (rank <= 30_000) return 3;
  if (rank <= 80_000) return 2;
  if (rank <= 150_000) return 1;
  return 0;
}

function resellerPriceScore(cents: number | null): number {
  if (cents === null) return -1;
  if (cents >= 6_000) return 4;
  if (cents >= RESALE_PRICE_GOOD_CENTS) return 3;
  if (cents >= 2_500) return 2;
  if (cents >= 1_500) return 1;
  return 0;
}

function resellerTargetTierLabel(tier: ResellerTargetTier): string {
  switch (tier) {
    case "TOP":
      return "Top Target";
    case "STRONG":
      return "Stark";
    case "WATCH":
      return "Watchlist";
    case "LOW":
      return "Niedrig";
    case "UNKNOWN":
    default:
      return "Unklar";
  }
}

function resellerTargetTierVariant(tier: ResellerTargetTier) {
  switch (tier) {
    case "TOP":
      return "success" as const;
    case "STRONG":
      return "secondary" as const;
    case "WATCH":
      return "warning" as const;
    case "LOW":
    case "UNKNOWN":
    default:
      return "outline" as const;
  }
}

function resellerTargetRowClass(tier: ResellerTargetTier): string {
  switch (tier) {
    case "TOP":
      return "bg-emerald-50/45 dark:bg-emerald-950/12";
    case "STRONG":
      return "bg-amber-50/45 dark:bg-amber-950/12";
    default:
      return "";
  }
}

function resellerTargetPriceClass(cents: number | null): string {
  if (cents === null) {
    return "border-gray-200 bg-white text-gray-500 dark:border-gray-800 dark:bg-gray-950/30 dark:text-gray-400";
  }
  if (cents >= RESALE_PRICE_GOOD_CENTS) {
    return "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200";
  }
  if (cents >= 2_500) {
    return "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200";
  }
  return "border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-950/30 dark:text-gray-300";
}

function resellerTargetSignal(m: MasterProduct): ResellerTargetSignal {
  const bsrRank =
    typeof m.amazon_rank_overall === "number" && m.amazon_rank_overall > 0
      ? m.amazon_rank_overall
      : typeof m.amazon_rank_specific === "number" && m.amazon_rank_specific > 0
        ? m.amazon_rank_specific
        : null;
  const bsrCategory = (m.amazon_rank_overall_category ?? m.amazon_rank_specific_category ?? "—").trim() || "—";
  const salesPrice = resellerSalesPriceSignal(m);
  const priceMeetsGoal = typeof salesPrice.cents === "number" && salesPrice.cents >= RESALE_PRICE_GOOD_CENTS;

  let tier: ResellerTargetTier = "UNKNOWN";
  if (bsrRank !== null && salesPrice.cents !== null) {
    if (bsrRank <= 10_000 && salesPrice.cents >= RESALE_PRICE_GOOD_CENTS) tier = "TOP";
    else if (
      (bsrRank <= 30_000 && salesPrice.cents >= RESALE_PRICE_GOOD_CENTS) ||
      (bsrRank <= 10_000 && salesPrice.cents >= 2_500)
    ) {
      tier = "STRONG";
    } else if (
      (bsrRank <= 80_000 && salesPrice.cents >= 2_500) ||
      (bsrRank <= 30_000 && salesPrice.cents >= 1_500)
    ) {
      tier = "WATCH";
    } else {
      tier = "LOW";
    }
  }

  let summary = "Daten unvollstaendig.";
  if (tier === "TOP") summary = "Niedriger BSR + Preisziel erreicht (>= 40 EUR).";
  if (tier === "STRONG") summary = "Solide Nachfrage-/Preis-Kombination fuer Reselling.";
  if (tier === "WATCH") summary = "Interessant, aber Nachfrage oder Preis noch mittel.";
  if (tier === "LOW") summary = "Aktuell schwaches Demand-/Preis-Profil.";

  const bsrScore = resellerBsrScore(bsrRank);
  const priceScore = resellerPriceScore(salesPrice.cents);
  let score = bsrScore < 0 || priceScore < 0 ? -100 : bsrScore * 20 + priceScore * 5;
  if (m.amazon_blocked_last) score -= 12;
  else if (isAmazonStale(m)) score -= 4;

  return {
    tier,
    score,
    bsrRank,
    bsrCategory,
    salesPriceCents: salesPrice.cents,
    salesPriceLabel: salesPrice.label,
    priceMeetsGoal,
    summary,
  };
}

function isTopResellerTarget(m: MasterProduct): boolean {
  const signal = resellerTargetSignal(m);
  return (signal.tier === "TOP" || signal.tier === "STRONG") && signal.priceMeetsGoal;
}

function compareMasterProducts(a: MasterProduct, b: MasterProduct, sortBy: MasterProductsSortKey): number {
  if (sortBy === "TARGET_POTENTIAL_DESC") {
    const sa = resellerTargetSignal(a);
    const sb = resellerTargetSignal(b);
    if (sb.score !== sa.score) return sb.score - sa.score;

    const rankA = sa.bsrRank ?? Number.POSITIVE_INFINITY;
    const rankB = sb.bsrRank ?? Number.POSITIVE_INFINITY;
    if (rankA !== rankB) return rankA - rankB;

    const priceA = sa.salesPriceCents ?? Number.NEGATIVE_INFINITY;
    const priceB = sb.salesPriceCents ?? Number.NEGATIVE_INFINITY;
    if (priceB !== priceA) return priceB - priceA;

    return a.title.localeCompare(b.title, "de-DE", { sensitivity: "base" });
  }

  if (sortBy === "TITLE_ASC") {
    return a.title.localeCompare(b.title, "de-DE", { sensitivity: "base" });
  }
  if (sortBy === "AMAZON_FRESH_DESC") {
    const ta = parseIsoMs(a.amazon_last_success_at);
    const tb = parseIsoMs(b.amazon_last_success_at);
    const va = ta === null ? Number.NEGATIVE_INFINITY : ta;
    const vb = tb === null ? Number.NEGATIVE_INFINITY : tb;
    if (vb !== va) return vb - va;
    return a.title.localeCompare(b.title, "de-DE", { sensitivity: "base" });
  }

  const rankA = overallBsrRank(a);
  const rankB = overallBsrRank(b);
  if (rankA !== rankB) return rankA - rankB;

  const usedA = computeUsedBest(a).cents ?? Number.POSITIVE_INFINITY;
  const usedB = computeUsedBest(b).cents ?? Number.POSITIVE_INFINITY;
  if (usedA !== usedB) return usedA - usedB;

  return a.title.localeCompare(b.title, "de-DE", { sensitivity: "base" });
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
  openHref,
  alt,
  size = 56,
}: {
  url?: string | null;
  openHref?: string | null;
  alt: string;
  size?: number;
}) {
  const src = resolveReferenceImageSrc(url);
  const linkHref = (openHref ?? "").trim() || src;
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setErrored(false);
  }, [src]);

  const hasSrc = !!src;
  const canOpen = !!linkHref;

  return (
    <a
      href={canOpen ? linkHref : undefined}
      target={canOpen ? "_blank" : undefined}
      rel={canOpen ? "noreferrer" : undefined}
      aria-label={canOpen ? "Amazon-Listing öffnen" : "Kein Referenzbild"}
      className={[
        "group relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm",
        "dark:border-gray-800 dark:bg-gray-950/40",
        canOpen ? "cursor-pointer hover:ring-2 hover:ring-gray-900/10 dark:hover:ring-gray-100/10" : "cursor-default",
      ].join(" ")}
      style={{ width: size, height: size }}
      onClick={(e) => {
        e.stopPropagation();
        if (!canOpen) e.preventDefault();
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

      {canOpen && (
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
  const [sortBy, setSortBy] = useState<MasterProductsSortKey>(() =>
    viewParam === "amazon" ? "TARGET_POTENTIAL_DESC" : "BSR_OVERALL_ASC",
  );
  const [inStockOnly, setInStockOnly] = useState(false);
  const [amazonStaleOnly, setAmazonStaleOnly] = useState(false);
  const [amazonBlockedOnly, setAmazonBlockedOnly] = useState(false);
  const [topPotentialOnly, setTopPotentialOnly] = useState(false);
  const [amazonMaxNew, setAmazonMaxNew] = useState("");
  const [amazonMaxLikeNew, setAmazonMaxLikeNew] = useState("");
  const [expanded, setExpanded] = useState<Record<string, true>>({});

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"create" | "edit">("create");
  const [activeProduct, setActiveProduct] = useState<MasterProduct | null>(null);
  const [form, setForm] = useState<MasterProductFormState>({ ...EMPTY_FORM });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importCsvText, setImportCsvText] = useState("");
  const [importSourceLabel, setImportSourceLabel] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<MasterProductBulkImportOut | null>(null);
  const [showImportErrors, setShowImportErrors] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<MasterProduct | null>(null);

  const list = useQuery({
    queryKey: ["master-products", inStockOnly],
    queryFn: () =>
      api.request<MasterProduct[]>(inStockOnly ? "/master-products?in_stock_only=true" : "/master-products"),
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

  const bulkImport = useMutation({
    mutationFn: () =>
      api.request<MasterProductBulkImportOut>("/master-products/bulk-import", {
        method: "POST",
        json: { csv_text: importCsvText },
      }),
    onSuccess: async (result) => {
      setImportResult(result);
      setShowImportErrors(false);
      if (result.imported_count > 0) {
        await qc.invalidateQueries({ queryKey: ["master-products"] });
      }
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

  function openImport() {
    bulkImport.reset();
    setImportResult(null);
    setShowImportErrors(false);
    setImportCsvText("");
    setImportSourceLabel(null);
    setImportOpen(true);
  }

  async function handleImportFile(file: File | null) {
    if (!file) return;
    const text = await file.text();
    setImportCsvText(text);
    setImportSourceLabel(file.name);
    setImportResult(null);
    setShowImportErrors(false);
    bulkImport.reset();
  }

  function updateImportCsvText(value: string) {
    setImportCsvText(value);
    setImportSourceLabel(null);
    setImportResult(null);
    setShowImportErrors(false);
    bulkImport.reset();
  }

  function runImport() {
    if (!importCsvText.trim()) return;
    bulkImport.mutate();
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
    setSortBy(viewMode === "amazon" ? "TARGET_POTENTIAL_DESC" : "BSR_OVERALL_ASC");
    setInStockOnly(false);
    setAmazonStaleOnly(false);
    setAmazonBlockedOnly(false);
    setTopPotentialOnly(false);
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
    if (viewMode === "amazon" && topPotentialOnly) all = all.filter((m) => isTopResellerTarget(m));

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
    if (q) {
      all = all.filter((m) =>
        `${m.kind} ${m.sku} ${m.title} ${m.manufacturer ?? ""} ${m.model ?? ""} ${m.platform} ${m.region} ${m.variant} ${m.ean ?? ""} ${m.asin ?? ""}`
          .toLowerCase()
          .includes(q),
      );
    }
    return [...all].sort((a, b) => compareMasterProducts(a, b, sortBy));
  }, [
    amazonBlockedOnly,
    amazonMaxLikeNew,
    amazonMaxNew,
    amazonStaleOnly,
    kindFilter,
    list.data,
    missingAsinOnly,
    search,
    sortBy,
    topPotentialOnly,
    viewMode,
  ]);

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
    (inStockOnly ? 1 : 0) +
    (missingAsinOnly ? 1 : 0) +
    (viewMode === "amazon" && amazonStaleOnly ? 1 : 0) +
    (viewMode === "amazon" && amazonBlockedOnly ? 1 : 0) +
    (viewMode === "amazon" && topPotentialOnly ? 1 : 0) +
    (viewMode === "amazon" && parsedMaxNew !== null ? 1 : 0) +
    (viewMode === "amazon" && parsedMaxLikeNew !== null ? 1 : 0);
  const hasActiveFilters = activeFilterCount > 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Produktstamm"
        description="Masterdaten (SKU) für Produkte. Hier anlegen, pflegen und bei Bedarf löschen."
        actions={
          <>
            <Button variant="secondary" className="w-full sm:w-auto" onClick={() => list.refetch()} disabled={list.isFetching}>
              <RefreshCw className="h-4 w-4" />
              Aktualisieren
            </Button>
            <Button variant="outline" className="w-full sm:w-auto" onClick={openImport}>
              CSV Import
            </Button>
            <Button className="w-full sm:w-auto" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Produkt anlegen
            </Button>
          </>
        }
        actionsClassName="w-full sm:w-auto"
      />

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
              <SearchField
                className="flex-1"
                value={search}
                onValueChange={setSearch}
                placeholder="Suchen (SKU, Titel, EAN, ASIN, …)"
              />

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

                <Select value={sortBy} onValueChange={(v) => setSortBy(v as MasterProductsSortKey)}>
                  <SelectTrigger className="w-full min-w-[220px] sm:w-[220px]">
                    <SelectValue placeholder="Sortierung" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TARGET_POTENTIAL_DESC">Target-Potenzial (Reseller)</SelectItem>
                    <SelectItem value="BSR_OVERALL_ASC">BSR Gesamt (Bestseller zuerst)</SelectItem>
                    <SelectItem value="TITLE_ASC">Titel A–Z</SelectItem>
                    <SelectItem value="AMAZON_FRESH_DESC">Amazon zuletzt aktualisiert</SelectItem>
                  </SelectContent>
                </Select>

                <Button
                  type="button"
                  variant={inStockOnly ? "secondary" : "outline"}
                  onClick={() => setInStockOnly((v) => !v)}
                  title="Nur Produkte mit Bestand (Draft/Available/FBA/Reserved)"
                >
                  Auf Lager
                </Button>

                {viewMode === "amazon" ? (
                  <Button
                    type="button"
                    variant={topPotentialOnly ? "secondary" : "outline"}
                    onClick={() => setTopPotentialOnly((v) => !v)}
                    title="Top Targets: BSR + Verkaufspreis mit Fokus auf >= 40 EUR"
                  >
                    Top Targets 40+
                  </Button>
                ) : null}

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
                        <Button
                          type="button"
                          variant={topPotentialOnly ? "secondary" : "outline"}
                          onClick={() => setTopPotentialOnly((v) => !v)}
                          title="Top Targets: BSR + Verkaufspreis mit Fokus auf >= 40 EUR"
                        >
                          Top Targets 40+
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
            <InlineMessage tone="error">
              {(list.error as Error).message}
            </InlineMessage>
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
              rows.map((m) => {
                const targetSignal = resellerTargetSignal(m);
                const rowTone = viewMode === "amazon" ? resellerTargetRowClass(targetSignal.tier) : "";

                return (
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
                      rowTone,
                    ].join(" ")}
                  >
                    <div className="flex items-start gap-3">
                      <ReferenceImageThumb url={m.reference_image_url} openHref={amazonListingUrl(m.asin)} alt={m.title} />

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

                        {viewMode === "catalog" ? (
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
                        ) : (
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
                        )}
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
                          <div
                            className="flex flex-wrap items-center gap-3 text-[11px] text-gray-500 dark:text-gray-400"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
                              disabled={!m.asin || scrapeNow.isPending}
                              onClick={() => scrapeNow.mutate(m.id)}
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                              Scrape
                            </button>
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
                              onClick={() => openEdit(m)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              Bearbeiten
                            </button>
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 text-red-700 hover:text-red-800 dark:text-red-300 dark:hover:text-red-200"
                              onClick={() => requestDelete(m)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Löschen
                            </button>
                          </div>
                          <div className="rounded-lg border border-amber-200/80 bg-gradient-to-br from-amber-50 via-white to-emerald-50/80 p-2.5 dark:border-amber-900/60 dark:from-amber-950/20 dark:via-gray-950 dark:to-emerald-950/20">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <Badge variant={resellerTargetTierVariant(targetSignal.tier)}>{resellerTargetTierLabel(targetSignal.tier)}</Badge>
                              <Badge variant={targetSignal.priceMeetsGoal ? "success" : "outline"}>
                                {targetSignal.priceMeetsGoal ? ">= 40 EUR" : "< 40 EUR"}
                              </Badge>
                            </div>
                            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                              <div className="rounded-md border border-gray-200/80 bg-white/70 px-2 py-1 dark:border-gray-800 dark:bg-gray-950/40">
                                <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">BSR Gesamt</div>
                                <div className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                                  {targetSignal.bsrRank !== null ? `#${targetSignal.bsrRank}` : "—"}
                                </div>
                              </div>
                              <div className="rounded-md border border-gray-200/80 bg-white/70 px-2 py-1 text-right dark:border-gray-800 dark:bg-gray-950/40">
                                <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Verkaufspreis</div>
                                <div className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                                  {fmtMaybeEur(targetSignal.salesPriceCents)}
                                </div>
                              </div>
                            </div>
                            <div className="mt-1 text-[11px] text-gray-600 dark:text-gray-300">{targetSignal.summary}</div>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                              {m.amazon_blocked_last ? <Badge variant="danger">blocked</Badge> : null}
                              {isAmazonStale(m) ? <Badge variant="warning">stale</Badge> : <Badge variant="success">fresh</Badge>}
                              <span className="text-gray-500 dark:text-gray-400">
                                {m.amazon_last_success_at
                                  ? new Date(m.amazon_last_success_at).toLocaleString("de-DE", {
                                      dateStyle: "short",
                                      timeStyle: "short",
                                    })
                                  : "noch nie"}
                              </span>
                            </div>
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
                );
              })}

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
                    <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={openImport}>
                      CSV Import
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
                  {viewMode === "catalog" ? (
                    <>
                      <TableHead>IDs</TableHead>
                      <TableHead className="text-right">
                        <span className="sr-only">Aktionen</span>
                      </TableHead>
                    </>
                  ) : (
                    <>
                      <TableHead>Potenzial</TableHead>
                      <TableHead className="text-right">BSR</TableHead>
                      <TableHead className="text-right">Verkaufspreis</TableHead>
                      <TableHead className="text-right">
                        <span className="sr-only">Details</span>
                      </TableHead>
                    </>
                  )}
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
                      {viewMode === "catalog" ? (
                        <>
                          <TableCell>
                            <div className="space-y-2">
                              <div className="h-3 w-40 rounded bg-gray-100 dark:bg-gray-800" />
                              <div className="h-3 w-32 rounded bg-gray-100 dark:bg-gray-800" />
                            </div>
                          </TableCell>
                          <TableCell />
                        </>
                      ) : (
                        <>
                          <TableCell>
                            <div className="h-3 w-36 rounded bg-gray-100 dark:bg-gray-800" />
                          </TableCell>
                          <TableCell>
                            <div className="ml-auto h-3 w-16 rounded bg-gray-100 dark:bg-gray-800" />
                          </TableCell>
                          <TableCell>
                            <div className="ml-auto h-3 w-20 rounded bg-gray-100 dark:bg-gray-800" />
                          </TableCell>
                          <TableCell>
                            <div className="ml-auto h-7 w-20 rounded bg-gray-100 dark:bg-gray-800" />
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  ))}

                {!list.isPending &&
                  rows.map((m) => {
                    const catalogMeta = [m.manufacturer, m.model, m.genre, m.release_year ? String(m.release_year) : null]
                      .map((value) => (value ?? "").trim())
                      .filter(Boolean)
                      .join(" · ");
                    const targetSignal = resellerTargetSignal(m);
                    const rowTone = viewMode === "amazon" ? resellerTargetRowClass(targetSignal.tier) : "";

                    return (
                      <Fragment key={m.id}>
                      <TableRow className={[TABLE_ROW_COMPACT_CLASS, rowTone].join(" ")}>
                        <TableCell>
                          <div className="flex items-start gap-3">
                            <ReferenceImageThumb url={m.reference_image_url} openHref={amazonListingUrl(m.asin)} alt={m.title} />

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

                              {viewMode === "catalog" && catalogMeta ? (
                                <div className="mt-1 truncate text-[11px] text-gray-500 dark:text-gray-400">
                                  {catalogMeta}
                                </div>
                              ) : null}

                              {viewMode === "catalog" && m.reference_image_url?.trim() ? (
                                <a
                                  href={resolveReferenceImageSrc(m.reference_image_url)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-2 inline-flex items-center gap-1 text-xs text-gray-500 underline-offset-2 hover:underline dark:text-gray-400"
                                  title={resolveReferenceImageSrc(m.reference_image_url)}
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                  {shortUrlLabel(resolveReferenceImageSrc(m.reference_image_url))}
                                </a>
                              ) : null}
                              {viewMode === "amazon" ? (
                                <div
                                  className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-gray-500 dark:text-gray-400"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <button
                                    type="button"
                                    className="inline-flex items-center gap-1 text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
                                    disabled={!m.asin || scrapeNow.isPending}
                                    onClick={() => scrapeNow.mutate(m.id)}
                                  >
                                    <RefreshCw className="h-3.5 w-3.5" />
                                    Scrape
                                  </button>
                                  <button
                                    type="button"
                                    className="inline-flex items-center gap-1 text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
                                    onClick={() => openEdit(m)}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                    Bearbeiten
                                  </button>
                                  <button
                                    type="button"
                                    className="inline-flex items-center gap-1 text-red-700 hover:text-red-800 dark:text-red-300 dark:hover:text-red-200"
                                    onClick={() => requestDelete(m)}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                    Löschen
                                  </button>
                                </div>
                              ) : null}

                            </div>
                          </div>
                        </TableCell>

                        {viewMode === "catalog" ? (
                          <TableCell className="text-sm">
                            {m.ean || m.asin ? (
                              <div className="space-y-1 text-[11px] text-gray-600 dark:text-gray-300">
                                {m.ean ? <div className="truncate font-mono">EAN {m.ean}</div> : null}
                                {m.asin ? <div className="truncate font-mono">ASIN {m.asin}</div> : null}
                              </div>
                            ) : (
                              <span className="text-gray-500 dark:text-gray-400">—</span>
                            )}
                          </TableCell>
                        ) : (
                          <>
                            <TableCell className="text-sm">
                              {!m.asin ? (
                                <span className="text-gray-500 dark:text-gray-400">—</span>
                              ) : (
                                <div className="rounded-lg border border-amber-200/80 bg-gradient-to-br from-amber-50 via-white to-emerald-50/80 px-2.5 py-2 dark:border-amber-900/60 dark:from-amber-950/20 dark:via-gray-950 dark:to-emerald-950/20">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <Badge variant={resellerTargetTierVariant(targetSignal.tier)} className="text-[11px]">
                                      {resellerTargetTierLabel(targetSignal.tier)}
                                    </Badge>
                                    <Badge variant={targetSignal.priceMeetsGoal ? "success" : "outline"} className="text-[11px]">
                                      {targetSignal.priceMeetsGoal ? ">= 40 EUR" : "< 40 EUR"}
                                    </Badge>
                                  </div>
                                  <div className="mt-1 text-[11px] text-gray-600 dark:text-gray-300">{targetSignal.summary}</div>
                                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                    {m.amazon_blocked_last ? <Badge variant="danger">blocked</Badge> : null}
                                    {isAmazonStale(m) ? <Badge variant="warning">stale</Badge> : <Badge variant="success">fresh</Badge>}
                                  </div>
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              <div className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                                {targetSignal.bsrRank !== null ? `#${targetSignal.bsrRank}` : "—"}
                              </div>
                              <div className="mt-0.5 truncate text-[11px] text-gray-500 dark:text-gray-400">{targetSignal.bsrCategory}</div>
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              <div
                                className={[
                                  "ml-auto inline-flex min-w-[7rem] items-center justify-end rounded-md border px-2 py-1 font-semibold tabular-nums",
                                  resellerTargetPriceClass(targetSignal.salesPriceCents),
                                ].join(" ")}
                              >
                                {fmtMaybeEur(targetSignal.salesPriceCents)}
                              </div>
                              <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{targetSignal.salesPriceLabel}</div>
                            </TableCell>
                            <TableCell className={TABLE_ACTION_CELL_CLASS}>
                              <div className={`${TABLE_ACTION_GROUP_CLASS} items-end`}>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2"
                                  aria-label={isExpanded(m.id) ? "Details einklappen" : "Details ausklappen"}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    toggleExpanded(m.id);
                                  }}
                                >
                                  Details
                                  {isExpanded(m.id) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                </Button>
                              </div>
                            </TableCell>
                          </>
                        )}

                        {viewMode === "catalog" ? (
                          <TableCell className={TABLE_ACTION_CELL_CLASS}>
                            <div className={TABLE_ACTION_GROUP_CLASS}>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Aktionen">
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
                          </TableCell>
                        ) : null}
                      </TableRow>
                      {viewMode === "amazon" && m.asin && isExpanded(m.id) ? (
                        <TableRow>
                          <TableCell colSpan={5} className="bg-gray-50/60 py-0 dark:bg-gray-950/30">
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
                                const nextRetryLabel = m.amazon_next_retry_at
                                  ? new Date(m.amazon_next_retry_at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })
                                  : "—";

                                return (
                                  <>
                                  <div className={`mb-2 text-[11px] ${TABLE_CELL_META_CLASS}`}>
                                    Failures {typeof m.amazon_consecutive_failures === "number" ? m.amazon_consecutive_failures : "—"} ·
                                    Next retry {nextRetryLabel}
                                    {m.amazon_block_reason_last ? ` · Block reason: ${m.amazon_block_reason_last}` : ""}
                                  </div>
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
                                  </>
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
                    );
                  })}

                {!rows.length && (
                  <TableRow>
                    <TableCell colSpan={viewMode === "amazon" ? 5 : 3} className="text-sm text-gray-500 dark:text-gray-400">
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
                          <Button type="button" variant="outline" onClick={openImport}>
                            CSV Import
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

      <Dialog open={importOpen} onOpenChange={(open) => setImportOpen(open)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Produktstamm aus CSV importieren</DialogTitle>
            <DialogDescription>
              CSV-Datei hochladen oder CSV-Text einfügen. Pflichtspalten: <code>title</code> und <code>platform</code>. Typ wird standardmäßig als
              Spiel gesetzt, Region als EU.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="master-products-import-file">CSV-Datei</Label>
                <Input
                  id="master-products-import-file"
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  onChange={(e) => {
                    void handleImportFile(e.target.files?.[0] ?? null);
                    e.currentTarget.value = "";
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label>Muster-Header</Label>
                <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-700 dark:border-gray-800 dark:bg-gray-950/40 dark:text-gray-200">
                  kind,title,platform,region,variant,ean,asin
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="master-products-import-csv">CSV-Text</Label>
              <textarea
                id="master-products-import-csv"
                value={importCsvText}
                onChange={(e) => updateImportCsvText(e.target.value)}
                rows={10}
                placeholder={"title,platform,region\nSuper Mario 64,Nintendo 64,EU"}
                className="w-full resize-y rounded-md border border-gray-200 bg-white px-3 py-2 text-[15px] shadow-sm placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus-visible:ring-gray-700 sm:text-sm"
              />
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {importSourceLabel ? `Quelle: ${importSourceLabel}` : "Quelle: direkt eingefügter Text"}
              </div>
            </div>

            {bulkImport.isError && (
              <InlineMessage tone="error">
                {(bulkImport.error as Error).message}
              </InlineMessage>
            )}

            {importResult && (
              <InlineMessage tone={importResult.failed_count > 0 ? "neutral" : "info"}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <span>Zeilen: {importResult.total_rows}</span>
                  <span>Importiert: {importResult.imported_count}</span>
                  <span>Fehler: {importResult.failed_count}</span>
                  <span>Leer/Übersprungen: {importResult.skipped_count}</span>
                </div>
                {importResult.errors.length > 0 ? (
                  <div className="mt-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setShowImportErrors((open) => !open)}
                    >
                      {showImportErrors ? "Fehler ausblenden" : `Fehler anzeigen (${importResult.errors.length})`}
                    </Button>
                    {showImportErrors ? (
                      <div className="mt-2 max-h-56 overflow-auto rounded-md border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-950/40">
                        {importResult.errors.map((error) => (
                          <div
                            key={`${error.row_number}-${error.title ?? "untitled"}-${error.message}`}
                            className="border-b border-gray-100 px-1 py-1.5 text-xs last:border-b-0 dark:border-gray-800"
                          >
                            <span className="font-medium text-gray-900 dark:text-gray-100">Zeile {error.row_number}</span>
                            {error.title ? ` (${error.title})` : ""}: {error.message}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </InlineMessage>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" onClick={() => setImportOpen(false)} disabled={bulkImport.isPending}>
                Schließen
              </Button>
              <Button type="button" onClick={runImport} disabled={!importCsvText.trim() || bulkImport.isPending}>
                {bulkImport.isPending ? "Import läuft…" : "Import starten"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
                            href={resolveReferenceImageSrc(form.reference_image_url)}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 block break-all text-xs text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
                          >
                            {resolveReferenceImageSrc(form.reference_image_url)}
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
              <InlineMessage tone="error">
                {((editorMode === "create" ? create.error : update.error) as Error).message}
              </InlineMessage>
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
            <InlineMessage tone="error">
              {(remove.error as Error).message}
            </InlineMessage>
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
