import { ExternalLink, Image as ImageIcon, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import { useApi } from "../lib/api";
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

function IdPill({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-0.5 text-[11px] text-gray-700 dark:border-gray-800 dark:bg-gray-950/40 dark:text-gray-200">
      <span className="shrink-0 text-gray-500 dark:text-gray-400">{label}:</span>
      <span className="min-w-0 break-all font-mono">{value}</span>
    </span>
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
  const createParam = searchParams.get("create");
  const handledCreateRef = useRef(false);
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<MasterProductKind | "ALL">("ALL");

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

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let all = list.data ?? [];
    if (kindFilter !== "ALL") all = all.filter((m) => m.kind === kindFilter);
    if (!q) return all;
    return all.filter((m) =>
      `${m.kind} ${m.sku} ${m.title} ${m.manufacturer ?? ""} ${m.model ?? ""} ${m.platform} ${m.region} ${m.variant} ${m.ean ?? ""} ${m.asin ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [kindFilter, list.data, search]);

  const totalCount = list.data?.length ?? 0;

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
          <div className="flex flex-col gap-1">
            <CardTitle>Produkte</CardTitle>
            <CardDescription>
              {list.isPending ? "Lade…" : `${rows.length}${rows.length !== totalCount ? ` / ${totalCount}` : ""} Produkte`}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
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

            <div className="flex items-center gap-2">
              <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as MasterProductKind | "ALL")}>
                <SelectTrigger className="w-full md:w-[190px]">
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
            </div>
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
                              onSelect={(e) => {
                                e.preventDefault();
                                openEdit(m);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                              Bearbeiten
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

                      <div className="mt-2 flex flex-wrap gap-1">
                        <IdPill label="EAN" value={m.ean ? m.ean : "—"} />
                        <IdPill label="ASIN" value={m.asin ? m.asin : "—"} />
                      </div>

                      <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                        UUID: <span className="break-all font-mono text-gray-400 dark:text-gray-500">{m.id}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}

            {!list.isPending && !rows.length && (
              <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-300">
                <div className="flex flex-col items-start gap-2">
                  <div>Keine Produkte gefunden.</div>
                  <div className="flex w-full flex-col gap-2 sm:flex-row">
                    <Button type="button" variant="secondary" className="w-full sm:w-auto" onClick={() => setSearch("")} disabled={!search.trim()}>
                      Suche zurücksetzen
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
                  <TableHead>IDs</TableHead>
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
                    <TableRow key={m.id}>
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

                            {(m.manufacturer || m.model || m.genre || m.release_year) && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {m.manufacturer ? <MetaPill>{m.manufacturer}</MetaPill> : null}
                                {m.model ? <MetaPill>{m.model}</MetaPill> : null}
                                {m.genre ? <MetaPill>{m.genre}</MetaPill> : null}
                                {m.release_year ? <MetaPill>{m.release_year}</MetaPill> : null}
                              </div>
                            )}

                            {m.reference_image_url?.trim() ? (
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
                          </div>
                        </div>
                      </TableCell>

                      <TableCell className="text-sm">
                        <div className="flex flex-wrap gap-1">
                          {m.ean ? <IdPill label="EAN" value={m.ean} /> : <IdPill label="EAN" value="—" />}
                          {m.asin ? <IdPill label="ASIN" value={m.asin} /> : <IdPill label="ASIN" value="—" />}
                        </div>

                        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                          UUID: <span className="font-mono text-gray-400 dark:text-gray-500">{m.id}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
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
                                openEdit(m);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                              Bearbeiten
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
                  ))}

                {!rows.length && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-sm text-gray-500 dark:text-gray-400">
                      <div className="flex flex-col items-start gap-2 py-3">
                        <div>Keine Produkte gefunden.</div>
                        <div className="flex items-center gap-2">
                          <Button type="button" variant="secondary" onClick={() => setSearch("")} disabled={!search.trim()}>
                            Suche zurücksetzen
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
