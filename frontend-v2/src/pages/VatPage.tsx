import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { useApi } from "../api/api";
import { fmtEur } from "../lib/money";
import { useTaxProfile } from "../lib/taxProfile";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { InlineAlert } from "../ui/InlineAlert";

type VatReportOut = {
  period_start: string;
  period_end: string;
  output_vat_regular_cents: number;
  output_vat_margin_cents: number;
  output_vat_adjustments_regular_cents: number;
  output_vat_adjustments_margin_cents: number;
  input_vat_cents: number;
  vat_payable_cents: number;
};

export function VatPage() {
  const api = useApi();
  const taxProfile = useTaxProfile();
  const vatEnabled = taxProfile.data?.vat_enabled ?? true;
  const today = useMemo(() => new Date(), []);
  const [yearInput, setYearInput] = useState(String(today.getFullYear()));
  const [monthInput, setMonthInput] = useState(String(today.getMonth() + 1).padStart(2, "0"));
  const [year, setYear] = useState<number>(today.getFullYear());
  const [month, setMonth] = useState<number>(today.getMonth() + 1);

  const q = useQuery({
    queryKey: ["vat-report", year, month],
    queryFn: () =>
      api.request<VatReportOut>("/reports/vat", {
        method: "POST",
        json: { year, month },
      }),
  });

  const parsedYear = Number(yearInput);
  const parsedMonth = Number(monthInput);
  const periodValid =
    Number.isInteger(parsedYear) &&
    Number.isInteger(parsedMonth) &&
    parsedYear >= 1900 &&
    parsedYear <= 2100 &&
    parsedMonth >= 1 &&
    parsedMonth <= 12;

  function applyPeriod() {
    if (!periodValid) return;
    const changed = parsedYear !== year || parsedMonth !== month;
    setYear(parsedYear);
    setMonth(parsedMonth);
    if (!changed) void q.refetch();
  }

  const data = q.data;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Umsatzsteuer</div>
          <div className="page-subtitle">Monatsauswertung für Regelbesteuerung und Differenzbesteuerung.</div>
        </div>
        <div className="page-actions">
          <Button variant="primary" size="sm" onClick={applyPeriod} disabled={!periodValid || q.isFetching}>
            <RefreshCw size={16} /> Berechnen
          </Button>
        </div>
      </div>

      {q.isError ? <InlineAlert tone="error">{(q.error as Error).message}</InlineAlert> : null}

      <div className="split" style={{ gridTemplateColumns: "1fr 520px" }}>
        <div className="panel">
          <div className="panel-title">Zeitraum</div>
          <div className="panel-sub">{data ? `${data.period_start} → ${data.period_end}` : "Wähle Jahr und Monat."}</div>

          <div className="stack" style={{ marginTop: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Jahr">
                <input className="input" inputMode="numeric" value={yearInput} onChange={(e) => setYearInput(e.target.value)} placeholder="YYYY" />
              </Field>
              <Field label="Monat">
                <input className="input" inputMode="numeric" value={monthInput} onChange={(e) => setMonthInput(e.target.value)} placeholder="1-12" />
              </Field>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {periodValid ? (
                <span>
                  Aktiv: {String(month).padStart(2, "0")}.{year}
                </span>
              ) : (
                <span style={{ color: "var(--danger)" }}>Ungültiger Zeitraum</span>
              )}
            </div>

            {!vatEnabled ? (
              <InlineAlert tone="info">
                Kleinunternehmerregelung aktiv. Umsatzsteuer/Vorsteuer wird aktuell nicht berechnet.
                {taxProfile.data?.small_business_notice ? (
                  <div style={{ marginTop: 6 }}>{taxProfile.data.small_business_notice}</div>
                ) : null}
              </InlineAlert>
            ) : null}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Ergebnis</div>
          <div className="panel-sub">Werte in EUR.</div>

          {vatEnabled ? (
            <div className="stack" style={{ marginTop: 12 }}>
              <div className="kv">
                <div className="k">USt (Regel)</div>
                <div className="v mono">
                  {data
                    ? fmtEur(data.output_vat_regular_cents - data.output_vat_adjustments_regular_cents)
                    : "—"}
                </div>
                <div className="k">USt (Differenz)</div>
                <div className="v mono">
                  {data
                    ? fmtEur(data.output_vat_margin_cents - data.output_vat_adjustments_margin_cents)
                    : "—"}
                </div>
                <div className="k">Vorsteuer</div>
                <div className="v mono">{data ? fmtEur(data.input_vat_cents) : "—"}</div>
                <div className="k">Zahllast</div>
                <div className="v mono">{data ? fmtEur(data.vat_payable_cents) : "—"}</div>
              </div>
            </div>
          ) : (
            <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
              VAT deaktiviert.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

