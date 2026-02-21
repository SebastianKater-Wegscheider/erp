import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useApi } from "../../api/api";
import { formatDateTimeLocal } from "../../lib/dates";
import { Button } from "../../ui/Button";
import { InlineAlert } from "../../ui/InlineAlert";

type Platform = "KLEINANZEIGEN" | "WILLHABEN" | "EBAY_KLEINANZEIGEN" | "EBAY_DE";

type AgentQuery = {
  id: string;
  platform: Platform;
  keyword: string;
  enabled: boolean;
  max_pages: number;
  detail_enrichment_enabled: boolean;
  options_json?: any;
  created_at: string;
  updated_at: string;
};

type Agent = {
  id: string;
  name: string;
  enabled: boolean;
  interval_seconds: number;
  last_run_at?: string | null;
  next_run_at?: string | null;
  last_error_type?: string | null;
  last_error_message?: string | null;
  created_at: string;
  updated_at: string;
  queries: AgentQuery[];
};

type AgentCreateIn = {
  name: string;
  enabled: boolean;
  interval_seconds: number;
  queries: Array<{
    platform: Platform;
    keyword: string;
    enabled: boolean;
    max_pages: number;
    detail_enrichment_enabled: boolean;
    options_json?: any;
  }>;
};

type AgentPatchIn = Partial<AgentCreateIn>;

type AgentRunOut = {
  agent_id: string;
  run_started_at: string;
  results: Array<{
    agent_query_id: string;
    run_id: string;
    status: string;
    items_scraped: number;
    items_new: number;
    items_ready: number;
  }>;
};

const PLATFORM_OPTIONS: Array<{ value: Platform; label: string }> = [
  { value: "KLEINANZEIGEN", label: "Kleinanzeigen" },
  { value: "EBAY_DE", label: "eBay.de" },
  { value: "WILLHABEN", label: "willhaben" },
  { value: "EBAY_KLEINANZEIGEN", label: "eBay Kleinanzeigen (legacy)" },
];

function defaultAgentDraft(): AgentCreateIn {
  return {
    name: "Neuer Agent",
    enabled: true,
    interval_seconds: 6 * 60 * 60,
    queries: [
      {
        platform: "KLEINANZEIGEN",
        keyword: "gamecube",
        enabled: true,
        max_pages: 3,
        detail_enrichment_enabled: true,
      },
    ],
  };
}

export function SourcingAgentsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState<AgentCreateIn>(() => defaultAgentDraft());
  const [editDraft, setEditDraft] = useState<AgentCreateIn | null>(null);

  const q = useQuery({
    queryKey: ["sourcing-agents"],
    queryFn: () => api.request<Agent[]>("/sourcing/agents"),
  });

  const agents = q.data ?? [];
  const selected = useMemo(() => agents.find((a) => a.id === selectedId) ?? null, [agents, selectedId]);

  useEffect(() => {
    if (!selected) {
      setEditDraft(null);
      return;
    }
    setEditDraft({
      name: selected.name,
      enabled: selected.enabled,
      interval_seconds: selected.interval_seconds,
      queries: selected.queries.map((qRow) => ({
        platform: qRow.platform,
        keyword: qRow.keyword,
        enabled: qRow.enabled,
        max_pages: qRow.max_pages,
        detail_enrichment_enabled: qRow.detail_enrichment_enabled,
        options_json: qRow.options_json ?? null,
      })),
    });
  }, [selected?.id]);

  const createAgent = useMutation({
    mutationFn: (data: AgentCreateIn) => api.request<Agent>("/sourcing/agents", { method: "POST", json: data }),
    onSuccess: (a) => {
      setMessage("Agent erstellt.");
      setSelectedId(a.id);
      qc.invalidateQueries({ queryKey: ["sourcing-agents"] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Create fehlgeschlagen")),
  });

  const patchAgent = useMutation({
    mutationFn: (payload: { id: string; patch: AgentPatchIn }) =>
      api.request<Agent>(`/sourcing/agents/${encodeURIComponent(payload.id)}`, { method: "PATCH", json: payload.patch }),
    onSuccess: () => {
      setMessage("Gespeichert.");
      qc.invalidateQueries({ queryKey: ["sourcing-agents"] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Save fehlgeschlagen")),
  });

  const deleteAgent = useMutation({
    mutationFn: (id: string) => api.request<void>(`/sourcing/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      setSelectedId(null);
      setMessage("Agent gelöscht.");
      qc.invalidateQueries({ queryKey: ["sourcing-agents"] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Delete fehlgeschlagen")),
  });

  const runNow = useMutation({
    mutationFn: (id: string) => api.request<AgentRunOut>(`/sourcing/agents/${encodeURIComponent(id)}/run`, { method: "POST" }),
    onSuccess: (out) => {
      setMessage(`Run gestartet: ${out.run_started_at} (${out.results.length} Queries)`);
      qc.invalidateQueries({ queryKey: ["sourcing-agents"] });
    },
    onError: (e: any) => setMessage(String(e?.message ?? "Run fehlgeschlagen")),
  });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Sourcing Agents</div>
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
        </div>
      </div>

      {message ? (
        <InlineAlert tone={createAgent.isError || patchAgent.isError || deleteAgent.isError || runNow.isError ? "error" : "info"} onDismiss={() => setMessage(null)}>
          {message}
        </InlineAlert>
      ) : null}

      {q.isError ? <InlineAlert tone="error">Agents konnten nicht geladen werden.</InlineAlert> : null}

      <div className="split" data-mobile={selectedId ? "detail" : "list"}>
        <div className="panel">
          <div className="panel-title">Agent Liste</div>
          <div className="panel-sub">Klicke einen Agenten, um ihn zu bearbeiten.</div>

          <div style={{ marginTop: 10 }}>
            <Button
              variant="primary"
              size="sm"
              onClick={() => createAgent.mutate(createDraft)}
              disabled={createAgent.isPending}
            >
              <Plus size={16} /> Neuen Agent erstellen
            </Button>
          </div>

          <table className="table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th className="numeric hide-mobile">Interval</th>
                <th className="numeric hide-mobile">Next</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id} onClick={() => setSelectedId(a.id)} style={{ cursor: "pointer" }}>
                  <td>
                    <div style={{ fontWeight: 650 }}>{a.name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {a.queries.length} Queries
                      {a.last_error_message ? ` · Fehler: ${a.last_error_message}` : ""}
                    </div>
                  </td>
                  <td>
                    <span className={a.enabled ? "badge badge--ok" : "badge"}>{a.enabled ? "enabled" : "disabled"}</span>
                  </td>
                  <td className="numeric hide-mobile">{Math.round(a.interval_seconds / 3600)}h</td>
                  <td className="numeric muted hide-mobile">{formatDateTimeLocal(a.next_run_at ?? null)}</td>
                </tr>
              ))}
              {!agents.length && !q.isLoading ? (
                <tr>
                  <td colSpan={4} className="muted">
                    Keine Agents.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="panel">
          {selectedId ? (
            <div className="only-mobile" style={{ marginBottom: 8 }}>
              <Button variant="secondary" size="sm" onClick={() => setSelectedId(null)}>
                ← Zur Liste
              </Button>
            </div>
          ) : null}
          <div className="panel-title">Agent bearbeiten</div>
          <div className="panel-sub">{selected ? selected.id : "Wähle links einen Agenten aus."}</div>

          {selected ? (
            <div className="stack" style={{ marginTop: 10 }}>
              <div className="field">
                <div className="field-label">Name</div>
                <input
                  className="input"
                  value={editDraft?.name ?? ""}
                  onChange={(e) => setEditDraft((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
                />
              </div>

              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={editDraft?.enabled ?? false}
                  onChange={(e) => setEditDraft((prev) => (prev ? { ...prev, enabled: e.target.checked } : prev))}
                />
                Enabled
              </label>

              <div className="field">
                <div className="field-label">Interval (Sekunden, min 3600)</div>
                <input
                  className="input"
                  type="number"
                  value={editDraft?.interval_seconds ?? 0}
                  onChange={(e) => setEditDraft((prev) => (prev ? { ...prev, interval_seconds: Number(e.target.value) } : prev))}
                />
              </div>

              <div>
                <div className="panel-title">Queries</div>
                <div className="panel-sub">Platform + Keyword pro Query.</div>
              </div>

              {(editDraft?.queries ?? []).map((qRow, idx) => (
                <div key={`${qRow.platform}-${qRow.keyword}-${idx}`} className="card" style={{ boxShadow: "none" }}>
                  <div className="toolbar">
                    <select
                      className="input"
                      value={qRow.platform}
                      onChange={(e) =>
                        setEditDraft((prev) =>
                          prev
                            ? {
                                ...prev,
                                queries: prev.queries.map((q, i) => (i === idx ? { ...q, platform: e.target.value as Platform } : q)),
                              }
                            : prev,
                        )
                      }
                    >
                      {PLATFORM_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>

                    <input
                      className="input"
                      value={qRow.keyword}
                      onChange={(e) =>
                        setEditDraft((prev) =>
                          prev
                            ? {
                                ...prev,
                                queries: prev.queries.map((q, i) => (i === idx ? { ...q, keyword: e.target.value } : q)),
                              }
                            : prev,
                        )
                      }
                      placeholder="Keyword"
                    />
                  </div>

                  <div className="toolbar" style={{ marginTop: 8 }}>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={qRow.enabled}
                        onChange={(e) =>
                          setEditDraft((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  queries: prev.queries.map((q, i) => (i === idx ? { ...q, enabled: e.target.checked } : q)),
                                }
                              : prev,
                          )
                        }
                      />
                      enabled
                    </label>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={qRow.detail_enrichment_enabled}
                        onChange={(e) =>
                          setEditDraft((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  queries: prev.queries.map((q, i) =>
                                    i === idx ? { ...q, detail_enrichment_enabled: e.target.checked } : q,
                                  ),
                                }
                              : prev,
                          )
                        }
                      />
                      detail enrichment
                    </label>
                    <div className="toolbar-spacer" />
                    <input
                      className="input"
                      type="number"
                      value={qRow.max_pages}
                      onChange={(e) =>
                        setEditDraft((prev) =>
                          prev
                            ? {
                                ...prev,
                                queries: prev.queries.map((q, i) => (i === idx ? { ...q, max_pages: Number(e.target.value) } : q)),
                              }
                            : prev,
                        )
                      }
                      style={{ width: 140 }}
                      min={1}
                      max={20}
                    />
                  </div>
                </div>
              ))}

              <div className="toolbar">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setEditDraft((prev) =>
                      prev
                        ? {
                            ...prev,
                            queries: [
                              ...prev.queries,
                              {
                                platform: "KLEINANZEIGEN",
                                keyword: "",
                                enabled: true,
                                max_pages: 3,
                                detail_enrichment_enabled: true,
                                options_json: null,
                              },
                            ],
                          }
                        : prev,
                    )
                  }
                >
                  <Plus size={16} /> Query hinzufügen
                </Button>
                <div className="toolbar-spacer" />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => runNow.mutate(selected.id)}
                  disabled={runNow.isPending}
                >
                  Run now
                </Button>
              </div>

              <div className="toolbar">
                <Button
                  variant="primary"
                  onClick={() =>
                    patchAgent.mutate({
                      id: selected.id,
                      patch: {
                        name: editDraft?.name ?? selected.name,
                        enabled: editDraft?.enabled ?? selected.enabled,
                        interval_seconds: editDraft?.interval_seconds ?? selected.interval_seconds,
                        queries: (editDraft?.queries ?? selected.queries).map((q) => ({
                          platform: q.platform,
                          keyword: q.keyword,
                          enabled: q.enabled,
                          max_pages: q.max_pages,
                          detail_enrichment_enabled: q.detail_enrichment_enabled,
                          options_json: q.options_json ?? null,
                        })),
                      },
                    })
                  }
                  disabled={patchAgent.isPending}
                >
                  Speichern
                </Button>

                <Button
                  variant="secondary"
                  onClick={() => {
                    if (!window.confirm("Agent wirklich löschen?")) return;
                    deleteAgent.mutate(selected.id);
                  }}
                  disabled={deleteAgent.isPending}
                >
                  <Trash2 size={16} /> Löschen
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
