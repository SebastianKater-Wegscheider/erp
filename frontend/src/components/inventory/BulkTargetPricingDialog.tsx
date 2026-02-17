import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useApi } from "../../lib/api";
import { formatEur } from "../../lib/money";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";
import { InlineMessage } from "../ui/inline-message";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

type InventoryCondition = "NEW" | "LIKE_NEW" | "GOOD" | "ACCEPTABLE" | "DEFECT";
type TargetPricingAsinState = "ANY" | "WITH_ASIN" | "WITHOUT_ASIN";
type TargetPricingOperation = "APPLY_RECOMMENDED_MANUAL" | "CLEAR_MANUAL_USE_AUTO";

type TargetPricingBulkRequest = {
  filters: {
    conditions?: InventoryCondition[] | null;
    asin_state: TargetPricingAsinState;
    bsr_min?: number | null;
    bsr_max?: number | null;
    offers_min?: number | null;
    offers_max?: number | null;
  };
  operation: TargetPricingOperation;
};

type TargetPricingBulkPreviewRow = {
  item_id: string;
  item_code: string;
  title: string;
  condition: InventoryCondition;
  asin?: string | null;
  rank?: number | null;
  offers_count?: number | null;
  before_target_price_mode: "AUTO" | "MANUAL";
  before_effective_target_sell_price_cents?: number | null;
  after_target_price_mode: "AUTO" | "MANUAL";
  after_effective_target_sell_price_cents?: number | null;
  delta_cents?: number | null;
};

type TargetPricingBulkPreviewResponse = {
  matched_count: number;
  applicable_count: number;
  truncated: boolean;
  rows: TargetPricingBulkPreviewRow[];
};

type TargetPricingBulkApplyResponse = {
  matched_count: number;
  updated_count: number;
  skipped_count: number;
  sample_updated_item_ids: string[];
};

const CONDITION_OPTIONS: Array<{ value: InventoryCondition; label: string }> = [
  { value: "NEW", label: "Neu" },
  { value: "LIKE_NEW", label: "Wie neu" },
  { value: "GOOD", label: "Gut" },
  { value: "ACCEPTABLE", label: "Akzeptabel" },
  { value: "DEFECT", label: "Defekt" },
];

function parseOptionalInt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function BulkTargetPricingDialog({ trigger }: { trigger?: ReactNode }) {
  const api = useApi();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"FILTER" | "PREVIEW" | "SUCCESS">("FILTER");

  const [conditions, setConditions] = useState<InventoryCondition[]>([]);
  const [asinState, setAsinState] = useState<TargetPricingAsinState>("ANY");
  const [bsrMin, setBsrMin] = useState("");
  const [bsrMax, setBsrMax] = useState("");
  const [offersMin, setOffersMin] = useState("");
  const [offersMax, setOffersMax] = useState("");
  const [operation, setOperation] = useState<TargetPricingOperation>("APPLY_RECOMMENDED_MANUAL");

  const [previewData, setPreviewData] = useState<TargetPricingBulkPreviewResponse | null>(null);
  const [applyResult, setApplyResult] = useState<TargetPricingBulkApplyResponse | null>(null);

  const payload = useMemo<TargetPricingBulkRequest>(() => {
    const request: TargetPricingBulkRequest = {
      filters: {
        asin_state: asinState,
      },
      operation,
    };
    if (conditions.length) request.filters.conditions = conditions;
    const parsedBsrMin = parseOptionalInt(bsrMin);
    const parsedBsrMax = parseOptionalInt(bsrMax);
    const parsedOffersMin = parseOptionalInt(offersMin);
    const parsedOffersMax = parseOptionalInt(offersMax);
    if (parsedBsrMin !== null) request.filters.bsr_min = parsedBsrMin;
    if (parsedBsrMax !== null) request.filters.bsr_max = parsedBsrMax;
    if (parsedOffersMin !== null) request.filters.offers_min = parsedOffersMin;
    if (parsedOffersMax !== null) request.filters.offers_max = parsedOffersMax;
    return request;
  }, [asinState, bsrMax, bsrMin, conditions, offersMax, offersMin, operation]);

  const previewMutation = useMutation({
    mutationFn: () =>
      api.request<TargetPricingBulkPreviewResponse>("/inventory/target-pricing/preview", {
        method: "POST",
        json: payload,
      }),
    onSuccess: (data) => {
      setPreviewData(data);
      setStep("PREVIEW");
    },
  });

  const applyMutation = useMutation({
    mutationFn: () =>
      api.request<TargetPricingBulkApplyResponse>("/inventory/target-pricing/apply", {
        method: "POST",
        json: payload,
      }),
    onSuccess: async (data) => {
      setApplyResult(data);
      setStep("SUCCESS");
      await qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });

  function toggleCondition(condition: InventoryCondition) {
    setConditions((current) => (current.includes(condition) ? current.filter((value) => value !== condition) : [...current, condition]));
  }

  function reset() {
    setStep("FILTER");
    setConditions([]);
    setAsinState("ANY");
    setBsrMin("");
    setBsrMax("");
    setOffersMin("");
    setOffersMax("");
    setOperation("APPLY_RECOMMENDED_MANUAL");
    setPreviewData(null);
    setApplyResult(null);
    previewMutation.reset();
    applyMutation.reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) reset();
        setOpen(value);
      }}
    >
      <DialogTrigger asChild>{trigger ?? <Button variant="outline">Bulk Pricing</Button>}</DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Zielpreise: Bulk Pricing</DialogTitle>
          <DialogDescription>Filter definieren, Vorschau prüfen, dann einmalig anwenden.</DialogDescription>
        </DialogHeader>

        {step === "FILTER" && (
          <div className="space-y-5 py-2">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3 rounded-md border p-4 dark:border-gray-800">
                <div className="text-sm font-medium">Filter</div>
                <div className="space-y-2">
                  <Label>Zustand</Label>
                  <div className="flex flex-wrap gap-2">
                    {CONDITION_OPTIONS.map((condition) => (
                      <button
                        key={condition.value}
                        type="button"
                        className="rounded-md"
                        onClick={() => toggleCondition(condition.value)}
                      >
                        <Badge variant={conditions.includes(condition.value) ? "secondary" : "outline"}>{condition.label}</Badge>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>ASIN</Label>
                  <Select value={asinState} onValueChange={(value: TargetPricingAsinState) => setAsinState(value)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ANY">Alle</SelectItem>
                      <SelectItem value="WITH_ASIN">Mit ASIN</SelectItem>
                      <SelectItem value="WITHOUT_ASIN">Ohne ASIN</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>BSR min</Label>
                    <Input type="number" min="0" value={bsrMin} onChange={(event) => setBsrMin(event.target.value)} placeholder="z. B. 1" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>BSR max</Label>
                    <Input type="number" min="0" value={bsrMax} onChange={(event) => setBsrMax(event.target.value)} placeholder="z. B. 10000" />
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Offers min</Label>
                    <Input
                      type="number"
                      min="0"
                      value={offersMin}
                      onChange={(event) => setOffersMin(event.target.value)}
                      placeholder="z. B. 0"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Offers max</Label>
                    <Input
                      type="number"
                      min="0"
                      value={offersMax}
                      onChange={(event) => setOffersMax(event.target.value)}
                      placeholder="z. B. 12"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-3 rounded-md border bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-900/40">
                <div className="text-sm font-medium">Operation</div>
                <Select value={operation} onValueChange={(value: TargetPricingOperation) => setOperation(value)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="APPLY_RECOMMENDED_MANUAL">Empfehlung als Manuell setzen</SelectItem>
                    <SelectItem value="CLEAR_MANUAL_USE_AUTO">Manuell löschen, Auto verwenden</SelectItem>
                  </SelectContent>
                </Select>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {operation === "APPLY_RECOMMENDED_MANUAL"
                    ? "Setzt pro Treffer den aktuellen Empfehlungswert als fixen manuellen Zielpreis."
                    : "Löscht manuelle Zielpreise und nutzt wieder die automatische Empfehlung."}
                </div>
              </div>
            </div>

            {previewMutation.isError && (
              <InlineMessage tone="error">
                {(previewMutation.error as Error).message}
              </InlineMessage>
            )}

            <DialogFooter>
              <Button onClick={() => previewMutation.mutate()} disabled={previewMutation.isPending}>
                {previewMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Vorschau anzeigen
                <ArrowRight className="h-4 w-4" />
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "PREVIEW" && previewData && (
          <div className="space-y-4 py-2">
            <div className="rounded-md bg-gray-100 p-3 text-sm dark:bg-gray-800">
              Treffer: <strong>{previewData.matched_count}</strong> · Anwendbar: <strong>{previewData.applicable_count}</strong>
              {previewData.truncated && <span className="ml-2 text-amber-600 dark:text-amber-400">Vorschau gekürzt (max 200).</span>}
            </div>

            <div className="max-h-[420px] overflow-y-auto rounded-md border dark:border-gray-800">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Artikel</TableHead>
                    <TableHead>Kontext</TableHead>
                    <TableHead>Vorher</TableHead>
                    <TableHead>Nachher</TableHead>
                    <TableHead className="text-right">Delta</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewData.rows.map((row) => (
                    <TableRow key={row.item_id}>
                      <TableCell className="max-w-[260px]">
                        <div className="truncate font-medium" title={row.title}>{row.title}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">{row.item_code}</div>
                      </TableCell>
                      <TableCell className="text-xs text-gray-600 dark:text-gray-300">
                        <div>{row.condition}</div>
                        <div>{row.asin ? `ASIN ${row.asin}` : "ohne ASIN"}</div>
                        <div>{typeof row.rank === "number" ? `BSR #${row.rank}` : "BSR —"}</div>
                        <div>{typeof row.offers_count === "number" ? `Offers ${row.offers_count}` : "Offers —"}</div>
                      </TableCell>
                      <TableCell>
                        <div className="text-xs text-gray-500 dark:text-gray-400">{row.before_target_price_mode}</div>
                        <div className="font-medium">
                          {typeof row.before_effective_target_sell_price_cents === "number"
                            ? `${formatEur(row.before_effective_target_sell_price_cents)} €`
                            : "—"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-xs text-gray-500 dark:text-gray-400">{row.after_target_price_mode}</div>
                        <div className="font-medium">
                          {typeof row.after_effective_target_sell_price_cents === "number"
                            ? `${formatEur(row.after_effective_target_sell_price_cents)} €`
                            : "—"}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {typeof row.delta_cents === "number" && row.delta_cents !== 0 ? (
                          <span className={row.delta_cents > 0 ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}>
                            {row.delta_cents > 0 ? "+" : ""}
                            {formatEur(row.delta_cents)} €
                          </span>
                        ) : (
                          <span className="text-gray-400">0,00 €</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!previewData.rows.length && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-sm text-gray-500 dark:text-gray-400">
                        Keine Änderungen anwendbar.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            {applyMutation.isError && (
              <InlineMessage tone="error">
                {(applyMutation.error as Error).message}
              </InlineMessage>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("FILTER")} disabled={applyMutation.isPending}>
                Zurück
              </Button>
              <Button
                onClick={() => applyMutation.mutate()}
                disabled={applyMutation.isPending || previewData.applicable_count === 0}
              >
                {applyMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Anwenden
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "SUCCESS" && applyResult && (
          <div className="space-y-4 py-4">
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-5 w-5" />
              Bulk-Operation abgeschlossen.
            </div>
            <div className="rounded-md bg-gray-100 p-3 text-sm dark:bg-gray-800">
              Treffer: <strong>{applyResult.matched_count}</strong> · Aktualisiert: <strong>{applyResult.updated_count}</strong> · Übersprungen:{" "}
              <strong>{applyResult.skipped_count}</strong>
            </div>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Fertig</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
