import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { cleanDisplayName } from "@/lib/didPartNaming";

// ── Types ──────────────────────────────────────────────────────

export interface ClosureChecklistState {
  karelDiagnosticDone: boolean;
  hankaAgrees: boolean;
  kataAgrees: boolean;
  emotionalStableDays: number;
  noRiskSignals: boolean;
  groundingWorks: boolean;
  triggerManaged: boolean;
  noOpenQuestions: boolean;
  relapsePlanExists: boolean;
  karelRecommendsClosure: boolean;
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

  // Therapists (derived, not hardcoded)
  primaryTherapist: string;
  secondaryTherapist: string | null;

  // Current state
  currentSummary: string;

  // Karel requires
  karelRequires: string[];

  // Closure
  closureReadiness: number; // 0-1
  closureChecklistState: ClosureChecklistState;
  canProposeClosing: boolean;
  closureReady: boolean;

  // Capabilities
  canEvaluate: boolean;

  // Clinical fields
  lastEntryBy: string | null;
  lastEntrySummary: string | null;
  lastInterventionType: string | null;
  lastInterventionWorked: boolean | null;
  triggerDescription: string | null;
  triggerActive: boolean | null;
  riskLevel0to3: number | null;
  stableHours: number | null;
  consecutiveStableEntries: number | null;

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

function computeClosureReadiness(cl: ClosureChecklistState): { score: number; canPropose: boolean; ready: boolean } {
  const canProposeClosing =
    cl.karelDiagnosticDone &&
    cl.noRiskSignals &&
    cl.emotionalStableDays >= 3 &&
    cl.groundingWorks &&
    cl.triggerManaged &&
    cl.noOpenQuestions &&
    cl.relapsePlanExists;

  const ready =
    canProposeClosing &&
    cl.hankaAgrees &&
    cl.kataAgrees &&
    cl.karelRecommendsClosure;

  const items = [
    cl.karelDiagnosticDone,
    cl.hankaAgrees,
    cl.kataAgrees,
    cl.noRiskSignals,
    cl.emotionalStableDays >= 3,
    cl.groundingWorks,
    cl.triggerManaged,
    cl.noOpenQuestions,
    cl.relapsePlanExists,
    cl.karelRecommendsClosure,
  ];
  const score = items.filter(Boolean).length / items.length;

  return { score, canPropose: canProposeClosing, ready };
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

function buildCurrentSummary(params: {
  phase: string | null;
  trend: "improving" | "stable" | "worsening" | "unknown";
  daysActive: number | null;
  hoursStale: number;
  lastDecision: string | null;
  lastInterventionType: string | null;
  lastInterventionWorked: boolean | null;
}): string {
  const parts: string[] = [];

  if (params.phase === "acute") parts.push("akutní krize");
  else if (params.phase === "stabilizing") parts.push("stabilizace");
  else if (params.phase === "diagnostic") parts.push("diagnostika");
  else if (params.phase === "closing") parts.push("uzavírání");
  else parts.push("aktivní krize");

  if (params.daysActive != null) parts.push(`den ${params.daysActive}`);

  if (params.trend === "worsening") parts.push("trend zhoršení");
  else if (params.trend === "improving") parts.push("trend zlepšení");
  else if (params.trend === "stable") parts.push("trend stabilní");
  else parts.push("trend nejasný");

  if (params.hoursStale > 24) parts.push(`${Math.round(params.hoursStale)}h bez kontaktu`);

  if (params.lastInterventionType) {
    parts.push(
      params.lastInterventionWorked === true
        ? "poslední zásah fungoval"
        : params.lastInterventionWorked === false
        ? "poslední zásah nefungoval"
        : `proběhl zásah: ${params.lastInterventionType}`
    );
  }

  if (params.lastDecision === "needs_more_data") parts.push("chybí data");

  return parts.join(" · ");
}

/** Derive primary therapist from crisis tasks instead of hardcoding */
function deriveTherapists(tasks: any[]): { primary: string; secondary: string | null } {
  if (!tasks.length) return { primary: "neurčeno", secondary: null };
  const counts: Record<string, number> = {};
  for (const t of tasks) {
    const who = (t.assigned_to || t.assignedTo || "").toLowerCase();
    if (who) counts[who] = (counts[who] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return { primary: "neurčeno", secondary: null };
  const primary = sorted[0][0] === "hanka" ? "Hanička" : sorted[0][0] === "kata" ? "Káťa" : sorted[0][0];
  const secondary = sorted.length > 1
    ? (sorted[1][0] === "hanka" ? "Hanička" : sorted[1][0] === "kata" ? "Káťa" : sorted[1][0])
    : null;
  return { primary, secondary };
}

// ── Main Hook ──────────────────────────────────────────────────

export function useCrisisOperationalState() {
  const [cards, setCards] = useState<CrisisOperationalCard[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [eventsRes, alertsRes, assessmentsRes, checklistRes, tasksRes, questionsRes, interventionsRes] = await Promise.all([
        supabase.from("crisis_events").select("*").not("phase", "eq", "closed").order("created_at", { ascending: false }),
        supabase.from("crisis_alerts").select("*").in("status", ["ACTIVE", "ACKNOWLEDGED"]).order("created_at", { ascending: false }),
        supabase.from("crisis_daily_assessments").select("*").order("assessment_date", { ascending: true }),
        supabase.from("crisis_closure_checklist").select("*"),
        supabase.from("crisis_tasks").select("*").in("status", ["PENDING", "IN_PROGRESS"]).order("created_at", { ascending: true }),
        supabase.from("did_pending_questions").select("id, question, directed_to, subject_type, status").eq("status", "pending"),
        supabase.from("crisis_intervention_sessions").select("*").order("conducted_at", { ascending: false }).limit(50),
      ]);

      const events = eventsRes.data || [];
      const alerts = alertsRes.data || [];
      const allAssessments = assessmentsRes.data || [];
      const checklists = checklistRes.data || [];
      const allTasks = tasksRes.data || [];
      const allQuestions = questionsRes.data || [];
      const allInterventions = interventionsRes.data || [];

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

        // Latest intervention for this crisis
        const latestIntervention = allInterventions.find((i: any) => i.crisis_alert_id === alertId);

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
          groundingWorks: (checklist as any)?.grounding_works ?? false,
          triggerManaged: (checklist as any)?.trigger_managed ?? false,
          noOpenQuestions: (checklist as any)?.no_open_questions ?? false,
          relapsePlanExists: (checklist as any)?.relapse_plan_exists ?? false,
          karelRecommendsClosure: (checklist as any)?.karel_recommends_closure ?? false,
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

        const { score: closureReadiness, canPropose, ready: closureReady } = computeClosureReadiness(closureChecklistState);
        const { primary: primaryTherapist, secondary: secondaryTherapist } = deriveTherapists(tasks);

        // Derive clinical fields from latest assessment/intervention
        const lastInterventionType = latestIntervention?.session_type ?? null;
        const lastInterventionWorked = latestIntervention?.session_outcome === "improved" ? true
          : latestIntervention?.session_outcome === "no_change" || latestIntervention?.session_outcome === "worsened" ? false
          : null;

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
          primaryTherapist,
          secondaryTherapist,
          currentSummary: buildCurrentSummary({
            phase: ev.phase,
            trend,
            daysActive: ev.days_active,
            hoursStale,
            lastDecision: latest?.karel_decision || null,
            lastInterventionType,
            lastInterventionWorked,
          }),
          karelRequires,
          closureReadiness,
          closureChecklistState,
          canProposeClosing: canPropose,
          closureReady,
          canEvaluate: !!ev.id,
          // Clinical fields
          lastEntryBy: latest ? (latest.therapist_hana_input ? "Hanička" : latest.therapist_kata_input ? "Káťa" : null) : null,
          lastEntrySummary: latest?.part_interview_summary ?? null,
          lastInterventionType,
          lastInterventionWorked,
          triggerDescription: ev.trigger_description ?? null,
          // triggerActive: null until we have explicit trigger_resolved field in DB
          triggerActive: null,
          riskLevel0to3: latest?.karel_risk_assessment
            ? ({ minimal: 0, low: 1, moderate: 2, high: 3, critical: 3 } as Record<string, number>)[latest.karel_risk_assessment] ?? null
            : null,
          // stableHours: needs a dedicated "stable_since" timestamp in DB; hoursStale measures data freshness, not stability duration
          stableHours: null,
          // consecutiveStableEntries: count backwards from newest assessment until we hit high/critical
          consecutiveStableEntries: (() => {
            if (assessments.length < 2) return null;
            const reversed = assessments.slice().reverse();
            let streak = 0;
            for (const a of reversed) {
              const risk = (a as any).karel_risk_assessment;
              if (risk === "high" || risk === "critical") break;
              streak++;
            }
            return streak > 0 ? streak : null;
          })(),
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
          const emptyChecklist: ClosureChecklistState = {
            karelDiagnosticDone: false, hankaAgrees: false, kataAgrees: false,
            emotionalStableDays: 0, noRiskSignals: false,
            groundingWorks: false, triggerManaged: false, noOpenQuestions: false,
            relapsePlanExists: false, karelRecommendsClosure: false,
            closureRecommendation: null,
          };
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
            primaryTherapist: "neurčeno",
            secondaryTherapist: null,
            currentSummary: buildCurrentSummary({
              phase: null, trend: "unknown", daysActive: a.days_in_crisis,
              hoursStale, lastDecision: null, lastInterventionType: null, lastInterventionWorked: null,
            }),
            karelRequires: hoursStale > 24 ? [`Čerstvý update od terapeutky (${displayName})`] : [],
            closureReadiness: 0,
            closureChecklistState: emptyChecklist,
            canProposeClosing: false,
            closureReady: false,
            canEvaluate: false,
            lastEntryBy: null,
            lastEntrySummary: null,
            lastInterventionType: null,
            lastInterventionWorked: null,
            triggerDescription: null,
            triggerActive: null,
            riskLevel0to3: null,
            stableHours: null,
            consecutiveStableEntries: null,
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
