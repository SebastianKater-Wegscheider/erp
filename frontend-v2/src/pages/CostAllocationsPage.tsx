import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useApi } from "../api/api";
import { formatEur, fmtEur, parseEurToCents } from "../lib/money";
import { paginateItems } from "../lib/pagination";
import { useTaxProfile } from "../lib/taxProfile";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { InlineAlert } from "../ui/InlineAlert";
import { Pagination } from "../ui/Pagination";

type PaymentSource = "CASH" | "BANK" | "PRIVATE_EQUITY";

type AllocationOut = {
  id: string;
  allocation_date: string;
  description: string;
  amount_cents: number;
  amount_net_cents: number;
  amount_tax_cents: number;
  tax_rate_bp: number;
  input_tax_deductible: boolean;
  payment_source: PaymentSource;
  receipt_upload_path?: string | null;
  created_at: string;
  updated_at: string;
  lines: Array<{
    id: string;
    inventory_item_id: string;
    amount_cents: number;
    amount_net_cents: number;
    amount_tax_cents: number;
  }>;
};

type DraftLine = { ui_id: string; inventory_item_id: string; amount: string };

const PAYMENT_SOURCE_OPTIONS: Array<{ value: PaymentSource; label: string }> = [
  { value: "CASH", label: "Bar" },
  { value: "BANK", label: "Bank" },
];

const TAX_RATE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "0", label: "0%" },
  { value: "1000", label: "10%" },
  { value: "1300", label: "13%" },
  { value: "2000", label: "20%" },
];

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

function safeParseEurToCents(input: string): number | null {
  try {
    return parseEurToCents(input);
  } catch {
    return null;
  }
}

export function CostAllocationsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const taxProfile = useTaxProfile();
  const vatEnabled = taxProfile.data?.vat_enabled ?? true;
  const [params, setParams] = useSearchParams();
  const [message, setMessage] = useState<string | null>(null);

  const search = params.get("q") ?? "";
  const page = Number(params.get("page") ?? "1") || 1;

  const list = useQuery({
    queryKey: ["cost-allocations"],
    queryFn: () => api.request<AllocationOut[]>("/cost-allocations"),
  });

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const all = list.data ?? [];
    if (!needle) return all;
    return all.filter((a) => {
      const hay = `${a.allocation_date} ${a.description} ${a.payment_source} ${formatEur(a.amount_cents)}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [list.data, search]);

  const paged = useMemo(() => paginateItems(rows, page, 30), [page, rows]);

  useEffect(() => {
    if (page !== paged.page) {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("page", String(paged.page));
        return next;
      });
    }
  }, [page, paged.page, setParams]);

  const [allocationDate, setAllocationDate] = useState(todayIsoLocal());
  const [description, setDescription] = useState("");
  const [taxRateBp, setTaxRateBp] = useState("2000");
  const [inputTaxDeductible, setInputTaxDeductible] = useState(true);
  const [paymentSource, setPaymentSource] = useState<PaymentSource>("CASH");
  const [receiptUploadPath, setReceiptUploadPath] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);

  const sumCents = useMemo(() => {
    let sum = 0;
    for (const l of lines) {
      if (!l.inventory_item_id.trim()) continue;
      const parsed = safeParseEurToCents(l.amount || "0");
      if (parsed === null) return null;
      sum += parsed;
    }
    return sum;
  }, [lines]);

  const canSubmit =
    /^\d{4}-\d{2}-\d{2}$/.test(allocationDate) &&
    description.trim().length > 0 &&
    sumCents !== null &&
    sumCents > 0 &&
    lines.some((l) => l.inventory_item_id.trim());

  const create = useMutation({
    mutationFn: async () => {
      if (sumCents === null) throw new Error("Ungültige Beträge");
      return api.request<AllocationOut>("/cost-allocations", {
        method: "POST",
        json: {
          allocation_date: allocationDate,
          description: description.trim(),
          amount_cents: sumCents,
          tax_rate_bp: vatEnabled ? Number(taxRateBp) : 0,
          input_tax_deductible: inputTaxDeductible,
          payment_source: paymentSource,
          receipt_upload_path: receiptUploadPath.trim() ? receiptUploadPath.trim() : null,
          lines: lines
            .filter((l) => l.inventory_item_id.trim())
            .map((l) => {
              const parsed = safeParseEurToCents(l.amount || "0");
              if (parsed === null || parsed <= 0) throw new Error("Beträge müssen > 0 sein");
              return { inventory_item_id: l.inventory_item_id.trim(), amount_cents: parsed };
            }),
        },
      });
    },
    onSuccess: async () => {
      setDescription("");
      setReceiptUploadPath("");
      setLines([]);
      await qc.invalidateQueries({ queryKey: ["cost-allocations"] });
      setMessage("Kosten verteilt.");
    },
  });

  const errors = [
    list.isError ? (list.error as Error) : null,
    create.isError ? (create.error as Error) : null,
  ].filter(Boolean) as Error[];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Kostenverteilung</div>
          <div className="page-subtitle">Zusätzliche Kosten anteilig auf Lagerartikel verteilen.</div>
        </div>
        <div className="page-actions">
          <Button variant="secondary" size="sm" onClick={() => list.refetch()} disabled={list.isFetching}>
            <RefreshCw size={16} /> Aktualisieren
          </Button>
        </div>
      </div>

      {message ? (
        <InlineAlert tone="info" onDismiss={() => setMessage(null)}>
          {message}
        </InlineAlert>
      ) : null}

      {errors.length ? <InlineAlert tone="error">{errors[0].message}</InlineAlert> : null}

      <div className="split" style={{ gridTemplateColumns: "1fr 520px" }}>
        <div className="panel">
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <input
              className="input"
              placeholder="Suche (Beschreibung, Datum, Betrag, …)"
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
            <div className="toolbar-spacer" />
            <Pagination
              page={paged.page}
              pageSize={paged.pageSize}
              total={paged.totalItems}
              onPageChange={(p) =>
                setParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.set("page", String(p));
                  return next;
                })
              }
            />
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>Datum</th>
                <th>Beschreibung</th>
                <th>Quelle</th>
                <th className="numeric">Betrag</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((a) => (
                <tr key={a.id}>
                  <td className="mono nowrap">{a.allocation_date}</td>
                  <td>{a.description}</td>
                  <td className="mono">{a.payment_source}</td>
                  <td className="numeric mono">{fmtEur(a.amount_cents)}</td>
                </tr>
              ))}
              {!paged.items.length ? (
                <tr>
                  <td colSpan={4} className="muted">
                    Keine Daten.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <div className="toolbar" style={{ justifyContent: "space-between" }}>
            <div>
              <div className="panel-title">Neu</div>
              <div className="panel-sub">Summe Linien = Betrag (wird validiert).</div>
            </div>
            <Button variant="primary" size="sm" onClick={() => create.mutate()} disabled={!canSubmit || create.isPending}>
              <Save size={16} /> {create.isPending ? "Speichere…" : "Speichern"}
            </Button>
          </div>

          <div className="stack" style={{ marginTop: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Datum">
                <input className="input" type="date" value={allocationDate} onChange={(e) => setAllocationDate(e.target.value)} />
              </Field>
              <Field label="Zahlungsquelle">
                <select className="input" value={paymentSource} onChange={(e) => setPaymentSource(e.target.value as PaymentSource)}>
                  {PAYMENT_SOURCE_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="Beschreibung">
              <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="z.B. Reinigung, Versand, Gebühren…" />
            </Field>

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
              <Field label="Vorsteuer abziehbar">
                <label className="checkbox" style={{ justifyContent: "flex-start", color: "var(--text)" }}>
                  <input type="checkbox" checked={inputTaxDeductible} onChange={(e) => setInputTaxDeductible(e.target.checked)} /> Ja
                </label>
              </Field>
            </div>

            <Field label="Beleg Upload (optional)">
              <div className="toolbar">
                <input className="input" value={receiptUploadPath} onChange={(e) => setReceiptUploadPath(e.target.value)} placeholder="uploads/…" />
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
                  Upload
                </label>
                {receiptUploadPath.trim() ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => api.download(receiptUploadPath.trim(), receiptUploadPath.trim().split("/").pop() ?? "beleg")}>
                    Öffnen
                  </Button>
                ) : null}
              </div>
            </Field>

            <div className="panel" style={{ padding: 12 }}>
              <div className="toolbar" style={{ justifyContent: "space-between" }}>
                <div className="panel-title" style={{ fontSize: 13 }}>
                  Linien
                </div>
                <div className={sumCents === null ? "badge badge--danger mono" : "badge badge--ok mono"}>
                  {sumCents === null ? "—" : fmtEur(sumCents)}
                </div>
              </div>
              <table className="table" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Inventory Item ID</th>
                    <th className="numeric">Betrag (EUR)</th>
                    <th className="numeric"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, idx) => (
                    <tr key={l.ui_id}>
                      <td>
                        <input
                          className="input mono"
                          value={l.inventory_item_id}
                          onChange={(e) => setLines((s) => s.map((x, i) => (i === idx ? { ...x, inventory_item_id: e.target.value } : x)))}
                          placeholder="UUID"
                        />
                      </td>
                      <td className="numeric">
                        <input
                          className="input"
                          style={{ textAlign: "right" }}
                          value={l.amount}
                          onChange={(e) => setLines((s) => s.map((x, i) => (i === idx ? { ...x, amount: e.target.value } : x)))}
                        />
                      </td>
                      <td className="numeric">
                        <Button type="button" size="sm" variant="ghost" onClick={() => setLines((s) => s.filter((x) => x.ui_id !== l.ui_id))}>
                          <Trash2 size={16} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {!lines.length ? (
                    <tr>
                      <td colSpan={3} className="muted">
                        Noch keine Linien.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              <div className="toolbar" style={{ marginTop: 10, justifyContent: "space-between" }}>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setLines((s) => [...s, { ui_id: newId(), inventory_item_id: "", amount: "0,00" }])}
                >
                  + Linie
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setLines([])} disabled={!lines.length}>
                  Reset
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

