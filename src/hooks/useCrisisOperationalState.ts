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

export interface DailyChecklist {
  statusChecked: boolean;
  lastUpdateVerified: boolean;
  safetyConfirmed: boolean;
  contactCompleted: boolean;
  interventionRecorded: boolean;
  therapistsResponded: boolean;
  nextStepDetermined: boolean;
  decisionMade: boolean;
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

  // Therapists — explicit ownership from DB, fallback to heuristic
  primaryTherapist: string;
  secondaryTherapist: string | null;
  ownershipSource: "explicit" | "heuristic" | "unknown";

  // Summaries — two-layer model
  currentSummary: string;        // runtime fallback
  clinicalSummary: string | null; // authoritative from DB
  displaySummary: string;         // clinicalSummary || currentSummary

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

  // Daily cycle
  lastMorningReviewAt: string | null;
  lastAfternoonReviewAt: string | null;
  lastEveningDecisionAt: string | null;
  lastOutcomeRecordedAt: string | null;
  awaitingResponseFrom: string[];
  todayRequiredOutputs: Array<{ label: string; fulfilled: boolean }>;
  dailyChecklist: DailyChecklist;

  // Meeting trigger
  crisisMeetingRequired: boolean;
  crisisMeetingReason: string | null;

  // Meeting linkage
  meetingOpen: boolean;
  meetingId: string | null;
  meetingLastConclusionAt: string | null;
  meetingWaitingFor: string | null;
  meetingStatusSummary: string | null;
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
  const { phase, trend, daysActive, hoursStale, lastDecision, lastInterventionType, lastInterventionWorked } = params;

  // Phase label
  const phaseLabel = phase === "acute" ? "Akutní krize"
    : phase === "stabilizing" ? "Stabilizace"
    : phase === "diagnostic" ? "Diagnostika"
    : phase === "closing" ? "Uzavírání"
    : phase === "ready_to_close" ? "Připraveno k uzavření"
    : "Aktivní krize";

  // Trend
  const trendLabel = trend === "worsening" ? "trend zhoršení"
    : trend === "improving" ? "trend zlepšení"
    : trend === "stable" ? "stabilní"
    : null;

  // Build concise clinical string
  const parts: string[] = [phaseLabel];
  if (trendLabel) parts.push(trendLabel);
  if (hoursStale > 24) parts.push(`${Math.round(hoursStale)}h bez kontaktu`);
  else if (daysActive != null && trend === "stable") parts.push(`${daysActive}d bez zhoršení`);

  if (lastInterventionType) {
    if (lastInterventionWorked === true) parts.push("zásah fungoval");
    else if (lastInterventionWorked === false) parts.push("zásah nefungoval");
    else parts.push("čeká se na výsledek zásahu");
  }

  if (lastDecision === "needs_more_data") parts.push("chybí data");

  return parts.join(", ");
}

/** Derive primary therapist — prefer explicit DB fields, fallback to task heuristic */
function deriveTherapists(
  ev: any,
  tasks: any[],
): { primary: string; secondary: string | null; source: "explicit" | "heuristic" | "unknown" } {
  // 1. Explicit from DB
  if (ev?.primary_therapist) {
    const fmt = (n: string) => n === "hanka" ? "Hanička" : n === "kata" ? "Káťa" : n;
    return {
      primary: fmt(ev.primary_therapist),
      secondary: ev.secondary_therapist ? fmt(ev.secondary_therapist) : null,
      source: (ev.ownership_source as any) || "explicit",
    };
  }

  // 2. Heuristic from tasks
  if (!tasks.length) return { primary: "neurčeno", secondary: null, source: "unknown" };
  const counts: Record<string, number> = {};
  for (const t of tasks) {
    const who = (t.assigned_to || t.assignedTo || "").toLowerCase();
    if (who) counts[who] = (counts[who] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return { primary: "neurčeno", secondary: null, source: "unknown" };
  const primary = sorted[0][0] === "hanka" ? "Hanička" : sorted[0][0] === "kata" ? "Káťa" : sorted[0][0];
  const secondary = sorted.length > 1
    ? (sorted[1][0] === "hanka" ? "Hanička" : sorted[1][0] === "kata" ? "Káťa" : sorted[1][0])
    : null;
  return { primary, secondary, source: "heuristic" };
}

function parseDailyChecklist(raw: any): DailyChecklist {
  if (!raw || typeof raw !== "object") {
    return {
      statusChecked: false, lastUpdateVerified: false, safetyConfirmed: false,
      contactCompleted: false, interventionRecorded: false, therapistsResponded: false,
      nextStepDetermined: false, decisionMade: false,
    };
  }
  return {
    statusChecked: !!raw.statusChecked,
    lastUpdateVerified: !!raw.lastUpdateVerified,
    safetyConfirmed: !!raw.safetyConfirmed,
    contactCompleted: !!raw.contactCompleted,
    interventionRecorded: !!raw.interventionRecorded,
    therapistsResponded: !!raw.therapistsResponded,
    nextStepDetermined: !!raw.nextStepDetermined,
    decisionMade: !!raw.decisionMade,
  };
}

function parseRequiredOutputs(raw: any): Array<{ label: string; fulfilled: boolean }> {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r: any) => r && typeof r.label === "string").map((r: any) => ({
    label: r.label,
    fulfilled: !!r.fulfilled,
  }));
}

// ── Main Hook ──────────────────────────────────────────────────

export function useCrisisOperationalState() {
  const [cards, setCards] = useState<CrisisOperationalCard[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [eventsRes, alertsRes, assessmentsRes, checklistRes, tasksRes, questionsRes, interventionsRes, meetingsRes] = await Promise.all([
        supabase.from("crisis_events").select("*").not("phase", "eq", "closed").order("created_at", { ascending: false }),
        supabase.from("crisis_alerts").select("*").in("status", ["ACTIVE", "ACKNOWLEDGED"]).order("created_at", { ascending: false }),
        supabase.from("crisis_daily_assessments").select("*").order("assessment_date", { ascending: true }),
        supabase.from("crisis_closure_checklist").select("*"),
        supabase.from("crisis_tasks").select("*").in("status", ["PENDING", "IN_PROGRESS"]).order("created_at", { ascending: true }),
        supabase.from("did_pending_questions").select("id, question, directed_to, subject_type, status").eq("status", "pending"),
        supabase.from("crisis_intervention_sessions").select("*").order("conducted_at", { ascending: false }).limit(50),
        supabase.from("did_meetings").select("id, topic, status, finalized_at, outcome_summary, crisis_event_id, hanka_joined_at, kata_joined_at").not("crisis_event_id", "is", null).order("created_at", { ascending: false }),
      ]);

      const events = eventsRes.data || [];
      const alerts = alertsRes.data || [];
      const allAssessments = assessmentsRes.data || [];
      const checklists = checklistRes.data || [];
      const allTasks = tasksRes.data || [];
      const allQuestions = questionsRes.data || [];
      const allInterventions = interventionsRes.data || [];
      const allMeetings = meetingsRes.data || [];

      const cardMap = new Map<string, CrisisOperationalCard>();

      for (const ev of events) {
        const key = ev.part_name.toUpperCase();
        const matchingAlert = alerts.find(a => a.part_name.toUpperCase() === key);
        const alertId = matchingAlert?.id || null;
        
        // Primary: match via crisis_event_id; Fallback: legacy crisis_alert_id
        const assessments = allAssessments.filter((a: any) =>
          (a.crisis_event_id && a.crisis_event_id === ev.id) ||
          (!a.crisis_event_id && a.crisis_alert_id === alertId)
        );
        const latest = assessments.length > 0 ? assessments[assessments.length - 1] : null;
        const checklist = checklists.find((c: any) =>
          (c.crisis_event_id && c.crisis_event_id === ev.id) ||
          (!c.crisis_event_id && c.crisis_alert_id === alertId)
        );
        const tasks = allTasks.filter((t: any) =>
          (t.crisis_event_id && t.crisis_event_id === ev.id) ||
          (!t.crisis_event_id && t.crisis_alert_id === alertId)
        );
        const questions = allQuestions.filter((q: any) => {
          if ((q as any).crisis_event_id === ev.id) return true;
          const qText = (q.question || "").toLowerCase();
          return qText.includes(ev.part_name.toLowerCase()) || qText.includes(cleanDisplayName(ev.part_name).toLowerCase());
        });

        // Latest intervention — prefer crisis_event_id, fallback to legacy alert
        const latestIntervention = allInterventions.find((i: any) =>
          (i.crisis_event_id && i.crisis_event_id === ev.id) ||
          (!i.crisis_event_id && i.crisis_alert_id === alertId)
        );

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
        const { primary: primaryTherapist, secondary: secondaryTherapist, source: ownershipSource } = deriveTherapists(ev, tasks);

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
          ownershipSource,
          currentSummary: buildCurrentSummary({
            phase: ev.phase,
            trend,
            daysActive: ev.days_active,
            hoursStale,
            lastDecision: latest?.karel_decision || null,
            lastInterventionType,
            lastInterventionWorked,
          }),
          clinicalSummary: ev.clinical_summary ?? null,
          displaySummary: (ev.clinical_summary as string) || buildCurrentSummary({
            phase: ev.phase, trend, daysActive: ev.days_active, hoursStale,
            lastDecision: latest?.karel_decision || null, lastInterventionType, lastInterventionWorked,
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
          // triggerActive: use DB trigger_resolved field; invert it (resolved=true → active=false)
          triggerActive: ev.trigger_resolved != null ? !ev.trigger_resolved : null,
          riskLevel0to3: latest?.karel_risk_assessment
            ? ({ minimal: 0, low: 1, moderate: 2, high: 3, critical: 3 } as Record<string, number>)[latest.karel_risk_assessment] ?? null
            : null,
          // stableHours: use DB stable_since timestamp if available
          stableHours: ev.stable_since ? Math.max(0, (Date.now() - new Date(ev.stable_since).getTime()) / 3_600_000) : null,
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
          // Daily cycle
          lastMorningReviewAt: ev.last_morning_review_at ?? null,
          lastAfternoonReviewAt: ev.last_afternoon_review_at ?? null,
          lastEveningDecisionAt: ev.last_evening_decision_at ?? null,
          lastOutcomeRecordedAt: ev.last_outcome_recorded_at ?? null,
          awaitingResponseFrom: ev.awaiting_response_from || [],
          todayRequiredOutputs: parseRequiredOutputs(ev.today_required_outputs),
          dailyChecklist: parseDailyChecklist(ev.daily_checklist),
          crisisMeetingRequired: ev.crisis_meeting_required ?? false,
          crisisMeetingReason: ev.crisis_meeting_reason ?? null,
          // Meeting linkage
          ...(() => {
            const m = allMeetings.find((mt: any) => mt.crisis_event_id === ev.id);
            if (!m) return { meetingOpen: false, meetingId: null, meetingLastConclusionAt: null, meetingWaitingFor: null, meetingStatusSummary: null };
            const isOpen = m.status !== "finalized" && m.status !== "closed";
            const waitingFor = isOpen
              ? (!m.hanka_joined_at && !m.kata_joined_at ? "obě terapeutky"
                : !m.hanka_joined_at ? "Haničku" : !m.kata_joined_at ? "Káťu" : null)
              : null;
            const statusSummary = isOpen
              ? (waitingFor ? `otevřená, čeká na ${waitingFor}` : "otevřená")
              : (m.finalized_at ? "uzavřená" : "neaktivní");
            return {
              meetingOpen: isOpen,
              meetingId: m.id,
              meetingLastConclusionAt: m.finalized_at ?? null,
              meetingWaitingFor: waitingFor,
              meetingStatusSummary: statusSummary,
            };
          })(),
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
            ownershipSource: "unknown" as const,
            currentSummary: buildCurrentSummary({
              phase: null, trend: "unknown", daysActive: a.days_in_crisis,
              hoursStale, lastDecision: null, lastInterventionType: null, lastInterventionWorked: null,
            }),
            clinicalSummary: null,
            displaySummary: buildCurrentSummary({
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
            lastMorningReviewAt: null,
            lastAfternoonReviewAt: null,
            lastEveningDecisionAt: null,
            lastOutcomeRecordedAt: null,
            awaitingResponseFrom: [],
            todayRequiredOutputs: [],
            dailyChecklist: parseDailyChecklist(null),
            crisisMeetingRequired: false,
            crisisMeetingReason: null,
            meetingOpen: false,
            meetingId: null,
            meetingLastConclusionAt: null,
            meetingWaitingFor: null,
            meetingStatusSummary: null,
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
