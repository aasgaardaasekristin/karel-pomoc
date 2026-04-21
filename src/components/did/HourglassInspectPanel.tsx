/**
 * HourglassInspectPanel — observability panel pro Hourglass (Spižírna A + B).
 *
 * Volá `karel-hourglass-inspect` (read-only). Zobrazí:
 *   - Pantry B counts (total / unprocessed / processed / blocked / retryable / expired)
 *   - Last flush attempt + last processed
 *   - Routing breakdown za 24h (tasks / questions / implications)
 *   - Blocked samples (důvod, entry_kind, last_attempt_at)
 *   - Pantry A summary (canonical present, WM present, slot counts,
 *     důkaz oddělenosti hana_personal vs hana_therapeutic vs kata_therapeutic)
 *   - Health verdict + warning, pokud blocked nebo retryable > 0
 *
 * Žádný write. Žádný side-effect. Pouze inspect.
 */

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Activity,
  Database,
  Hourglass,
} from "lucide-react";

interface BlockedSample {
  id: string;
  entry_kind: string;
  reason: string;
  last_attempt_at: string | null;
}

interface PantryBSnapshot {
  total: number;
  unprocessed: number;
  processed: number;
  expired: number;
  blocked: number;
  retryable: number;
  never_attempted: number;
  blocked_by_implications: number;
  last_flush_attempt_at: string | null;
  last_processed_at: string | null;
  last_created_at: string | null;
  routed_24h: { tasks: number; questions: number; implications: number };
  blocked_samples: BlockedSample[];
}

interface PantryASlotSummary {
  hana_personal: {
    present: boolean;
    personal_thread_count_24h: number;
    last_personal_thread_at: string | null;
    recent_personal_signals_count: number;
  };
  hana_therapeutic: {
    present: boolean;
    caseload_focus_count: number;
    countertransference_bonds_count: number;
    open_supervision_questions: number;
    last_therapeutic_thread_at: string | null;
  };
  kata_therapeutic: {
    present: boolean;
    caseload_focus_count: number;
    countertransference_bonds_count: number;
    open_supervision_questions: number;
    last_observed_at: string | null;
  };
  slots_isolated: boolean;
}

interface PantryASnapshot {
  schema_version: number;
  composed_at: string;
  prague_date: string;
  sources: {
    canonical_present: boolean;
    canonical_generated_at: string | null;
    canonical_source: string | null;
    wm_present: boolean;
    wm_generated_at: string | null;
  };
  counts: {
    canonical_crises: number;
    canonical_today_session_present: boolean;
    canonical_queue_primary: number;
    canonical_queue_adjunct: number;
    parts_status: number;
    therapists_status: number;
    yesterday_session_results: number;
    open_followups: number;
    today_priorities: number;
    today_therapy_plan: number;
  };
  slots: PantryASlotSummary;
  briefing_present: boolean;
  briefing_is_stale: boolean | null;
}

interface InspectResponse {
  ok: boolean;
  generated_at: string;
  pantry_b: PantryBSnapshot;
  pantry_a: PantryASnapshot | null;
  pantry_a_error: string | null;
  verdict: {
    pantry_b_healthy: boolean;
    has_blocked_entries: boolean;
    has_retryable_entries: boolean;
    has_unattempted_entries: boolean;
    expired_present: boolean;
    pantry_a_loaded: boolean;
  };
}

interface Props {
  refreshTrigger?: number;
}

const fmtTime = (iso: string | null): string => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("cs", {
      day: "numeric",
      month: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
};

const HourglassInspectPanel = ({ refreshTrigger = 0 }: Props) => {
  const [data, setData] = useState<InspectResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: res, error: invokeErr } = await supabase.functions.invoke(
        "karel-hourglass-inspect",
        { body: {} },
      );
      if (invokeErr) throw invokeErr;
      if (!res?.ok) throw new Error("inspect_failed");
      setData(res as InspectResponse);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshTrigger]);

  if (loading && !data) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
        Inspect selhal: {error}
        <Button
          variant="outline"
          size="sm"
          className="mt-2 h-6 px-2 text-[10px]"
          onClick={load}
        >
          <RefreshCw className="w-3 h-3 mr-1" />
          Zkusit znovu
        </Button>
      </div>
    );
  }

  if (!data) return null;

  const { pantry_b: b, pantry_a: a, verdict } = data;
  const showWarning =
    verdict.has_blocked_entries || verdict.has_retryable_entries;

  return (
    <div className="space-y-3">
      {/* ── Header + reload ── */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium flex items-center gap-1.5">
          <Hourglass className="w-3.5 h-3.5 text-primary" />
          Hourglass inspect
        </h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={load}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
        </Button>
      </div>

      {/* ── Warning banner ── */}
      {showWarning && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <div className="font-medium text-amber-800">
              Spižírna B má {b.blocked + b.retryable} entry, které se nepropsaly.
            </div>
            <div className="text-amber-700/80">
              {b.blocked > 0 && <>Blocked: {b.blocked}. </>}
              {b.retryable > 0 && <>Retryable: {b.retryable}. </>}
              {b.blocked_by_implications > 0 && (
                <>
                  Z toho {b.blocked_by_implications} čeká na napojení
                  observation pipeline (did_implications).
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {!showWarning && verdict.pantry_b_healthy && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2 text-[11px] flex items-center gap-2 text-emerald-800">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
          Spižírna B čistá: žádné blocked/retryable entry.
        </div>
      )}

      {/* ── Pantry B counts ── */}
      <div className="rounded-lg border border-border/60 bg-card/40 p-3 space-y-2">
        <div className="text-[11px] font-medium flex items-center gap-1.5">
          <Database className="w-3 h-3 text-muted-foreground" />
          Spižírna B (karel_pantry_b_entries)
        </div>
        <div className="grid grid-cols-3 gap-1.5 text-[10px]">
          <Stat label="Celkem" value={b.total} />
          <Stat label="Nezpracováno" value={b.unprocessed} />
          <Stat label="Zpracováno" value={b.processed} />
          <Stat
            label="Blocked"
            value={b.blocked}
            tone={b.blocked > 0 ? "warn" : "ok"}
          />
          <Stat
            label="Retryable"
            value={b.retryable}
            tone={b.retryable > 0 ? "warn" : "ok"}
          />
          <Stat label="Vypršelo" value={b.expired} />
          <Stat label="Nezkoušeno" value={b.never_attempted} />
          <Stat
            label="Blocked impl."
            value={b.blocked_by_implications}
            tone={b.blocked_by_implications > 0 ? "warn" : "ok"}
          />
          <Stat label="—" value="" />
        </div>
        <div className="grid grid-cols-2 gap-1.5 text-[10px] pt-1.5 border-t border-border/40">
          <div>
            <span className="text-muted-foreground">Poslední pokus: </span>
            <span className="font-medium">{fmtTime(b.last_flush_attempt_at)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Poslední propsáno: </span>
            <span className="font-medium">{fmtTime(b.last_processed_at)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Poslední vytvořeno: </span>
            <span className="font-medium">{fmtTime(b.last_created_at)}</span>
          </div>
        </div>
        <div className="text-[10px] pt-1.5 border-t border-border/40">
          <div className="text-muted-foreground mb-1">Routing 24h:</div>
          <div className="flex gap-2 flex-wrap">
            <Badge className="text-[9px] h-4 px-1.5 bg-emerald-500/15 text-emerald-700 border-emerald-500/30">
              tasks: {b.routed_24h.tasks}
            </Badge>
            <Badge className="text-[9px] h-4 px-1.5 bg-emerald-500/15 text-emerald-700 border-emerald-500/30">
              questions: {b.routed_24h.questions}
            </Badge>
            <Badge className="text-[9px] h-4 px-1.5 bg-muted text-muted-foreground border-border/40">
              implications: {b.routed_24h.implications}
            </Badge>
          </div>
        </div>
      </div>

      {/* ── Blocked samples ── */}
      {b.blocked_samples.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-50/30 p-2.5 space-y-1.5">
          <div className="text-[10px] font-medium text-amber-800 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            Blocked sample (max 5)
          </div>
          {b.blocked_samples.map((s) => (
            <div
              key={s.id}
              className="text-[10px] grid grid-cols-[auto,1fr] gap-x-2 gap-y-0.5"
            >
              <span className="text-muted-foreground">kind:</span>
              <span className="font-medium">{s.entry_kind}</span>
              <span className="text-muted-foreground">reason:</span>
              <span className="font-mono text-[9px] break-all">{s.reason}</span>
              <span className="text-muted-foreground">last:</span>
              <span>{fmtTime(s.last_attempt_at)}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Pantry A summary ── */}
      <div className="rounded-lg border border-border/60 bg-card/40 p-3 space-y-2">
        <div className="text-[11px] font-medium flex items-center gap-1.5">
          <Activity className="w-3 h-3 text-muted-foreground" />
          Spižírna A (composed view)
        </div>
        {!a && (
          <div className="text-[10px] text-destructive">
            Pantry A nepřítomna: {data.pantry_a_error ?? "unknown"}
          </div>
        )}
        {a && (
          <>
            <div className="grid grid-cols-2 gap-1.5 text-[10px]">
              <Stat
                label="Canonical"
                value={a.sources.canonical_present ? "ano" : "—"}
                tone={a.sources.canonical_present ? "ok" : "warn"}
              />
              <Stat
                label="WM snapshot"
                value={a.sources.wm_present ? "ano" : "—"}
                tone={a.sources.wm_present ? "ok" : "warn"}
              />
              <Stat label="Crisis items" value={a.counts.canonical_crises} />
              <Stat label="Follow-upy" value={a.counts.open_followups} />
              <Stat label="Priorities" value={a.counts.today_priorities} />
              <Stat
                label="Therapy plan"
                value={a.counts.today_therapy_plan}
              />
              <Stat label="Parts" value={a.counts.parts_status} />
              <Stat label="Therapists" value={a.counts.therapists_status} />
            </div>

            <div className="text-[10px] pt-1.5 border-t border-border/40 space-y-1">
              <div className="text-muted-foreground">
                Slot isolation (Hana osobně ≠ Hana terapeuticky ≠ Káťa):
              </div>
              <div className="grid grid-cols-3 gap-1">
                <SlotBadge
                  label="hana_personal"
                  present={a.slots.hana_personal.present}
                  detail={`${a.slots.hana_personal.personal_thread_count_24h} 24h`}
                />
                <SlotBadge
                  label="hana_therapeutic"
                  present={a.slots.hana_therapeutic.present}
                  detail={`${a.slots.hana_therapeutic.caseload_focus_count} focus`}
                />
                <SlotBadge
                  label="kata_therapeutic"
                  present={a.slots.kata_therapeutic.present}
                  detail={`${a.slots.kata_therapeutic.caseload_focus_count} focus`}
                />
              </div>
              {a.slots.slots_isolated && (
                <div className="text-[9px] text-emerald-700 flex items-center gap-1">
                  <CheckCircle2 className="w-2.5 h-2.5" />
                  Sloty jsou typed-distinct (nikoli jeden blob).
                </div>
              )}
            </div>

            <div className="text-[9px] text-muted-foreground pt-1.5 border-t border-border/40">
              Composed: {fmtTime(a.composed_at)} · prague_date:{" "}
              {a.prague_date}
              {a.briefing_present && (
                <>
                  {" "}
                  · briefing:{" "}
                  {a.briefing_is_stale ? (
                    <span className="text-amber-700">stale</span>
                  ) : (
                    "fresh"
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>

      <div className="text-[9px] text-muted-foreground text-right">
        Inspect generated: {fmtTime(data.generated_at)}
      </div>
    </div>
  );
};

// ── small helpers ──────────────────────────────────────────────────

const Stat = ({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  tone?: "ok" | "warn" | "neutral";
}) => {
  const cls =
    tone === "warn"
      ? "bg-amber-500/15 text-amber-700 border-amber-500/30"
      : tone === "ok"
      ? "bg-emerald-500/10 text-emerald-700 border-emerald-500/20"
      : "bg-muted/40 text-foreground border-border/40";
  return (
    <div className={`rounded border p-1.5 ${cls}`}>
      <div className="text-[9px] opacity-70">{label}</div>
      <div className="text-[11px] font-medium">{value}</div>
    </div>
  );
};

const SlotBadge = ({
  label,
  present,
  detail,
}: {
  label: string;
  present: boolean;
  detail: string;
}) => (
  <div
    className={`rounded border p-1.5 text-[9px] ${
      present
        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-800"
        : "bg-muted/40 border-border/40 text-muted-foreground"
    }`}
  >
    <div className="font-mono">{label}</div>
    <div className="opacity-70">{detail}</div>
  </div>
);

export default HourglassInspectPanel;
