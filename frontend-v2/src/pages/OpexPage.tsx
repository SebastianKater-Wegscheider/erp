import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useApi } from "../api/api";
import { fmtEur, parseEurToCents } from "../lib/money";
import { paginateItems } from "../lib/pagination";
import { useTaxProfile } from "../lib/taxProfile";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { InlineAlert } from "../ui/InlineAlert";
import { Pagination } from "../ui/Pagination";

type PaymentSource = "CASH" | "BANK" | "PRIVATE_EQUITY";

type OpexOut = {
  id: string;
  expense_date: string;
  recipient: string;
  category: string;
  amount_cents: number;
  amount_net_cents: number;
  amount_tax_cents: number;
  tax_rate_bp: number;
  input_tax_deductible: boolean;
  payment_source: PaymentSource;
  receipt_upload_path?: string | null;
  created_at: string;
  updated_at: string;
};

const CATEGORY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "PACKAGING", label: "Verpackung" },
  { value: "POSTAGE", label: "Porto" },
  { value: "SOFTWARE", label: "Software" },
  { value: "OFFICE", label: "Büro" },
  { value: "CONSULTING", label: "Beratung" },
  { value: "FEES", label: "Gebühren" },
  { value: "OTHER", label: "Sonstiges" },
];

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

function optionLabel(options: Array<{ value: string; label: string }>, value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

function safeParseEurToCents(input: string): number | null {
  try {
    return parseEurToCents(input);
  } catch {
    return null;
  }
}

export function OpexPage() {
  const api = useApi();
  const qc = useQueryClient();
  const taxProfile = useTaxProfile();
  const vatEnabled = taxProfile.data?.vat_enabled ?? true;
  const [params, setParams] = useSearchParams();
  const [message, setMessage] = useState<string | null>(null);

  const search = params.get("q") ?? "";
  const page = Number(params.get("page") ?? "1") || 1;

  const list = useQuery({
    queryKey: ["opex"],
    queryFn: () => api.request<OpexOut[]>("/opex"),
  });

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const all = list.data ?? [];
    if (!needle) return all;
    return all.filter((e) => {
      const hay = `${e.expense_date} ${e.recipient} ${e.category} ${e.payment_source} ${e.receipt_upload_path ?? ""}`.toLowerCase();
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

  const [expenseDate, setExpenseDate] = useState(todayIsoLocal());
  const [recipient, setRecipient] = useState("");
  const [category, setCategory] = useState("PACKAGING");
  const [amount, setAmount] = useState("0,00");
  const [taxRateBp, setTaxRateBp] = useState("2000");
  const [inputTaxDeductible, setInputTaxDeductible] = useState(true);
  const [paymentSource, setPaymentSource] = useState<PaymentSource>("CASH");
  const [receiptUploadPath, setReceiptUploadPath] = useState("");

  const canSubmit =
    /^\d{4}-\d{2}-\d{2}$/.test(expenseDate) &&
    recipient.trim().length > 0 &&
    safeParseEurToCents(amount) !== null;

  const create = useMutation({
    mutationFn: async () => {
      const parsed = safeParseEurToCents(amount);
      if (parsed === null) throw new Error("Ungültiger Betrag");
      return api.request<OpexOut>("/opex", {
        method: "POST",
        json: {
          expense_date: expenseDate,
          recipient: recipient.trim(),
          category,
          amount_cents: parsed,
          tax_rate_bp: vatEnabled ? Number(taxRateBp) : 0,
          input_tax_deductible: inputTaxDeductible,
          payment_source: paymentSource,
          receipt_upload_path: receiptUploadPath.trim() ? receiptUploadPath.trim() : null,
        },
      });
    },
    onSuccess: async () => {
      setRecipient("");
      setAmount("0,00");
      setReceiptUploadPath("");
      await qc.invalidateQueries({ queryKey: ["opex"] });
      setMessage("Ausgabe erfasst.");
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
          <div className="page-title">Betriebsausgaben</div>
          <div className="page-subtitle">Ausgaben erfassen, Belege ablegen und steuerlich auswerten.</div>
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
              placeholder="Suche (Empfänger, Kategorie, Zahlungsquelle, …)"
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
                <th>Ausgabe</th>
                <th className="numeric">Betrag</th>
                <th className="numeric">Beleg</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((e) => (
                <tr key={e.id}>
                  <td className="mono nowrap">{e.expense_date}</td>
                  <td>
                    <div style={{ fontWeight: 650 }}>{e.recipient}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {optionLabel(CATEGORY_OPTIONS, e.category)} · {e.payment_source}
                      {e.receipt_upload_path ? ` · ${e.receipt_upload_path.split("/").pop()}` : ""}
                    </div>
                  </td>
                  <td className="numeric mono">{fmtEur(e.amount_cents)}</td>
                  <td className="numeric">
                    {e.receipt_upload_path ? (
                      <Button type="button" size="sm" variant="secondary" onClick={() => api.download(e.receipt_upload_path!, e.receipt_upload_path!.split("/").pop() ?? "beleg")}>
                        Öffnen
                      </Button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
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
              <div className="panel-sub">Beleg kann optional hochgeladen werden.</div>
            </div>
            <Button variant="primary" size="sm" onClick={() => create.mutate()} disabled={!canSubmit || create.isPending}>
              <Save size={16} /> {create.isPending ? "Speichere…" : "Speichern"}
            </Button>
          </div>

          <div className="stack" style={{ marginTop: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Datum">
                <input className="input" type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
              </Field>
              <Field label="Kategorie">
                <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
                  {CATEGORY_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="Empfänger">
              <input className="input" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="z.B. DHL, Amazon, …" />
            </Field>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Betrag (EUR)">
                <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />
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
          </div>
        </div>
      </div>
    </div>
  );
}

