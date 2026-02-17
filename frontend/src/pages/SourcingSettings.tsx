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
  bsr_max_threshold: string;
  price_min_cents: string;
  price_max_cents: string;
  confidence_min_score: string;
  profit_min_cents: string;
  roi_min_bp: string;
  scrape_interval_seconds: string;
  handling_cost_per_item_cents: string;
  shipping_cost_cents: string;
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
      bsr_max_threshold: String(mapped.get("bsr_max_threshold")?.value_int ?? 50000),
      price_min_cents: String(mapped.get("price_min_cents")?.value_int ?? 500),
      price_max_cents: String(mapped.get("price_max_cents")?.value_int ?? 30000),
      confidence_min_score: String(mapped.get("confidence_min_score")?.value_int ?? 80),
      profit_min_cents: String(mapped.get("profit_min_cents")?.value_int ?? 3000),
      roi_min_bp: String(mapped.get("roi_min_bp")?.value_int ?? 5000),
      scrape_interval_seconds: String(mapped.get("scrape_interval_seconds")?.value_int ?? 1800),
      handling_cost_per_item_cents: String(mapped.get("handling_cost_per_item_cents")?.value_int ?? 150),
      shipping_cost_cents: String(mapped.get("shipping_cost_cents")?.value_int ?? 690),
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
            bsr_max_threshold: { value_int: toInt(form.bsr_max_threshold) },
            price_min_cents: { value_int: toInt(form.price_min_cents) },
            price_max_cents: { value_int: toInt(form.price_max_cents) },
            confidence_min_score: { value_int: toInt(form.confidence_min_score) },
            profit_min_cents: { value_int: toInt(form.profit_min_cents) },
            roi_min_bp: { value_int: toInt(form.roi_min_bp) },
            scrape_interval_seconds: { value_int: toInt(form.scrape_interval_seconds) },
            handling_cost_per_item_cents: { value_int: toInt(form.handling_cost_per_item_cents) },
            shipping_cost_cents: { value_int: toInt(form.shipping_cost_cents) },
            search_terms: { value_json: parsedSearchTerms },
          },
        },
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sourcing-settings"] });
      await qc.invalidateQueries({ queryKey: ["sourcing-items"] });
    },
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Sourcing Settings" description="Thresholds, Frequenz und Suchbegriffe" />

      {settingsQuery.isLoading ? <InlineMessage>Lade Settings…</InlineMessage> : null}
      {settingsQuery.error ? <InlineMessage tone="error">Settings konnten nicht geladen werden</InlineMessage> : null}

      {form ? (
        <Card>
          <CardHeader>
            <CardTitle>Konfiguration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="BSR Max" value={form.bsr_max_threshold} onChange={(v) => setForm({ ...form, bsr_max_threshold: v })} />
              <Field label="Price Min (cents)" value={form.price_min_cents} onChange={(v) => setForm({ ...form, price_min_cents: v })} />
              <Field label="Price Max (cents)" value={form.price_max_cents} onChange={(v) => setForm({ ...form, price_max_cents: v })} />
              <Field label="Confidence Min" value={form.confidence_min_score} onChange={(v) => setForm({ ...form, confidence_min_score: v })} />
              <Field label="Profit Min (cents)" value={form.profit_min_cents} onChange={(v) => setForm({ ...form, profit_min_cents: v })} />
              <Field label="ROI Min (bp)" value={form.roi_min_bp} onChange={(v) => setForm({ ...form, roi_min_bp: v })} />
              <Field label="Scrape Intervall (s)" value={form.scrape_interval_seconds} onChange={(v) => setForm({ ...form, scrape_interval_seconds: v })} />
              <Field label="Handling pro Item (cents)" value={form.handling_cost_per_item_cents} onChange={(v) => setForm({ ...form, handling_cost_per_item_cents: v })} />
              <Field label="Versandkosten (cents)" value={form.shipping_cost_cents} onChange={(v) => setForm({ ...form, shipping_cost_cents: v })} />
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
