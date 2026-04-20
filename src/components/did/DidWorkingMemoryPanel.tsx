import { useState, useEffect, useCallback } from "react";
import { Brain, RefreshCw, Loader2, AlertTriangle, CheckCircle2, Clock, Database, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";

/**
 * Working Memory Slice 1 — Operationalization panel.
 *
 * Read-only inspect + manual bootstrap trigger.
 * Source of truth zůstává v evidence tabulkách + did_pending_drive_writes;
 * tento panel jen vizualizuje derived snapshot v karel_working_memory_snapshots.
 */

interface RoleScopeBreakdown {
  breakdown: Record<string, number>;
  total_messages_24h: number;
  avg_confidence: number | null;
  needs_review_count: number;
  origin_counts: Record<string, number>;
  last_partner_personal_at: string | null;
  ratio_therapeutic: number | null;
}

interface TherapistStateBlock {
  therapist: "hanka" | "kata";
  activity: {
    therapeutic_messages_24h: number;
    therapeutic_messages_7d: number;
    last_therapeutic_at: string | null;
    recentness: "active_today" | "active_week" | "stale" | "silent";
  };
  signal_quality: { score: number | null; rationale: string; sample_size: number };
  support_need: {
    level: "low" | "moderate" | "elevated" | "unknown";
    rationale: string;
    indicators: string[];
  };
  continuity: {
    score: number | null;
    open_tasks_direct: number;
    open_tasks_shared: number;
    completed_tasks_7d_direct: number;
    completed_tasks_7d_shared: number;
    rationale: string;
  };
  confidence: { overall: number; reasons: string[]; insufficient_data: boolean };
  source_counts: {
    observations: number;
    implications: number;
    tasks_direct: number;
    tasks_shared: number;
    therapeutic_messages: number;
    crises_owned: number;
  };
}

interface TherapistFoundation {
  version: string;
  generated_at: string;
  notice: string;
  hanka: TherapistStateBlock;
  kata: TherapistStateBlock;
  routing_guarantee: { excluded_scopes: string[]; excluded_sources: string[]; derived_only: true };
}

interface PartStateBlock {
  part_name: string;
  part_name_normalized: string;
  activity: {
    observations_24h: number;
    observations_7d: number;
    claims_7d: number;
    thread_messages_24h: number;
    thread_messages_7d: number;
    last_seen_at: string | null;
    recentness: "active_today" | "active_week" | "stale" | "silent";
  };
  stability_signal: {
    level: "stable" | "fluctuating" | "destabilizing" | "unknown";
    rationale: string;
    indicators: string[];
  };
  risk_signal: {
    level: "low" | "moderate" | "elevated" | "critical" | "unknown";
    rationale: string;
    indicators: string[];
    has_open_crisis: boolean;
    crisis_severity: string | null;
    crisis_phase: string | null;
  };
  continuity: {
    trajectory: "stable" | "changed" | "newly_active" | "recently_quiet" | "unknown";
    rationale: string;
    appeared_in_previous_snapshot: boolean | null;
  };
  care_priority: {
    level: "watch" | "support" | "active_care" | "crisis_focus" | "background";
    rationale: string;
  };
  confidence: { overall: number; reasons: string[]; insufficient_data: boolean };
  source_counts: { observations: number; claims: number; crisis_refs: number; thread_refs: number };
}

interface PartFoundation {
  version: string;
  generated_at: string;
  generated_from: { sources: string[]; excluded_sources: string[]; excluded_scopes: string[] };
  notice: string;
  parts: PartStateBlock[];
  summary: {
    total_parts: number;
    parts_with_open_crisis: number;
    parts_active_today: number;
    parts_silent: number;
    avg_confidence: number | null;
  };
}

interface SnapshotSummary {
  snapshot_key: string;
  generated_at: string;
  events_count: number;
  observations_24h: number;
  implications_24h: number;
  profile_claims_24h: number;
  crises_open: number;
  drive_queue: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    total: number;
  } | null;
  degraded_sources: string[];
  stale_sources: string[];
  role_scope_breakdown_24h?: RoleScopeBreakdown | null;
  therapist_state?: TherapistFoundation | null;
  part_state?: PartFoundation | null;
}

interface SnapshotRow {
  id: string;
  snapshot_key: string;
  snapshot_json: any;
  events_json: any[];
  sync_state_json: any;
  source_meta_json: any;
  generated_at: string;
  created_at: string;
  updated_at: string;
}

type Freshness = "fresh" | "stale" | "missing";

const FRESH_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h
const STALE_WINDOW_MS = 36 * 60 * 60 * 1000; // 36h

function computeFreshness(generatedAt: string | null | undefined): Freshness {
  if (!generatedAt) return "missing";
  const age = Date.now() - new Date(generatedAt).getTime();
  if (age < FRESH_WINDOW_MS) return "fresh";
  if (age < STALE_WINDOW_MS) return "stale";
  return "stale";
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return "právě teď";
  if (min < 60) return `${min} min zpět`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h zpět`;
  const d = Math.round(h / 24);
  return `${d} d zpět`;
}

export default function DidWorkingMemoryPanel() {
  const [summary, setSummary] = useState<SnapshotSummary | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const { data, error: fnError } = await supabase.functions.invoke(
        "karel-wm-inspect",
        { body: {}, headers },
      );
      if (fnError) throw fnError;
      if (data?.snapshot) {
        setSnapshot(data.snapshot as SnapshotRow);
        setSummary(data.summary as SnapshotSummary);
      } else {
        setSnapshot(null);
        setSummary(null);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const headers = await getAuthHeaders();
      const { data, error: fnError } = await supabase.functions.invoke(
        "karel-wm-bootstrap",
        { body: {}, headers },
      );
      if (fnError) throw fnError;
      toast.success("Pracovní paměť obnovena", {
        description: data?.summary
          ? `${data.summary.events_count ?? 0} událostí, ${data.summary.observations_24h ?? 0} obs/24h`
          : undefined,
      });
      await reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("Obnova selhala", { description: msg });
    } finally {
      setRefreshing(false);
    }
  }, [reload]);

  const freshness = computeFreshness(summary?.generated_at);

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-primary" />
          <div>
            <div className="text-sm font-medium">Pracovní paměť (Slice 1)</div>
            <div className="text-[10px] text-muted-foreground">
              Odvozená vrstva nad evidence + queue. Není source of truth.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <FreshnessBadge freshness={freshness} />
          <Button
            size="sm"
            variant="outline"
            onClick={handleRefresh}
            disabled={refreshing}
            className="h-7 text-xs"
          >
            {refreshing ? (
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3 mr-1" />
            )}
            Obnovit pracovní paměť
          </Button>
        </div>
      </div>

      {/* Body */}
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground p-4">
          <Loader2 className="w-3 h-3 animate-spin" /> Načítám snapshot…
        </div>
      ) : error ? (
        <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-xs">
          <AlertTriangle className="w-3 h-3 mt-0.5" />
          <div>
            <div className="font-medium">Chyba inspect endpointu</div>
            <div className="opacity-80">{error}</div>
          </div>
        </div>
      ) : !summary ? (
        <div className="flex items-start gap-2 p-3 rounded-md bg-muted text-xs">
          <Database className="w-3 h-3 mt-0.5" />
          <div>
            <div className="font-medium">Žádný snapshot</div>
            <div className="text-muted-foreground">
              Klikni na <span className="font-medium">Obnovit pracovní paměť</span>, ať se snapshot
              vyhydratuje z kanonických zdrojů.
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Meta row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
            <Stat label="Snapshot key" value={summary.snapshot_key} />
            <Stat label="Vygenerováno" value={formatRelative(summary.generated_at)} />
            <Stat label="Events" value={String(summary.events_count)} />
            <Stat label="Krize aktivní" value={String(summary.crises_open)} />
          </div>

          {/* Evidence 24h */}
          <div className="rounded-md border border-border/50 p-2 bg-muted/30">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              Evidence (24 h)
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <MiniStat label="Observations" value={summary.observations_24h} />
              <MiniStat label="Implications" value={summary.implications_24h} />
              <MiniStat label="Profile claims" value={summary.profile_claims_24h} />
            </div>
          </div>

          {/* Role scope breakdown (Hanička role separation) */}
          {summary.role_scope_breakdown_24h && summary.role_scope_breakdown_24h.total_messages_24h > 0 && (
            <div className="rounded-md border border-border/50 p-2 bg-muted/30">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                Role Scope (24 h)
              </div>
              <div className="grid grid-cols-5 gap-1 text-xs">
                <MiniStat label="Personal" value={summary.role_scope_breakdown_24h.breakdown.partner_personal ?? 0} />
                <MiniStat label="Team" value={summary.role_scope_breakdown_24h.breakdown.therapeutic_team ?? 0} />
                <MiniStat label="Mixed" value={summary.role_scope_breakdown_24h.breakdown.mixed ?? 0} />
                <MiniStat
                  label="Uncertain"
                  value={summary.role_scope_breakdown_24h.breakdown.uncertain ?? 0}
                  tone={summary.role_scope_breakdown_24h.breakdown.uncertain > 0 ? "danger" : "neutral"}
                />
                <MiniStat label="Celkem" value={summary.role_scope_breakdown_24h.total_messages_24h} />
              </div>
              <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                {summary.role_scope_breakdown_24h.ratio_therapeutic != null && (
                  <span>Therapeutic: {summary.role_scope_breakdown_24h.ratio_therapeutic}%</span>
                )}
                {summary.role_scope_breakdown_24h.avg_confidence != null && (
                  <span>Avg confidence: {summary.role_scope_breakdown_24h.avg_confidence}</span>
                )}
                {summary.role_scope_breakdown_24h.needs_review_count > 0 && (
                  <span className="text-amber-600">⚠ {summary.role_scope_breakdown_24h.needs_review_count} needs review</span>
                )}
              </div>
            </div>
          )}

          {/* Therapist Intelligence Foundation */}
          {summary.therapist_state && (
            <div className="rounded-md border border-border/50 p-2 bg-muted/30">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1 flex items-center justify-between">
                <span>Therapist State (Foundation {summary.therapist_state.version})</span>
                <span className="text-[9px] opacity-70">derived · 7d window</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <TherapistStateMini name="Hanička" state={summary.therapist_state.hanka} />
                <TherapistStateMini name="Káťa" state={summary.therapist_state.kata} />
              </div>
              <div className="text-[9px] text-muted-foreground mt-1 italic">
                Firewalled out: {summary.therapist_state.routing_guarantee.excluded_scopes.join(", ")}.
              </div>
            </div>
          )}

          {/* Part Intelligence Foundation */}
          {summary.part_state && (
            <div className="rounded-md border border-border/50 p-2 bg-muted/30">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1 flex items-center justify-between">
                <span>Part State (Foundation {summary.part_state.version})</span>
                <span className="text-[9px] opacity-70">derived · 7d window</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 text-xs mb-2">
                <MiniStat label="Parts" value={summary.part_state.summary.total_parts} />
                <MiniStat
                  label="V krizi"
                  value={summary.part_state.summary.parts_with_open_crisis}
                  tone={summary.part_state.summary.parts_with_open_crisis > 0 ? "danger" : "neutral"}
                />
                <MiniStat
                  label="Aktivní 24h"
                  value={summary.part_state.summary.parts_active_today}
                  tone="success"
                />
                <MiniStat label="Ticho" value={summary.part_state.summary.parts_silent} />
              </div>
              {summary.part_state.parts.length === 0 ? (
                <div className="text-[10px] text-muted-foreground italic px-1">
                  Žádné části s daty za 7 dní.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {summary.part_state.parts.map((p) => (
                    <PartStateMini key={p.part_name_normalized} part={p} />
                  ))}
                </div>
              )}
              <div className="text-[9px] text-muted-foreground mt-1 italic">
                Firewalled out: {summary.part_state.generated_from.excluded_scopes.join(", ")} · {summary.part_state.generated_from.excluded_sources.length} source(s).
              </div>
            </div>
          )}

          {/* Drive queue */}
          {summary.drive_queue && (
            <div className="rounded-md border border-border/50 p-2 bg-muted/30">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                Drive queue (24 h)
              </div>
              <div className="grid grid-cols-5 gap-1 text-xs">
                <MiniStat label="Pending" value={summary.drive_queue.pending} />
                <MiniStat label="Processing" value={summary.drive_queue.processing} />
                <MiniStat
                  label="Completed"
                  value={summary.drive_queue.completed}
                  tone="success"
                />
                <MiniStat
                  label="Failed"
                  value={summary.drive_queue.failed}
                  tone={summary.drive_queue.failed > 0 ? "danger" : "neutral"}
                />
                <MiniStat label="Celkem" value={summary.drive_queue.total} />
              </div>
            </div>
          )}

          {/* Source health */}
          {(summary.degraded_sources.length > 0 || summary.stale_sources.length > 0) && (
            <div className="rounded-md border border-border/50 p-2 bg-amber-500/5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> Zdroje vyžadují pozornost
              </div>
              {summary.degraded_sources.length > 0 && (
                <div className="text-[11px] mb-1">
                  <span className="text-muted-foreground">Degraded:</span>{" "}
                  {summary.degraded_sources.map((s) => (
                    <Badge key={s} variant="destructive" className="mr-1 text-[9px] px-1 py-0">
                      {s}
                    </Badge>
                  ))}
                </div>
              )}
              {summary.stale_sources.length > 0 && (
                <div className="text-[11px]">
                  <span className="text-muted-foreground">Stale:</span>{" "}
                  {summary.stale_sources.map((s) => (
                    <Badge key={s} variant="outline" className="mr-1 text-[9px] px-1 py-0">
                      {s}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Source audit list */}
          {Array.isArray(snapshot?.source_meta_json?.sources) && (
            <div className="rounded-md border border-border/50 p-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                Hydration audit
              </div>
              <ul className="space-y-1">
                {snapshot.source_meta_json.sources.map((s: any) => (
                  <li
                    key={s.source}
                    className="flex items-center justify-between text-[11px]"
                  >
                    <span className="flex items-center gap-1">
                      {s.ok ? (
                        <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                      ) : (
                        <AlertTriangle className="w-3 h-3 text-destructive" />
                      )}
                      <code className="text-[10px]">{s.source}</code>
                      {s.stale && (
                        <Badge variant="outline" className="text-[9px] px-1 py-0">
                          stale
                        </Badge>
                      )}
                    </span>
                    <span className="text-muted-foreground">
                      {typeof s.count === "number" ? `${s.count} rows · ` : ""}
                      {s.duration_ms} ms
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Raw toggle */}
          <div className="flex items-center justify-between">
            <div className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" /> Updated {formatRelative(snapshot?.updated_at)}
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowRaw((v) => !v)}
              className="h-6 text-[10px]"
            >
              {showRaw ? (
                <>
                  <EyeOff className="w-3 h-3 mr-1" /> Skrýt raw
                </>
              ) : (
                <>
                  <Eye className="w-3 h-3 mr-1" /> Zobrazit raw
                </>
              )}
            </Button>
          </div>
          {showRaw && snapshot && (
            <pre className="text-[9px] leading-tight p-2 rounded bg-muted overflow-auto max-h-72">
              {JSON.stringify(
                {
                  snapshot_json: snapshot.snapshot_json,
                  events_json: snapshot.events_json,
                  sync_state_json: snapshot.sync_state_json,
                  source_meta_json: snapshot.source_meta_json,
                },
                null,
                2,
              )}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function FreshnessBadge({ freshness }: { freshness: Freshness }) {
  if (freshness === "fresh") {
    return (
      <Badge variant="outline" className="text-[10px] border-emerald-600/40 text-emerald-700">
        <CheckCircle2 className="w-3 h-3 mr-1" /> Fresh
      </Badge>
    );
  }
  if (freshness === "stale") {
    return (
      <Badge variant="outline" className="text-[10px] border-amber-600/40 text-amber-700">
        <Clock className="w-3 h-3 mr-1" /> Stale
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] border-muted-foreground/40 text-muted-foreground">
      <Database className="w-3 h-3 mr-1" /> Missing
    </Badge>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border/50 p-2 bg-background">
      <div className="text-[9px] uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className="font-mono text-xs truncate">{value}</div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "success" | "danger";
}) {
  const toneClass =
    tone === "success"
      ? "text-emerald-700"
      : tone === "danger"
        ? "text-destructive"
        : "text-foreground";
  return (
    <div className="text-center">
      <div className={`font-mono text-sm ${toneClass}`}>{value}</div>
      <div className="text-[9px] text-muted-foreground uppercase tracking-wide">{label}</div>
    </div>
  );
}

function TherapistStateMini({
  name,
  state,
}: {
  name: string;
  state: TherapistStateBlock;
}) {
  const recentnessLabel: Record<string, string> = {
    active_today: "dnes",
    active_week: "tento týden",
    stale: "stagnuje",
    silent: "ticho",
  };
  const recentnessTone: Record<string, string> = {
    active_today: "text-emerald-700",
    active_week: "text-foreground",
    stale: "text-amber-700",
    silent: "text-muted-foreground",
  };
  const supportTone: Record<string, string> = {
    low: "text-emerald-700",
    moderate: "text-amber-700",
    elevated: "text-destructive",
    unknown: "text-muted-foreground",
  };
  const fmt = (n: number | null) => (n == null ? "—" : n.toFixed(2));

  return (
    <div className="rounded border border-border/50 p-2 bg-background space-y-1">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium">{name}</div>
        <span className={`text-[10px] ${recentnessTone[state.activity.recentness]}`}>
          {recentnessLabel[state.activity.recentness] ?? state.activity.recentness}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1 text-[10px]">
        <div>
          <span className="text-muted-foreground">Activity 24h/7d:</span>{" "}
          <span className="font-mono">
            {state.activity.therapeutic_messages_24h}/{state.activity.therapeutic_messages_7d}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Tasks (D+S):</span>{" "}
          <span className="font-mono">
            {state.continuity.open_tasks_direct}+{state.continuity.open_tasks_shared}/
            {state.continuity.completed_tasks_7d_direct}+{state.continuity.completed_tasks_7d_shared}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Signal q.:</span>{" "}
          <span className="font-mono">{fmt(state.signal_quality.score)}</span>{" "}
          <span className="opacity-60">(n={state.signal_quality.sample_size})</span>
        </div>
        <div>
          <span className="text-muted-foreground">Continuity:</span>{" "}
          <span className="font-mono">{fmt(state.continuity.score)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Support:</span>{" "}
          <span className={`font-mono ${supportTone[state.support_need.level]}`}>
            {state.support_need.level}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Confidence:</span>{" "}
          <span className="font-mono">{state.confidence.overall.toFixed(2)}</span>
          {state.confidence.insufficient_data && (
            <span className="ml-1 text-[9px] text-amber-700">⚠ málo dat</span>
          )}
        </div>
      </div>
      {state.support_need.indicators.length > 0 && (
        <div className="text-[9px] text-muted-foreground">
          Indicators: {state.support_need.indicators.join(" · ")}
        </div>
      )}
      <details className="text-[9px] text-muted-foreground">
        <summary className="cursor-pointer hover:text-foreground">rationale</summary>
        <div className="mt-1 pl-2 space-y-0.5 border-l border-border/40">
          <div><span className="opacity-70">signal:</span> {state.signal_quality.rationale}</div>
          <div><span className="opacity-70">support:</span> {state.support_need.rationale}</div>
          <div><span className="opacity-70">continuity:</span> {state.continuity.rationale}</div>
          <div><span className="opacity-70">confidence:</span> {state.confidence.reasons.join(" · ")}</div>
        </div>
      </details>
    </div>
  );
}

function PartStateMini({ part }: { part: PartStateBlock }) {
  const recentnessLabel: Record<string, string> = {
    active_today: "dnes",
    active_week: "tento týden",
    stale: "stagnuje",
    silent: "ticho",
  };
  const recentnessTone: Record<string, string> = {
    active_today: "text-emerald-700",
    active_week: "text-foreground",
    stale: "text-amber-700",
    silent: "text-muted-foreground",
  };
  const riskTone: Record<string, string> = {
    low: "text-emerald-700",
    moderate: "text-amber-700",
    elevated: "text-destructive",
    critical: "text-destructive font-semibold",
    unknown: "text-muted-foreground",
  };
  const stabilityTone: Record<string, string> = {
    stable: "text-emerald-700",
    fluctuating: "text-amber-700",
    destabilizing: "text-destructive",
    unknown: "text-muted-foreground",
  };
  const careTone: Record<string, string> = {
    crisis_focus: "text-destructive font-semibold",
    active_care: "text-destructive",
    support: "text-amber-700",
    watch: "text-foreground",
    background: "text-muted-foreground",
  };
  const trajectoryLabel: Record<string, string> = {
    stable: "stabilní",
    changed: "posun",
    newly_active: "nově aktivní",
    recently_quiet: "nedávno ztichl",
    unknown: "—",
  };

  return (
    <div className="rounded border border-border/50 p-2 bg-background space-y-1">
      <div className="flex items-center justify-between flex-wrap gap-1">
        <div className="text-xs font-medium">{part.part_name}</div>
        <div className="flex items-center gap-2 text-[10px]">
          <span className={recentnessTone[part.activity.recentness]}>
            {recentnessLabel[part.activity.recentness] ?? part.activity.recentness}
          </span>
          <span className={careTone[part.care_priority.level]}>
            {part.care_priority.level}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 text-[10px]">
        <div>
          <span className="text-muted-foreground">Obs 24h/7d:</span>{" "}
          <span className="font-mono">
            {part.activity.observations_24h}/{part.activity.observations_7d}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Msgs 24h/7d:</span>{" "}
          <span className="font-mono">
            {part.activity.thread_messages_24h}/{part.activity.thread_messages_7d}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Risk:</span>{" "}
          <span className={`font-mono ${riskTone[part.risk_signal.level]}`}>
            {part.risk_signal.level}
          </span>
          {part.risk_signal.has_open_crisis && (
            <span className="ml-1 text-[9px] text-destructive">⚠ krize</span>
          )}
        </div>
        <div>
          <span className="text-muted-foreground">Stability:</span>{" "}
          <span className={`font-mono ${stabilityTone[part.stability_signal.level]}`}>
            {part.stability_signal.level}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Continuity:</span>{" "}
          <span className="font-mono">{trajectoryLabel[part.continuity.trajectory]}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Confidence:</span>{" "}
          <span className="font-mono">{part.confidence.overall.toFixed(2)}</span>
          {part.confidence.insufficient_data && (
            <span className="ml-1 text-[9px] text-amber-700">⚠ málo dat</span>
          )}
        </div>
      </div>
      {(part.risk_signal.indicators.length > 0 || part.stability_signal.indicators.length > 0) && (
        <div className="text-[9px] text-muted-foreground">
          {part.risk_signal.indicators.length > 0 && (
            <span>Risk: {part.risk_signal.indicators.join(" · ")}</span>
          )}
          {part.stability_signal.indicators.length > 0 && (
            <span className="ml-2">Stab: {part.stability_signal.indicators.join(" · ")}</span>
          )}
        </div>
      )}
      <details className="text-[9px] text-muted-foreground">
        <summary className="cursor-pointer hover:text-foreground">rationale</summary>
        <div className="mt-1 pl-2 space-y-0.5 border-l border-border/40">
          <div><span className="opacity-70">risk:</span> {part.risk_signal.rationale}</div>
          <div><span className="opacity-70">stability:</span> {part.stability_signal.rationale}</div>
          <div><span className="opacity-70">continuity:</span> {part.continuity.rationale}</div>
          <div><span className="opacity-70">care:</span> {part.care_priority.rationale}</div>
          <div><span className="opacity-70">confidence:</span> {part.confidence.reasons.join(" · ")}</div>
          <div className="opacity-70">
            sources: obs={part.source_counts.observations} · claims={part.source_counts.claims} · crisis={part.source_counts.crisis_refs} · threads={part.source_counts.thread_refs}
          </div>
        </div>
      </details>
    </div>
  );
}
