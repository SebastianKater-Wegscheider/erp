import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Save } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useApi } from "../../api/api";
import { formatDateTimeLocal } from "../../lib/dates";
import { Button } from "../../ui/Button";
import { InlineAlert } from "../../ui/InlineAlert";

type Setting = {
  key: string;
  value_int?: number | null;
  value_text?: string | null;
  value_json?: any;
  description?: string | null;
  updated_at: string;
};

type UpdatePayload = {
  values: Record<string, { value_int?: number | null; value_text?: string | null; value_json?: any }>;
};

function settingValueToString(s: Setting): { kind: "int" | "text" | "json" | "empty"; value: string } {
  if (typeof s.value_int === "number") return { kind: "int", value: String(s.value_int) };
  if (typeof s.value_text === "string" && s.value_text.trim()) return { kind: "text", value: s.value_text };
  if (s.value_json !== null && s.value_json !== undefined) {
    try {
      return { kind: "json", value: JSON.stringify(s.value_json, null, 2) };
    } catch {
      return { kind: "json", value: String(s.value_json) };
    }
  }
  return { kind: "empty", value: "" };
}

export function SourcingSettingsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, { kind: "int" | "text" | "json"; value: string }>>({});
  const [message, setMessage] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["sourcing-settings"],
    queryFn: () => api.request<Setting[]>("/sourcing/settings"),
  });

  const rows = q.data ?? [];
  const dirty = useMemo(() => Object.keys(draft).length > 0, [draft]);

  const save = useMutation({
    mutationFn: async () => {
      const values: UpdatePayload["values"] = {};
      for (const [key, entry] of Object.entries(draft)) {
        if (entry.kind === "int") {
          const n = Number(entry.value.trim());
          if (!Number.isFinite(n)) throw new Error(`Ungültige Zahl für ${key}`);
          values[key] = { value_int: Math.trunc(n), value_text: null, value_json: null };
        } else if (entry.kind === "text") {
          values[key] = { value_text: entry.value, value_int: null, value_json: null };
        } else {
          const raw = entry.value.trim();
          values[key] = { value_json: raw ? JSON.parse(raw) : null, value_int: null, value_text: null };
        }
      }
      return api.request<Setting[]>("/sourcing/settings", { method: "PUT", json: { values } });
    },
    onSuccess: () => {
      setDraft({});
      setMessage("Gespeichert.");
      qc.invalidateQueries({ queryKey: ["sourcing-settings"] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Speichern fehlgeschlagen")),
  });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Sourcing Einstellungen</div>
          <div className="page-subtitle">
            <Link className="link" to="/sourcing">
              ← Zurück
            </Link>
          </div>
        </div>
        <div className="page-actions">
          <Button variant="secondary" size="sm" onClick={() => q.refetch()}>
            <RefreshCw size={16} /> Aktualisieren
          </Button>
          <Button variant="primary" size="sm" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            <Save size={16} /> Speichern
          </Button>
        </div>
      </div>

      {message ? (
        <InlineAlert tone={save.isError ? "error" : "info"} onDismiss={() => setMessage(null)}>
          {message}
        </InlineAlert>
      ) : null}

      {q.isError ? <InlineAlert tone="error">Settings konnten nicht geladen werden.</InlineAlert> : null}

      <div className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Beschreibung</th>
              <th>Wert</th>
              <th className="numeric">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const base = settingValueToString(s);
              const entry = draft[s.key] ?? (base.kind === "empty" ? null : { kind: base.kind as any, value: base.value });
              const kind: any = entry?.kind ?? (base.kind === "empty" ? "text" : base.kind);
              const value = entry?.value ?? base.value;

              return (
                <tr key={s.key}>
                  <td className="mono">{s.key}</td>
                  <td className="muted">{s.description ?? "—"}</td>
                  <td>
                    <div className="toolbar">
                      <select
                        className="input"
                        value={kind}
                        onChange={(e) => {
                          const nextKind = e.target.value as "int" | "text" | "json";
                          setDraft((prev) => ({ ...prev, [s.key]: { kind: nextKind, value: value } }));
                        }}
                      >
                        <option value="int">int</option>
                        <option value="text">text</option>
                        <option value="json">json</option>
                      </select>
                      {kind === "json" ? (
                        <textarea
                          className="input"
                          value={value}
                          onChange={(e) => setDraft((prev) => ({ ...prev, [s.key]: { kind, value: e.target.value } }))}
                          rows={4}
                          style={{ width: "100%", minHeight: 90 }}
                        />
                      ) : (
                        <input
                          className="input"
                          value={value}
                          onChange={(e) => setDraft((prev) => ({ ...prev, [s.key]: { kind, value: e.target.value } }))}
                          inputMode={kind === "int" ? "numeric" : undefined}
                        />
                      )}
                    </div>
                  </td>
                  <td className="numeric muted">{formatDateTimeLocal(s.updated_at)}</td>
                </tr>
              );
            })}
            {!rows.length && !q.isLoading ? (
              <tr>
                <td colSpan={4} className="muted">
                  Keine Settings.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

