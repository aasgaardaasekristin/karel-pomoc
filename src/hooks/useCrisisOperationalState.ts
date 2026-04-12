import { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { cleanDisplayName } from "@/lib/didPartNaming";

// ── Types ──────────────────────────────────────────────────────

export interface ClosureChecklistState {
  karelDiagnosticDone: boolean;
  hankaAgrees: boolean;
  kataAgrees: boolean;
  emotionalStableDays: number;
  noRiskSignals: boolean;
  closureRecommendation: string | null;
}

export interface CrisisOperationalCard {
  // Identity
  partName: string;
  displayName: string;

  // IDs
  alertId: string | null;
  eventId: string | null;
  conversationId: string | null;

  // Status
  severity: string;
  phase: string | null;
  daysActive: number | null;
  sessionsCount: number | null;

  // Trend
  trend48h: "improving" | "stable" | "worsening" | "unknown";

  // Latest assessment
  lastAssessmentDate: string | null;
  lastAssessmentDecision: string | null;
  lastAssessmentRisk: string | null;
  lastAssessmentDayNumber: number | null;

  // Contact freshness
  lastContactAt: string | null;
  hoursStale: number;
  isStale: boolean;

  // Therapists
  primaryTherapist: string;
  secondaryTherapist: string;

  // Current state (not old narrative)
  currentSummary: string;

  // Karel requires
  karelRequires: string[];

  // Closure
  closureReadiness: number; // 0-1
  closureChecklistState: ClosureChecklistState;

  // Capabilities
  canEvaluate: boolean;
  canRequestUpdate: boolean;
  canPlanSession: boolean;
  canStartClosing: boolean;

  // Indicators
  indicators: {
    safety: number | null;
    coherence: number | null;
    emotionalRegulation: number | null;
    trust: number | null;
    timeOrientation: number | null;
  };

  // Tasks
  openTasks: Array<{
    id: string;
    title: string;
    assignedTo: string;
    priority: string;
    status: string;
  }>;

  // Pending questions
  pendingQuestions: Array<{
    id: string;
    question: string;
    directedTo: string | null;
  }>;
}

// ── Helpers ────────────────────────────────────────────────────

function computeTrend(assessments: any[]): CrisisOperationalCard["trend48h"] {
  if (assessments.length < 2) return "unknown";
  const recent = assessments.slice(-2);
  const riskOrder: Record<string, number> = { minimal: 1, low: 2, moderate: 3, high: 4, critical: 5 };
  const r0 = riskOrder[recent[0].karel_risk_assessment] ?? 3;
  const r1 = riskOrder[recent[1].karel_risk_assessment] ?? 3;
  if (r1 < r0) return "improving";
  if (r1 > r0) return "worsening";
  return "stable";
}

function computeClosureReadiness(cl: ClosureChecklistState): number {
  const items = [cl.karelDiagnosticDone, cl.hankaAgrees, cl.kataAgrees, cl.noRiskSignals, cl.emotionalStableDays >= 3];
  const done = items.filter(Boolean).length;
  return done / items.length;
}

function computeKarelRequires(
  isStale: boolean,
  hoursStale: number,
  displayName: string,
  lastAssessmentDate: string | null,
  closureChecklist: ClosureChecklistState,
  openTasks: any[],
  phase: string | null,
): string[] {
  const requires: string[] = [];

  if (isStale) {
    requires.push(`Čerstvý update od terapeutky (${displayName}) — poslední kontakt ${Math.round(hoursStale)}h`);
  }

  const today = new Date().toISOString().slice(0, 10);
  if (!lastAssessmentDate || lastAssessmentDate < today) {
    requires.push("Dnešní bezpečnostní hodnocení");
  }

  const pendingCritical = openTasks.filter(t => t.priority === "CRITICAL" || t.priority === "high");
  if (pendingCritical.length > 0) {
    requires.push(`${pendingCritical.length} kritických úkolů čeká na splnění`);
  }

  if (phase === "diagnostic" || phase === "closing") {
    if (!closureChecklist.karelDiagnosticDone) requires.push("Diagnostické sezení neproběhlo");
    if (!closureChecklist.hankaAgrees) requires.push("Hanička ještě nepotvrdila uzavření");
    if (!closureChecklist.kataAgrees) requires.push("Káťa ještě nepotvrdila uzavření");
  }

  return requires;
}

function buildCurrentSummary(
  phase: string | null,
  lastDecision: string | null,
  lastRisk: string | null,
  daysActive: number | null,
  trend: string,
): string {
  const phaseLabel: Record<string, string> = { acute: "akutní fáze", stabilizing: "stabilizace", diagnostic: "diagnostika", closing: "uzavírání" };
  const decisionLabel: Record<string, string> = { crisis_continues: "krize trvá", crisis_improving: "zlepšení", crisis_resolved: "vyřešeno", needs_more_data: "potřeba dat" };
  const trendLabel: Record<string, string> = { improving: "↗ zlepšuje se", stable: "→ stabilní", worsening: "↘ zhoršuje se", unknown: "? bez dat" };

  const parts = [
    phaseLabel[phase || ""] || "aktivní",
    `den ${daysActive ?? "?"}`,
    lastDecision ? decisionLabel[lastDecision] || lastDecision : null,
    lastRisk ? `riziko: ${lastRisk}` : null,
    trendLabel[trend],
  ].filter(Boolean);

  return parts.join(" · ");
}

// ── Main Hook ──────────────────────────────────────────────────

export function useCrisisOperationalState() {
  const [cards, setCards] = useState<CrisisOperationalCard[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [eventsRes, alertsRes, assessmentsRes, checklistRes, tasksRes, questionsRes] = await Promise.all([
        supabase.from("crisis_events").select("*").not("phase", "eq", "closed").order("created_at", { ascending: false }),
        supabase.from("crisis_alerts").select("*").in("status", ["ACTIVE", "ACKNOWLEDGED"]).order("created_at", { ascending: false }),
        supabase.from("crisis_daily_assessments").select("*").order("assessment_date", { ascending: true }),
        supabase.from("crisis_closure_checklist").select("*"),
        supabase.from("crisis_tasks").select("*").in("status", ["PENDING", "IN_PROGRESS"]).order("created_at", { ascending: true }),
        supabase.from("did_pending_questions").select("id, question, directed_to, subject_type, status").eq("status", "pending"),
      ]);

      const events = eventsRes.data || [];
      const alerts = alertsRes.data || [];
      const allAssessments = assessmentsRes.data || [];
      const checklists = checklistRes.data || [];
      const allTasks = tasksRes.data || [];
      const allQuestions = questionsRes.data || [];

      // Deduplicate by part_name (events are primary)
      const cardMap = new Map<string, CrisisOperationalCard>();

      for (const ev of events) {
        const key = ev.part_name.toUpperCase();
        const matchingAlert = alerts.find(a => a.part_name.toUpperCase() === key);
        const alertId = matchingAlert?.id || null;
        const assessments = allAssessments.filter((a: any) => a.crisis_alert_id === alertId);
        const latest = assessments.length > 0 ? assessments[assessments.length - 1] : null;
        const checklist = checklists.find((c: any) => c.crisis_alert_id === alertId);
        const tasks = allTasks.filter((t: any) => t.crisis_alert_id === alertId);
        const questions = allQuestions.filter((q: any) => {
          const qText = (q.question || "").toLowerCase();
          return qText.includes(ev.part_name.toLowerCase()) || qText.includes(cleanDisplayName(ev.part_name).toLowerCase());
        });

        const lastContactAt = latest?.assessment_date
          ? latest.assessment_date + "T12:00:00Z"
          : ev.updated_at || null;
        const hoursStale = lastContactAt
          ? (Date.now() - new Date(lastContactAt).getTime()) / 3_600_000
          : 999;

        const displayName = cleanDisplayName(ev.part_name);
        const trend = computeTrend(assessments);
        const isStale = hoursStale > 24;

        const closureChecklistState: ClosureChecklistState = {
          karelDiagnosticDone: checklist?.karel_diagnostic_done ?? false,
          hankaAgrees: checklist?.hanka_agrees ?? false,
          kataAgrees: checklist?.kata_agrees ?? false,
          emotionalStableDays: checklist?.emotional_stable_days ?? 0,
          noRiskSignals: checklist?.no_risk_signals ?? false,
          closureRecommendation: checklist?.karel_closure_recommendation ?? null,
        };

        const openTasks = tasks.map((t: any) => ({
          id: t.id,
          title: t.title,
          assignedTo: t.assigned_to,
          priority: t.priority,
          status: t.status,
        }));

        const karelRequires = computeKarelRequires(
          isStale, hoursStale, displayName,
          latest?.assessment_date || null,
          closureChecklistState, openTasks, ev.phase,
        );

        const closureReadiness = computeClosureReadiness(closureChecklistState);
        const allIndicatorsAbove5 = [ev.indicator_safety, ev.indicator_coherence, ev.indicator_emotional_regulation, ev.indicator_trust, ev.indicator_time_orientation]
          .every((v: number | null) => v !== null && v > 5);

        cardMap.set(key, {
          partName: ev.part_name,
          displayName,
          alertId,
          eventId: ev.id,
          conversationId: matchingAlert?.conversation_id || null,
          severity: ev.severity || matchingAlert?.severity || "unknown",
          phase: ev.phase,
          daysActive: ev.days_active,
          sessionsCount: ev.sessions_count,
          trend48h: trend,
          lastAssessmentDate: latest?.assessment_date || null,
          lastAssessmentDecision: latest?.karel_decision || null,
          lastAssessmentRisk: latest?.karel_risk_assessment || null,
          lastAssessmentDayNumber: latest?.day_number || null,
          lastContactAt,
          hoursStale,
          isStale,
          primaryTherapist: "Hanička",
          secondaryTherapist: "Káťa",
          currentSummary: buildCurrentSummary(ev.phase, latest?.karel_decision, latest?.karel_risk_assessment, ev.days_active, trend),
          karelRequires,
          closureReadiness,
          closureChecklistState,
          canEvaluate: !!ev.id,
          canRequestUpdate: true,
          canPlanSession: true,
          canStartClosing: ev.phase === "diagnostic" && allIndicatorsAbove5 && closureReadiness >= 0.6,
          indicators: {
            safety: ev.indicator_safety,
            coherence: ev.indicator_coherence,
            emotionalRegulation: ev.indicator_emotional_regulation,
            trust: ev.indicator_trust,
            timeOrientation: ev.indicator_time_orientation,
          },
          openTasks,
          pendingQuestions: questions.map((q: any) => ({
            id: q.id,
            question: q.question,
            directedTo: q.directed_to,
          })),
        });
      }

      // Add alerts without events
      for (const a of alerts) {
        const key = a.part_name.toUpperCase();
        if (!cardMap.has(key)) {
          const displayName = cleanDisplayName(a.part_name);
          const hoursStale = (Date.now() - new Date(a.created_at).getTime()) / 3_600_000;
          cardMap.set(key, {
            partName: a.part_name,
            displayName,
            alertId: a.id,
            eventId: null,
            conversationId: a.conversation_id,
            severity: a.severity,
            phase: null,
            daysActive: a.days_in_crisis,
            sessionsCount: null,
            trend48h: "unknown",
            lastAssessmentDate: null,
            lastAssessmentDecision: null,
            lastAssessmentRisk: null,
            lastAssessmentDayNumber: null,
            lastContactAt: a.created_at,
            hoursStale,
            isStale: hoursStale > 24,
            primaryTherapist: "Hanička",
            secondaryTherapist: "Káťa",
            currentSummary: `aktivní · den ${a.days_in_crisis ?? "?"}`,
            karelRequires: hoursStale > 24 ? [`Čerstvý update od terapeutky (${displayName})`] : [],
            closureReadiness: 0,
            closureChecklistState: { karelDiagnosticDone: false, hankaAgrees: false, kataAgrees: false, emotionalStableDays: 0, noRiskSignals: false, closureRecommendation: null },
            canEvaluate: false,
            canRequestUpdate: true,
            canPlanSession: true,
            canStartClosing: false,
            indicators: { safety: null, coherence: null, emotionalRegulation: null, trust: null, timeOrientation: null },
            openTasks: [],
            pendingQuestions: [],
          });
        }
      }

      setCards(Array.from(cardMap.values()));
    } catch (err) {
      console.error("[useCrisisOperationalState] Error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const channel = supabase
      .channel("crisis-operational-state")
      .on("postgres_changes", { event: "*", schema: "public", table: "crisis_events" }, () => fetchAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "crisis_alerts" }, () => fetchAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "crisis_daily_assessments" }, () => fetchAll())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [fetchAll]);

  return { cards, loading, refetch: fetchAll };
}
