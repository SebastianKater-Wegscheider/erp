import { Play, Plus, Save, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { InlineMessage } from "../components/ui/inline-message";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PageHeader } from "../components/ui/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { useApi } from "../lib/api";

type AgentPlatform = "KLEINANZEIGEN" | "EBAY_DE" | "WILLHABEN" | "EBAY_KLEINANZEIGEN";

type AgentQuery = {
  id: string;
  platform: AgentPlatform;
  keyword: string;
  enabled: boolean;
  max_pages: number;
  detail_enrichment_enabled: boolean;
  options_json?: unknown;
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
  queries: AgentQuery[];
};

type QueryDraft = {
  platform: AgentPlatform;
  keyword: string;
  enabled: boolean;
  max_pages: string;
  detail_enrichment_enabled: boolean;
  options_json_text: string;
};

type AgentDraft = {
  name: string;
  enabled: boolean;
  interval_hours: string;
  queries: QueryDraft[];
};

const PLATFORM_OPTIONS: AgentPlatform[] = ["KLEINANZEIGEN", "EBAY_DE", "WILLHABEN", "EBAY_KLEINANZEIGEN"];

function emptyQueryDraft(): QueryDraft {
  return {
    platform: "KLEINANZEIGEN",
    keyword: "",
    enabled: true,
    max_pages: "3",
    detail_enrichment_enabled: true,
    options_json_text: "{}",
  };
}

function emptyAgentDraft(): AgentDraft {
  return {
    name: "",
    enabled: true,
    interval_hours: "6",
    queries: [emptyQueryDraft()],
  };
}

function fmtDate(value?: string | null): string {
  if (!value) return "—";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleString("de-AT", { dateStyle: "short", timeStyle: "short" });
}

function agentToDraft(agent: Agent): AgentDraft {
  return {
    name: agent.name,
    enabled: agent.enabled,
    interval_hours: String(Math.max(1, Math.round(agent.interval_seconds / 3600))),
    queries:
      agent.queries.length > 0
        ? agent.queries.map((query) => ({
            platform: query.platform,
            keyword: query.keyword,
            enabled: query.enabled,
            max_pages: String(query.max_pages),
            detail_enrichment_enabled: query.detail_enrichment_enabled,
            options_json_text: JSON.stringify(query.options_json ?? {}, null, 2),
          }))
        : [emptyQueryDraft()],
  };
}

export function SourcingAgentsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentDraft>(emptyAgentDraft());

  const agentsQuery = useQuery({
    queryKey: ["sourcing-agents"],
    queryFn: () => api.request<Agent[]>("/sourcing/agents"),
  });

  const upsert = useMutation({
    mutationFn: async () => {
      const queries = draft.queries
        .map((query) => {
          const keyword = query.keyword.trim();
          if (!keyword) return null;
          const rawOptions = query.options_json_text.trim();
          let options_json: unknown = null;
          if (rawOptions) options_json = JSON.parse(rawOptions);
          return {
            platform: query.platform,
            keyword,
            enabled: query.enabled,
            max_pages: Math.max(1, Math.min(20, Number.parseInt(query.max_pages || "3", 10) || 3)),
            detail_enrichment_enabled: query.detail_enrichment_enabled,
            options_json,
          };
        })
        .filter((v): v is NonNullable<typeof v> => v !== null);

      const payload = {
        name: draft.name.trim(),
        enabled: draft.enabled,
        interval_seconds: Math.max(3600, (Number.parseInt(draft.interval_hours || "6", 10) || 6) * 3600),
        queries,
      };

      if (editingAgentId) {
        return api.request<Agent>(`/sourcing/agents/${editingAgentId}`, { method: "PATCH", json: payload });
      }
      return api.request<Agent>("/sourcing/agents", { method: "POST", json: payload });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sourcing-agents"] });
      setEditingAgentId(null);
      setDraft(emptyAgentDraft());
    },
  });

  const removeAgent = useMutation({
    mutationFn: (agentId: string) => api.request<void>(`/sourcing/agents/${agentId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sourcing-agents"] });
      if (editingAgentId) {
        setEditingAgentId(null);
        setDraft(emptyAgentDraft());
      }
    },
  });

  const runNow = useMutation({
    mutationFn: (agentId: string) => api.request(`/sourcing/agents/${agentId}/run`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sourcing-agents"] });
      await qc.invalidateQueries({ queryKey: ["sourcing-items"] });
      await qc.invalidateQueries({ queryKey: ["sourcing-health"] });
    },
  });

  const editingLabel = useMemo(() => {
    if (!editingAgentId) return "Neuen Agent anlegen";
    const agent = agentsQuery.data?.find((row) => row.id === editingAgentId);
    return agent ? `Agent bearbeiten: ${agent.name}` : "Agent bearbeiten";
  }, [editingAgentId, agentsQuery.data]);

  return (
    <div className="space-y-4">
      <PageHeader title="Search Agents" description="Plattform- und Keyword-Profile mit eigenem Intervall verwalten." />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>{editingLabel}</CardTitle>
          {editingAgentId ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setEditingAgentId(null);
                setDraft(emptyAgentDraft());
              }}
            >
              <X className="h-4 w-4" />
              Abbrechen
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Gamecube Radar" />
            </div>
            <div className="space-y-1">
              <Label>Intervall (Stunden)</Label>
              <Input value={draft.interval_hours} onChange={(e) => setDraft({ ...draft, interval_hours: e.target.value })} />
            </div>
            <div className="flex items-end gap-2 pb-1">
              <input
                id="agent-enabled"
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              />
              <Label htmlFor="agent-enabled">Enabled</Label>
            </div>
          </div>

          <div className="space-y-3">
            {draft.queries.map((query, idx) => (
              <div key={`q-${idx}`} className="rounded-md border border-[color:var(--app-border)] p-3 space-y-3">
                <div className="grid gap-3 md:grid-cols-5">
                  <div className="space-y-1">
                    <Label>Plattform</Label>
                    <Select
                      value={query.platform}
                      onValueChange={(value) => {
                        const next = [...draft.queries];
                        next[idx] = { ...query, platform: value as AgentPlatform };
                        setDraft({ ...draft, queries: next });
                      }}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PLATFORM_OPTIONS.map((platform) => (
                          <SelectItem key={platform} value={platform}>{platform}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1 md:col-span-2">
                    <Label>Keyword</Label>
                    <Input
                      value={query.keyword}
                      onChange={(e) => {
                        const next = [...draft.queries];
                        next[idx] = { ...query, keyword: e.target.value };
                        setDraft({ ...draft, queries: next });
                      }}
                      placeholder="gamecube"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Max pages</Label>
                    <Input
                      value={query.max_pages}
                      onChange={(e) => {
                        const next = [...draft.queries];
                        next[idx] = { ...query, max_pages: e.target.value };
                        setDraft({ ...draft, queries: next });
                      }}
                    />
                  </div>
                  <div className="flex items-end justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        const next = draft.queries.filter((_, qIdx) => qIdx !== idx);
                        setDraft({ ...draft, queries: next.length > 0 ? next : [emptyQueryDraft()] });
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                      Entfernen
                    </Button>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="flex items-center gap-2">
                    <input
                      id={`q-enabled-${idx}`}
                      type="checkbox"
                      checked={query.enabled}
                      onChange={(e) => {
                        const next = [...draft.queries];
                        next[idx] = { ...query, enabled: e.target.checked };
                        setDraft({ ...draft, queries: next });
                      }}
                    />
                    <Label htmlFor={`q-enabled-${idx}`}>Query enabled</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      id={`q-detail-${idx}`}
                      type="checkbox"
                      checked={query.detail_enrichment_enabled}
                      onChange={(e) => {
                        const next = [...draft.queries];
                        next[idx] = { ...query, detail_enrichment_enabled: e.target.checked };
                        setDraft({ ...draft, queries: next });
                      }}
                    />
                    <Label htmlFor={`q-detail-${idx}`}>Detail enrichment</Label>
                  </div>
                </div>

                <div className="space-y-1">
                  <Label>Options JSON (optional)</Label>
                  <textarea
                    className="min-h-[100px] w-full rounded-md border border-[color:var(--app-border)] bg-[color:var(--app-surface)] px-3 py-2 text-sm"
                    value={query.options_json_text}
                    onChange={(e) => {
                      const next = [...draft.queries];
                      next[idx] = { ...query, options_json_text: e.target.value };
                      setDraft({ ...draft, queries: next });
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDraft({ ...draft, queries: [...draft.queries, emptyQueryDraft()] })}
            >
              <Plus className="h-4 w-4" />
              Query hinzufügen
            </Button>
            <Button type="button" onClick={() => upsert.mutate()} disabled={upsert.isPending || !draft.name.trim()}>
              <Save className="h-4 w-4" />
              {editingAgentId ? "Agent speichern" : "Agent erstellen"}
            </Button>
          </div>

          {upsert.error ? <InlineMessage tone="error">{String((upsert.error as Error).message)}</InlineMessage> : null}
        </CardContent>
      </Card>

      {agentsQuery.isLoading ? <InlineMessage>Lade Agents…</InlineMessage> : null}
      {agentsQuery.error ? <InlineMessage tone="error">Agents konnten nicht geladen werden</InlineMessage> : null}

      <div className="grid gap-3 md:grid-cols-2">
        {(agentsQuery.data ?? []).map((agent) => (
          <Card key={agent.id}>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">{agent.name}</CardTitle>
                <Badge variant={agent.enabled ? "success" : "secondary"}>{agent.enabled ? "ENABLED" : "DISABLED"}</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div>Intervall: {(agent.interval_seconds / 3600).toFixed(1)} h</div>
              <div>Last run: {fmtDate(agent.last_run_at)}</div>
              <div>Next run: {fmtDate(agent.next_run_at)}</div>
              <div>Queries: {agent.queries.length}</div>
              {agent.last_error_type ? (
                <InlineMessage tone="error">
                  {agent.last_error_type}
                  {agent.last_error_message ? ` — ${agent.last_error_message}` : ""}
                </InlineMessage>
              ) : null}

              <div className="space-y-1">
                {agent.queries.map((query) => (
                  <div key={query.id} className="rounded border border-[color:var(--app-border)] px-2 py-1 text-xs">
                    {query.platform} • {query.keyword} • pages {query.max_pages} • {query.enabled ? "on" : "off"}
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setEditingAgentId(agent.id);
                    setDraft(agentToDraft(agent));
                  }}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => runNow.mutate(agent.id)}
                  disabled={runNow.isPending}
                >
                  <Play className="h-4 w-4" />
                  Jetzt ausführen
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => removeAgent.mutate(agent.id)}
                  disabled={removeAgent.isPending}
                >
                  <Trash2 className="h-4 w-4" />
                  Löschen
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
