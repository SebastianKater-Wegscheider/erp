import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, ArrowRight, CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { useApi } from "../../lib/api";
import { formatEur } from "../../lib/money";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Badge } from "../ui/badge";
import { InlineMessage } from "../ui/inline-message";

// Types matching backend schemas
type TargetPriceMode = "AUTO" | "MANUAL";
type InventoryStatus = "DRAFT" | "AVAILABLE" | "FBA_INBOUND" | "FBA_WAREHOUSE" | "RESERVED" | "SOLD" | "RETURNED" | "DISCREPANCY" | "LOST";
type AsinState = "MISSING" | "FRESH" | "STALE" | "BLOCKED";

type BulkTargetPricingFilters = {
    match_status?: InventoryStatus[] | null;
    match_target_price_mode?: TargetPriceMode[] | null;
    match_search_query?: string | null;
    match_asin_state?: AsinState[] | null;
};

type BulkTargetPricingRequest = {
    filters: BulkTargetPricingFilters;
    set_target_price_mode: TargetPriceMode;
    set_manual_target_sell_price_cents?: number | null;
};

type BulkTargetPricingPreviewRow = {
    item_id: string;
    item_code: string;
    title: string;
    current_mode: TargetPriceMode;
    current_effective_cents: number | null;
    new_mode: TargetPriceMode;
    new_manual_cents: number | null;
    new_effective_cents: number | null;
    new_effective_source: string;
    diff_cents: number | null;
};

type BulkTargetPricingPreviewResponse = {
    total_items_matched: number;
    total_items_changed: number;
    preview_rows: BulkTargetPricingPreviewRow[];
};

type BulkTargetPricingApplyResponse = {
    updated_count: number;
};

export function BulkTargetPricingDialog({ trigger }: { trigger?: React.ReactNode }) {
    const api = useApi();
    const qc = useQueryClient();
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState<"FILTER" | "PREVIEW" | "SUCCESS">("FILTER");

    // Filter States
    const [filterMode, setFilterMode] = useState<"ALL" | "AUTO" | "MANUAL">("ALL");
    const [filterQuery, setFilterQuery] = useState("");
    const [filterStatusAvailableOnly, setFilterStatusAvailableOnly] = useState(true);

    // Action States
    const [targetMode, setTargetMode] = useState<TargetPriceMode>("AUTO");
    const [manualPrice, setManualPrice] = useState("");

    // Data States
    const [previewData, setPreviewData] = useState<BulkTargetPricingPreviewResponse | null>(null);
    const [applyResult, setApplyResult] = useState<BulkTargetPricingApplyResponse | null>(null);

    const previewMutation = useMutation({
        mutationFn: async () => {
            const filters: BulkTargetPricingFilters = {};
            if (filterMode !== "ALL") filters.match_target_price_mode = [filterMode];
            if (filterQuery.trim()) filters.match_search_query = filterQuery.trim();
            if (filterStatusAvailableOnly) filters.match_status = ["AVAILABLE", "FBA_WAREHOUSE", "FBA_INBOUND"];

            const payload: BulkTargetPricingRequest = {
                filters,
                set_target_price_mode: targetMode,
                set_manual_target_sell_price_cents: targetMode === "MANUAL" ? Math.round(parseFloat(manualPrice.replace(",", ".")) * 100) : null,
            };

            if (targetMode === "MANUAL" && (typeof payload.set_manual_target_sell_price_cents !== "number" || isNaN(payload.set_manual_target_sell_price_cents) || payload.set_manual_target_sell_price_cents < 0)) {
                throw new Error("Bitte einen gültigen Preis eingeben.");
            }

            return api.request<BulkTargetPricingPreviewResponse>("/inventory/target-pricing/preview", {
                method: "POST",
                json: payload,
            });
        },
        onSuccess: (data) => {
            setPreviewData(data);
            setStep("PREVIEW");
        },
    });

    const applyMutation = useMutation({
        mutationFn: async () => {
            if (!previewData) throw new Error("Keine Vorschau vorhanden.");
            // Re-construct payload (same as preview)
            const filters: BulkTargetPricingFilters = {};
            if (filterMode !== "ALL") filters.match_target_price_mode = [filterMode];
            if (filterQuery.trim()) filters.match_search_query = filterQuery.trim();
            if (filterStatusAvailableOnly) filters.match_status = ["AVAILABLE", "FBA_WAREHOUSE", "FBA_INBOUND"];

            const payload: BulkTargetPricingRequest = {
                filters,
                set_target_price_mode: targetMode,
                set_manual_target_sell_price_cents: targetMode === "MANUAL" ? Math.round(parseFloat(manualPrice.replace(",", ".")) * 100) : null,
            };

            return api.request<BulkTargetPricingApplyResponse>("/inventory/target-pricing/apply", {
                method: "POST",
                json: payload,
            });
        },
        onSuccess: (data) => {
            setApplyResult(data);
            setStep("SUCCESS");
            qc.invalidateQueries({ queryKey: ["inventory"] });
        },
    });

    const reset = () => {
        setStep("FILTER");
        setPreviewData(null);
        setApplyResult(null);
        setFilterMode("ALL");
        setFilterQuery("");
        setTargetMode("AUTO");
        setManualPrice("");
    };

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); setOpen(v); }}>
            <DialogTrigger asChild>
                {trigger || <Button variant="outline">Massenbearbeitung</Button>}
            </DialogTrigger>
            <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Zielpreise: Massenbearbeitung</DialogTitle>
                    <DialogDescription>
                        Ändern Sie den Preismodus für mehrere Artikel gleichzeitig.
                    </DialogDescription>
                </DialogHeader>

                {step === "FILTER" && (
                    <div className="space-y-6 py-4">
                        <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-4 rounded-md border p-4 dark:border-gray-800">
                                <h3 className="font-medium text-sm">1. Welche Artikel filtern?</h3>

                                <div className="space-y-2">
                                    <Label>Aktueller Modus</Label>
                                    <Select value={filterMode} onValueChange={(v: any) => setFilterMode(v)}>
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="ALL">Alle Modi</SelectItem>
                                            <SelectItem value="AUTO">Nur Auto-Preis</SelectItem>
                                            <SelectItem value="MANUAL">Nur Manuell</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="space-y-2">
                                    <Label>Suchbegriff (Titel/SKU)</Label>
                                    <Input value={filterQuery} onChange={e => setFilterQuery(e.target.value)} placeholder="Optional einschränken..." />
                                </div>

                                <div className="flex items-center space-x-2">
                                    <input
                                        type="checkbox"
                                        id="statusFilter"
                                        checked={filterStatusAvailableOnly}
                                        onChange={(e) => setFilterStatusAvailableOnly(e.target.checked)}
                                        className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary dark:border-gray-600 dark:bg-gray-800"
                                    />
                                    <Label htmlFor="statusFilter" className="font-normal text-sm text-gray-500 dark:text-gray-400">
                                        Nur Verfügbar/FBA (keine Verkauften/Drafts)
                                    </Label>
                                </div>
                            </div>

                            <div className="space-y-4 rounded-md border p-4 bg-gray-50 dark:bg-gray-900/50 dark:border-gray-800">
                                <h3 className="font-medium text-sm">2. Welche Änderung anwenden?</h3>

                                <div className="space-y-2">
                                    <Label>Neuer Modus</Label>
                                    <Select value={targetMode} onValueChange={(v: TargetPriceMode) => setTargetMode(v)}>
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="AUTO">Automatisch (Empfohlen)</SelectItem>
                                            <SelectItem value="MANUAL">Manuell Festlegen</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                        {targetMode === "AUTO"
                                            ? "Der Zielpreis wird basierend auf Marktpreisen und Margen-Regeln berechnet."
                                            : "Der Zielpreis wird fest auf den eingegebenen Wert gesetzt."}
                                    </p>
                                </div>

                                {targetMode === "MANUAL" && (
                                    <div className="space-y-2">
                                        <Label>Neuer Festpreis (EUR)</Label>
                                        <Input
                                            type="number"
                                            step="0.01"
                                            min="0"
                                            value={manualPrice}
                                            onChange={e => setManualPrice(e.target.value)}
                                            placeholder="0.00"
                                        />
                                    </div>
                                )}
                            </div>
                        </div>

                        {previewMutation.isError && (
                            <InlineMessage tone="error">
                                {(previewMutation.error as Error).message}
                            </InlineMessage>
                        )}

                        <DialogFooter>
                            <Button onClick={() => previewMutation.mutate()} disabled={previewMutation.isPending}>
                                {previewMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                Vorschau anzeigen
                                <ArrowRight className="ml-2 h-4 w-4" />
                            </Button>
                        </DialogFooter>
                    </div>
                )}

                {step === "PREVIEW" && previewData && (
                    <div className="space-y-4 py-4">
                        <div className="flex items-center justify-between rounded-md bg-gray-100 p-4 dark:bg-gray-800">
                            <div>
                                <div className="font-medium text-gray-900 dark:text-gray-100">Gefundene Artikel: {previewData.total_items_matched}</div>
                                <div className="text-sm text-gray-500 dark:text-gray-400">Davon werden aktualisiert: {previewData.total_items_changed}</div>
                            </div>
                            {previewData.total_items_changed === 0 && (
                                <div className="text-sm text-amber-600 font-medium dark:text-amber-400">Keine Änderungen notwendig.</div>
                            )}
                        </div>

                        <div className="max-h-[400px] overflow-y-auto rounded-md border dark:border-gray-800">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Artikel</TableHead>
                                        <TableHead>Aktuell</TableHead>
                                        <TableHead>Neu</TableHead>
                                        <TableHead className="text-right">Differenz</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {previewData.preview_rows.map((row) => (
                                        <TableRow key={row.item_id}>
                                            <TableCell className="max-w-[200px]">
                                                <div className="font-medium truncate text-gray-900 dark:text-gray-100" title={row.title}>{row.title}</div>
                                                <div className="text-xs font-mono text-gray-500 dark:text-gray-400">{row.item_code}</div>
                                            </TableCell>
                                            <TableCell>
                                                <div className="text-sm text-gray-600 dark:text-gray-300">
                                                    {row.current_mode === "MANUAL" ? "Manuell" : "Auto"}
                                                </div>
                                                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                                                    {row.current_effective_cents ? formatEur(row.current_effective_cents) + " €" : "—"}
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <div className="text-sm text-gray-600 dark:text-gray-300">
                                                    {row.new_mode === "MANUAL" ? "Manuell" : "Auto"}
                                                </div>
                                                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                                                    {row.new_effective_cents ? formatEur(row.new_effective_cents) + " €" : "—"}
                                                </div>
                                                <div className="text-xs text-gray-500 dark:text-gray-400">
                                                    {row.new_effective_source}
                                                </div>
                                            </TableCell>
                                            <TableCell className="text-right">
                                                {row.diff_cents !== null && row.diff_cents !== 0 ? (
                                                    <Badge variant={row.diff_cents > 0 ? "success" : "secondary"}>
                                                        {row.diff_cents > 0 ? "+" : ""}{formatEur(row.diff_cents)} €
                                                    </Badge>
                                                ) : (
                                                    <span className="text-gray-400 text-sm dark:text-gray-500">—</span>
                                                )}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                    {previewData.preview_rows.length === 0 && (
                                        <TableRow>
                                            <TableCell colSpan={4} className="text-center text-gray-500 py-8 dark:text-gray-400">
                                                Keine Artikel zur Anzeige.
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

                        <DialogFooter className="gap-2 sm:gap-0">
                            <Button variant="outline" onClick={() => setStep("FILTER")}>Zurück</Button>
                            <Button
                                onClick={() => applyMutation.mutate()}
                                disabled={applyMutation.isPending || previewData.total_items_changed === 0}
                            >
                                {applyMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                Änderungen anwenden ({previewData.total_items_changed})
                            </Button>
                        </DialogFooter>
                    </div>
                )}

                {step === "SUCCESS" && applyResult && (
                    <div className="space-y-6 py-8 text-center">
                        <div className="flex justify-center">
                            <div className="rounded-full bg-green-100 p-3 text-green-600 dark:bg-green-900/30 dark:text-green-400">
                                <CheckCircle2 className="h-8 w-8" />
                            </div>
                        </div>
                        <div className="space-y-2">
                            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Erfolgreich aktualisiert</h3>
                            <p className="text-gray-500 dark:text-gray-400">
                                Es wurden {applyResult.updated_count} Artikel aktualisiert.
                            </p>
                        </div>
                        <DialogFooter>
                            <Button onClick={() => setOpen(false)}>Schließen</Button>
                        </DialogFooter>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
