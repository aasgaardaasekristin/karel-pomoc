import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2 } from "lucide-react";

/**
 * DidCrisisPanel — pure 6-block detail (no narrative, no progress bars without context).
 *
 * Props:
 *  - partName: when provided, loads the latest crisis_event for that part.
 *  - crisisId: when provided, loads exactly that crisis_event id.
 *  - refreshTrigger: optional re-fetch trigger (kept for backward compatibility).
 *
 * Sections:
 *  1. Poslední hodnocení (crisis_karel_interviews / crisis_daily_assessments)
 *  2. Poslední zásah (crisis_intervention_sessions)
 *  3. Výsledek (crisis_session_logs — last)
 *  4. Čeká se na koho
 *  5. Další sezení (did_daily_session_plans)
 *  6. Stav uzavření (phase + closure_approved_by)
 */

interface Props {
  partName?: string;
  crisisId?: string;
  refreshTrigger?: number;
}

interface CrisisEvent {
  id: string;
  part_name: string;
  phase: string | null;
  severity: string;
  trigger_description: string | null;
  closure_approved_by: string[] | null;
  closure_proposed_at: string | null;
  closed_at: string | null;
  awaiting_response_from: string[] | null;
  primary_therapist: string | null;
  secondary_therapist: string | null;
}

interface InterviewRow {
  started_at: string | null;
  completed_at: string | null;
  observed_regulation: number | null;
  observed_trust: number | null;
  observed_coherence: number | null;
  summary_for_team: string | null;
  karel_decision_after_interview: string | null;
}

interface InterventionRow {
  conducted_at: string | null;
  session_type: string | null;
  session_outcome: string | null;
  session_summary: string | null;
}

interface SessionLogRow {
  session_date: string | null;
  session_type: string | null;
  safety_ok: boolean | null;
  coherence_score: number | null;
  risk_signals: string[] | null;
  positive_signals: string[] | null;
  summary: string | null;
}

interface PlannedSessionRow {
  id: string;
  selected_part: string;
  therapist: string | null;
  plan_date: string;
  status: string | null;
}

const PHASE_LABEL: Record<string, string> = {
  acute: "🔴 Akutní",
  stabilizing: "🟠 Stabilizace",
  diagnostic: "🔵 Diagnostika",
  closing: "🟢 Uzavírání",
  closed: "✅ Uzavřeno",
};

const fmt = (iso: string | null | undefined) => {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString("cs", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
};

const Block = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <div className="rounded-lg border border-border/40 bg-card/30 p-3">
    <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
      {title}
    </div>
    <div className="text-[12.5px] leading-5 text-foreground/85">{children}</div>
  </div>
);

const Missing = () => (
  <span className="text-[11.5px] italic text-muted-foreground/70">chybí</span>
);

export default function DidCrisisPanel({
  partName,
  crisisId,
  refreshTrigger,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [event, setEvent] = useState<CrisisEvent | null>(null);
  const [interview, setInterview] = useState<InterviewRow | null>(null);
  const [intervention, setIntervention] = useState<InterventionRow | null>(
    null,
  );
  const [sessionLog, setSessionLog] = useState<SessionLogRow | null>(null);
  const [nextPlan, setNextPlan] = useState<PlannedSessionRow | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        // 1. resolve crisis event
        let evRow: CrisisEvent | null = null;
        if (crisisId) {
          const { data } = await supabase
            .from("crisis_events")
            .select("*")
            .eq("id", crisisId)
            .maybeSingle();
          evRow = data as any;
        } else if (partName) {
          const { data } = await supabase
            .from("crisis_events")
            .select("*")
            .eq("part_name", partName)
            .not("phase", "eq", "closed")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          evRow = data as any;
        }

        if (!alive) return;
        setEvent(evRow);

        if (!evRow) {
          setInterview(null);
          setIntervention(null);
          setSessionLog(null);
          setNextPlan(null);
          setLoading(false);
          return;
        }

        const today = new Date().toISOString().slice(0, 10);

        const [ivRes, interRes, logRes, planRes] = await Promise.all([
          supabase
            .from("crisis_karel_interviews")
            .select(
              "started_at, completed_at, observed_regulation, observed_trust, observed_coherence, summary_for_team, karel_decision_after_interview",
            )
            .eq("crisis_event_id", evRow.id)
            .order("started_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase
            .from("crisis_intervention_sessions")
            .select(
              "conducted_at, session_type, session_outcome, session_summary",
            )
            .eq("crisis_event_id", evRow.id)
            .order("conducted_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase
            .from("crisis_session_logs")
            .select(
              "session_date, session_type, safety_ok, coherence_score, risk_signals, positive_signals, summary",
            )
            .eq("crisis_id", evRow.id)
            .order("session_date", { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase
            .from("did_daily_session_plans")
            .select("id, selected_part, therapist, plan_date, status")
            .eq("selected_part", evRow.part_name)
            .gte("plan_date", today)
            .order("plan_date", { ascending: true })
            .limit(1)
            .maybeSingle(),
        ]);

        if (!alive) return;
        setInterview((ivRes.data as any) || null);
        setIntervention((interRes.data as any) || null);
        setSessionLog((logRes.data as any) || null);
        setNextPlan((planRes.data as any) || null);
      } catch (e) {
        console.warn("[DidCrisisPanel] load failed", e);
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [partName, crisisId, refreshTrigger]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (!event) {
    return (
      <div className="py-4 text-center text-xs text-muted-foreground">
        Žádná aktivní krize.
      </div>
    );
  }

  // ── 4. Čeká se na koho ──
  const waitingOn: string[] = [];
  if (event.awaiting_response_from && event.awaiting_response_from.length > 0) {
    for (const r of event.awaiting_response_from) waitingOn.push(r);
  }
  // Closure-stage: still missing approvers
  if (event.phase === "closing" || event.phase === "ready_to_close") {
    const approvedBy = event.closure_approved_by || [];
    for (const needed of ["hanka", "kata"]) {
      if (!approvedBy.includes(needed) && !waitingOn.includes(needed))
        waitingOn.push(needed);
    }
  }

  return (
    <div className="space-y-2.5">
      {/* Header — minimal identity row */}
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="font-serif text-[14px] font-semibold text-foreground">
          {event.part_name}
        </div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {PHASE_LABEL[event.phase || ""] || event.phase || "—"} · {event.severity}
        </div>
      </div>

      {/* 1. Poslední hodnocení */}
      <Block title="1. Poslední hodnocení">
        {interview ? (
          <div className="space-y-1">
            <div className="text-[11.5px] text-muted-foreground">
              {fmt(interview.completed_at || interview.started_at) || (
                <Missing />
              )}
            </div>
            {interview.summary_for_team ? (
              <div>{interview.summary_for_team.slice(0, 240)}</div>
            ) : (
              <Missing />
            )}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
              <span>
                regulace:{" "}
                <strong className="text-foreground/80">
                  {interview.observed_regulation ?? "—"}
                </strong>
              </span>
              <span>
                důvěra:{" "}
                <strong className="text-foreground/80">
                  {interview.observed_trust ?? "—"}
                </strong>
              </span>
              <span>
                koherence:{" "}
                <strong className="text-foreground/80">
                  {interview.observed_coherence ?? "—"}
                </strong>
              </span>
            </div>
          </div>
        ) : (
          <Missing />
        )}
      </Block>

      {/* 2. Poslední zásah */}
      <Block title="2. Poslední zásah">
        {intervention ? (
          <div className="space-y-1">
            <div className="text-[11.5px] text-muted-foreground">
              {fmt(intervention.conducted_at) || <Missing />} ·{" "}
              {intervention.session_type || "—"}
            </div>
            {intervention.session_summary ? (
              <div>{intervention.session_summary.slice(0, 240)}</div>
            ) : (
              <Missing />
            )}
          </div>
        ) : (
          <Missing />
        )}
      </Block>

      {/* 3. Výsledek */}
      <Block title="3. Výsledek">
        {sessionLog ? (
          <div className="space-y-1">
            <div className="text-[11.5px] text-muted-foreground">
              {fmt(sessionLog.session_date) || <Missing />}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px]">
              <span>
                bezpečí:{" "}
                {sessionLog.safety_ok === true ? (
                  <strong className="text-foreground/85">✅</strong>
                ) : sessionLog.safety_ok === false ? (
                  <strong className="text-destructive">⚠️</strong>
                ) : (
                  "—"
                )}
              </span>
              <span>
                koherence:{" "}
                <strong className="text-foreground/80">
                  {sessionLog.coherence_score ?? "—"}
                </strong>
              </span>
            </div>
            {sessionLog.risk_signals && sessionLog.risk_signals.length > 0 && (
              <div className="text-[11.5px] text-destructive/80">
                rizikové: {sessionLog.risk_signals.slice(0, 3).join(", ")}
              </div>
            )}
            {sessionLog.positive_signals &&
              sessionLog.positive_signals.length > 0 && (
                <div className="text-[11.5px] text-foreground/70">
                  pozitivní: {sessionLog.positive_signals.slice(0, 3).join(", ")}
                </div>
              )}
          </div>
        ) : (
          <Missing />
        )}
      </Block>

      {/* 4. Čeká se na koho */}
      <Block title="4. Čeká se na koho">
        {waitingOn.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {waitingOn.map((w) => (
              <span
                key={w}
                className="rounded-md bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-foreground/85"
              >
                {w}
              </span>
            ))}
          </div>
        ) : (
          <Missing />
        )}
      </Block>

      {/* 5. Další sezení */}
      <Block title="5. Další sezení">
        {nextPlan ? (
          <div className="text-[12px]">
            <span className="font-medium text-foreground">
              {nextPlan.plan_date}
            </span>
            <span className="text-muted-foreground">
              {" "}
              · {nextPlan.therapist || "—"} · {nextPlan.status || "planned"}
            </span>
          </div>
        ) : (
          <Missing />
        )}
      </Block>

      {/* 6. Stav uzavření */}
      <Block title="6. Stav uzavření">
        <div className="space-y-1">
          <div className="text-[12px]">
            fáze:{" "}
            <strong className="text-foreground">
              {PHASE_LABEL[event.phase || ""] || event.phase || "—"}
            </strong>
          </div>
          <div className="text-[11.5px] text-muted-foreground">
            schváleno:{" "}
            {event.closure_approved_by && event.closure_approved_by.length > 0
              ? event.closure_approved_by.join(", ")
              : "—"}
          </div>
          {event.closed_at && (
            <div className="text-[11.5px] text-muted-foreground">
              uzavřeno: {fmt(event.closed_at)}
            </div>
          )}
        </div>
      </Block>
    </div>
  );
}
