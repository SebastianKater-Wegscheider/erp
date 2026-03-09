import { Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { InlineMessage } from "../components/ui/inline-message";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PageHeader } from "../components/ui/page-header";
import { useApi } from "../lib/api";


type SourcingSetting = {
  key: string;
  value_int?: number | null;
  value_text?: string | null;
  value_json?: unknown;
  description?: string | null;
};

type FormState = {
  scrape_interval_seconds: string;
  ebay_empty_results_degraded_after_runs: string;
  sourcing_retention_days: string;
  sourcing_retention_max_delete_per_tick: string;
  search_terms_json: string;
};

function toInt(input: string): number {
  return Number.parseInt(input.trim(), 10);
}

export function SourcingSettingsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState | null>(null);

  const settingsQuery = useQuery({
    queryKey: ["sourcing-settings"],
    queryFn: () => api.request<SourcingSetting[]>("/sourcing/settings"),
  });

  const mapped = useMemo(() => {
    const byKey = new Map<string, SourcingSetting>();
    for (const row of settingsQuery.data ?? []) byKey.set(row.key, row);
    return byKey;
  }, [settingsQuery.data]);

  useEffect(() => {
    if (form || !settingsQuery.data) return;
    const searchTerms = mapped.get("search_terms")?.value_json;
    setForm({
      scrape_interval_seconds: String(mapped.get("scrape_interval_seconds")?.value_int ?? 1800),
      ebay_empty_results_degraded_after_runs: String(mapped.get("ebay_empty_results_degraded_after_runs")?.value_int ?? 3),
      sourcing_retention_days: String(mapped.get("sourcing_retention_days")?.value_int ?? 180),
      sourcing_retention_max_delete_per_tick: String(mapped.get("sourcing_retention_max_delete_per_tick")?.value_int ?? 500),
      search_terms_json: JSON.stringify(searchTerms ?? ["videospiele konvolut"], null, 2),
    });
  }, [form, mapped, settingsQuery.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error("Form not ready");
      const parsedSearchTerms = JSON.parse(form.search_terms_json);
      return api.request<SourcingSetting[]>("/sourcing/settings", {
        method: "PUT",
        json: {
          values: {
            scrape_interval_seconds: { value_int: toInt(form.scrape_interval_seconds) },
            ebay_empty_results_degraded_after_runs: { value_int: toInt(form.ebay_empty_results_degraded_after_runs) },
            sourcing_retention_days: { value_int: toInt(form.sourcing_retention_days) },
            sourcing_retention_max_delete_per_tick: { value_int: toInt(form.sourcing_retention_max_delete_per_tick) },
            search_terms: { value_json: parsedSearchTerms },
          },
        },
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sourcing-settings"] });
    },
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Sourcing Settings" description="Scrape cadence, retention, and default search terms for the Codex-backed sourcing inbox." />

      {settingsQuery.isLoading ? <InlineMessage>Lade Settings…</InlineMessage> : null}
      {settingsQuery.error ? <InlineMessage tone="error">Settings konnten nicht geladen werden</InlineMessage> : null}

      {form ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Konfiguration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Scrape Intervall (s)" value={form.scrape_interval_seconds} onChange={(v) => setForm({ ...form, scrape_interval_seconds: v })} />
                <Field label="eBay Empty -> Degraded (runs)" value={form.ebay_empty_results_degraded_after_runs} onChange={(v) => setForm({ ...form, ebay_empty_results_degraded_after_runs: v })} />
                <Field label="Retention (days)" value={form.sourcing_retention_days} onChange={(v) => setForm({ ...form, sourcing_retention_days: v })} />
                <Field label="Retention delete cap/tick" value={form.sourcing_retention_max_delete_per_tick} onChange={(v) => setForm({ ...form, sourcing_retention_max_delete_per_tick: v })} />
              </div>

              <div className="space-y-1">
                <Label htmlFor="search_terms_json">Search Terms (JSON Array)</Label>
                <textarea
                  id="search_terms_json"
                  className="min-h-[180px] w-full rounded-md border border-[color:var(--app-border)] bg-[color:var(--app-surface)] px-3 py-2 text-sm"
                  value={form.search_terms_json}
                  onChange={(e) => setForm({ ...form, search_terms_json: e.target.value })}
                />
              </div>

              <Button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
                <Save className="h-4 w-4" />
                Speichern
              </Button>
              {save.error ? <InlineMessage tone="error">Speichern fehlgeschlagen: {String(save.error)}</InlineMessage> : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Hinweis zu Codex Runtime</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-[color:var(--app-text-muted)]">
                Codex CLI Runtime-Parameter wie Binary-Pfad, Timeout, Worker-Takt und Web-Search werden bewusst als Container-Umgebungsvariablen verwaltet, nicht in der Datenbank.
              </p>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
