import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ═══════════════════════════════════════════════════════════════
// KAREL CRISIS DAILY CYCLE — v1
//
// Řídí 4-fázový denní krizový cyklus pro každou aktivní krizi.
// Fáze: morning_review → midday_followthrough → post_session_review → evening_decision
//
// Každá fáze má: status, timestamp, notes, missing_outputs, next_action
//
// Volání:
//   action=compute  → vyhodnotí aktuální stav všech aktivních krizí
//   action=update_phase → manuální zápis fáze (evening_decision)
// ═══════════════════════════════════════════════════════════════

interface PhaseState {
  status: "completed" | "partial" | "pending" | "missing";
  timestamp: string | null;
  notes: string | null;
  missing_outputs: string[];
  next_action: string | null;
}

interface DailyCycleState {
  date: string;
  morning_review: PhaseState;
  midday_followthrough: PhaseState;
  post_session_review: PhaseState;
  evening_decision: PhaseState;
  day_evaluation: {
    status_checked: boolean;
    last_update_verified: boolean;
    safety_confirmed: boolean;
    contact_completed: boolean;
    intervention_result_known: boolean;
    therapists_responded: boolean;
    next_step_determined: boolean;
    evening_decision_exists: boolean;
  };
  missing_outputs_today: string[];
  next_day_ready: boolean;
  next_day_open_items: string[];
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const body = await req.json();
    const action = body.action || "compute";

    if (action === "compute") {
      return await handleCompute(sb, body);
    } else if (action === "update_phase") {
      return await handleUpdatePhase(sb, body);
    } else {
      return jsonRes({ error: "Invalid action. Use 'compute' or 'update_phase'." }, 400);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[DAILY-CYCLE] FATAL:", msg);
    return jsonRes({ error: msg }, 500);
  }
});

// ── COMPUTE ──────────────────────────────────────────────────

async function handleCompute(sb: any, body: any) {
  const targetCrisisId = body.crisis_event_id || null;

  // Get active crises
  let query = sb.from("crisis_events").select("*").not("phase", "eq", "closed");
  if (targetCrisisId) {
    query = query.eq("id", targetCrisisId);
  }
  const { data: crises, error: crisisErr } = await query;

  if (crisisErr) {
    return jsonRes({ error: crisisErr.message }, 500);
  }

  const now = new Date();
  const todayDate = now.toISOString().slice(0, 10);
  const pragueHour = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Prague" })).getHours();

  const results: any[] = [];

  for (const crisis of crises || []) {
    try {
      const cycleState = await computeCrisisDailyCycle(sb, crisis, todayDate, pragueHour);
      
      // Write to crisis_events
      const update: Record<string, any> = {
        daily_checklist: cycleState,
        updated_at: new Date().toISOString(),
      };

      // Sync missing outputs to required_outputs_today
      if (cycleState.missing_outputs_today.length > 0) {
        update.required_outputs_today = cycleState.missing_outputs_today.map((m: string) => ({
          label: m,
          fulfilled: false,
        }));
      }

      // Next day plan notes
      if (!cycleState.next_day_ready && cycleState.next_day_open_items.length > 0) {
        update.next_day_plan_notes = `OTEVŘENO: ${cycleState.next_day_open_items.join("; ")}`;
      }

      await sb.from("crisis_events").update(update).eq("id", crisis.id);

      results.push({
        crisis_event_id: crisis.id,
        part_name: crisis.part_name,
        cycle_state: cycleState,
      });
    } catch (e) {
      console.warn(`[DAILY-CYCLE] Error for ${crisis.part_name}:`, e);
    }
  }

  console.log(`[DAILY-CYCLE] Computed for ${results.length} crises`);
  return jsonRes({ success: true, results });
}

// ── Core cycle computation ───────────────────────────────────

async function computeCrisisDailyCycle(
  sb: any,
  crisis: any,
  todayDate: string,
  currentHour: number,
): Promise<DailyCycleState> {
  const crisisId = crisis.id;
  const partName = crisis.part_name || "";

  // Fetch today's data sources
  const [
    { data: todayInterviews },
    { data: todayAssessments },
    { data: todaySessions },
    { data: todayQuestions },
    { data: pendingTasks },
  ] = await Promise.all([
    sb.from("crisis_karel_interviews")
      .select("id, completed_at, summary_for_team, karel_decision_after_interview, started_at")
      .eq("crisis_event_id", crisisId)
      .gte("started_at", todayDate + "T00:00:00")
      .order("started_at", { ascending: false })
      .limit(5),
    sb.from("crisis_daily_assessments")
      .select("id, assessment_date, karel_decision, part_interview_summary, therapist_hana_input, therapist_kata_input, therapist_hana_observation, therapist_kata_observation")
      .eq("crisis_event_id", crisisId)
      .eq("assessment_date", todayDate)
      .limit(3),
    sb.from("did_part_sessions")
      .select("id, session_date, notes")
      .eq("part_name", partName)
      .gte("session_date", todayDate)
      .limit(3),
    sb.from("crisis_session_questions")
      .select("id, answer_text, answered_at, therapist_name, karel_analyzed_at")
      .eq("crisis_event_id", crisisId)
      .gte("created_at", todayDate + "T00:00:00")
      .limit(10),
    sb.from("did_therapist_tasks")
      .select("id, status, assigned_to, task")
      .ilike("task", `%${partName}%`)
      .in("status", ["pending", "active", "in_progress"])
      .limit(20),
  ]);

  const completedInterviews = (todayInterviews || []).filter((i: any) => i.completed_at);
  const latestInterview = completedInterviews[0] || null;
  const hasAssessment = (todayAssessments || []).length > 0;
  const latestAssessment = (todayAssessments || [])[0] || null;
  const hasSession = (todaySessions || []).length > 0;
  const answeredQuestions = (todayQuestions || []).filter((q: any) => q.answered_at);
  const unansweredQuestions = (todayQuestions || []).filter((q: any) => !q.answered_at);
  const hankaResponded = !!(latestAssessment?.therapist_hana_input || latestAssessment?.therapist_hana_observation);
  const kataResponded = !!(latestAssessment?.therapist_kata_input || latestAssessment?.therapist_kata_observation);

  // ── MORNING REVIEW ──
  const morningReview: PhaseState = buildMorningReview(crisis, hasAssessment, latestInterview, currentHour);

  // ── MIDDAY FOLLOWTHROUGH ──
  const middayFollowthrough: PhaseState = buildMiddayFollowthrough(
    crisis, pendingTasks || [], hankaResponded, kataResponded, currentHour
  );

  // ── POST-SESSION REVIEW ──
  const postSessionReview: PhaseState = buildPostSessionReview(
    crisis, hasSession, todaySessions || [], latestInterview, currentHour
  );

  // ── EVENING DECISION ──
  const eveningDecision: PhaseState = buildEveningDecision(
    crisis, latestInterview, hasAssessment, hasSession,
    hankaResponded, kataResponded, currentHour
  );

  // ── DAY EVALUATION ──
  const dayEval = {
    status_checked: hasAssessment || !!latestInterview,
    last_update_verified: !!crisis.last_morning_review_at && crisis.last_morning_review_at >= todayDate + "T00:00:00",
    safety_confirmed: !!latestInterview?.karel_decision_after_interview && latestInterview.karel_decision_after_interview !== "escalate",
    contact_completed: hasSession || !!latestInterview,
    intervention_result_known: !!crisis.last_outcome_recorded_at && crisis.last_outcome_recorded_at >= todayDate + "T00:00:00",
    therapists_responded: hankaResponded || kataResponded,
    next_step_determined: !!latestInterview?.karel_decision_after_interview,
    evening_decision_exists: eveningDecision.status === "completed",
  };

  // ── MISSING OUTPUTS ──
  const hasKarelAnalysis = (todayQuestions || []).some((q: any) => q.karel_analyzed_at);
  const totalQuestions = (todayQuestions || []).length;
  const missingOutputs: string[] = [];
  if (!dayEval.status_checked) missingOutputs.push(`Chybí dnešní assessment/interview pro ${partName}`);
  if (!dayEval.safety_confirmed) missingOutputs.push(`Bezpečí ${partName} neověřeno`);
  if (!dayEval.contact_completed && currentHour >= 12) missingOutputs.push(`Žádný kontakt s ${partName} dnes`);
  if (!dayEval.intervention_result_known && crisis.sessions_count > 0) missingOutputs.push(`Chybí výsledek posledního zásahu u ${partName}`);
  if (!hankaResponded && currentHour >= 14) missingOutputs.push(`Chybí stanovisko Hanky k ${partName}`);
  if (!kataResponded && currentHour >= 14) missingOutputs.push(`Chybí stanovisko Káti k ${partName}`);
  if (!dayEval.evening_decision_exists && currentHour >= 18) missingOutputs.push(`Chybí večerní rozhodnutí pro ${partName}`);
  if (unansweredQuestions.length > 0) missingOutputs.push(`Chybí odpověď po sezení: ${unansweredQuestions.length}/${totalQuestions} otázek k ${partName}`);
  if (totalQuestions > 0 && answeredQuestions.length > 0 && !hasKarelAnalysis) missingOutputs.push(`Chybí Karlova analýza odpovědí po sezení s ${partName}`);

  // ── NEXT DAY READINESS ──
  const openItems: string[] = [];
  if (!dayEval.evening_decision_exists) openItems.push("Chybí večerní rozhodnutí");
  if (!dayEval.next_step_determined) openItems.push("Neurčen další krok");
  if (unansweredQuestions.length > 0) openItems.push(`${unansweredQuestions.length} nezodpovězených otázek`);
  if (!dayEval.intervention_result_known && hasSession) openItems.push("Neznámý výsledek dnešního sezení");
  if (pendingTasks && pendingTasks.length > 3) openItems.push(`${pendingTasks.length} otevřených úkolů`);

  const nextDayReady = openItems.length === 0 && dayEval.evening_decision_exists;

  return {
    date: todayDate,
    morning_review: morningReview,
    midday_followthrough: middayFollowthrough,
    post_session_review: postSessionReview,
    evening_decision: eveningDecision,
    day_evaluation: dayEval,
    missing_outputs_today: missingOutputs,
    next_day_ready: nextDayReady,
    next_day_open_items: openItems,
  };
}

// ── Phase builders ───────────────────────────────────────────

function buildMorningReview(crisis: any, hasAssessment: boolean, latestInterview: any, hour: number): PhaseState {
  const todayDate = new Date().toISOString().slice(0, 10);
  const hasMorningReview = !!crisis.last_morning_review_at && crisis.last_morning_review_at >= todayDate + "T00:00:00";

  if (hasMorningReview || (latestInterview && hour < 13)) {
    return {
      status: "completed",
      timestamp: crisis.last_morning_review_at || latestInterview?.started_at || null,
      notes: crisis.morning_review_notes || latestInterview?.summary_for_team || null,
      missing_outputs: [],
      next_action: null,
    };
  }

  if (hour < 12) {
    return {
      status: "pending",
      timestamp: null,
      notes: null,
      missing_outputs: ["Provést ranní review krizového stavu"],
      next_action: "Karel provede ranní check-in / interview",
    };
  }

  return {
    status: "missing",
    timestamp: null,
    notes: null,
    missing_outputs: ["Ranní review NEPROBĚHL"],
    next_action: "Provést alespoň midday review",
  };
}

function buildMiddayFollowthrough(
  crisis: any, tasks: any[], hankaResponded: boolean, kataResponded: boolean, hour: number
): PhaseState {
  const todayDate = new Date().toISOString().slice(0, 10);
  const hasAfternoonReview = !!crisis.last_afternoon_review_at && crisis.last_afternoon_review_at >= todayDate + "T00:00:00";
  
  const crisisTasks = tasks.filter((t: any) => (t.task || "").toLowerCase().includes((crisis.part_name || "").toLowerCase()));
  const completedTasks = crisisTasks.filter((t: any) => t.status === "completed" || t.status === "done");
  const pendingCrisisTasks = crisisTasks.filter((t: any) => ["pending", "active", "in_progress"].includes(t.status));
  
  const missing: string[] = [];
  if (!hankaResponded && hour >= 13) missing.push("Hanička neodpověděla");
  if (!kataResponded && hour >= 13) missing.push("Káťa neodpověděla");
  if (pendingCrisisTasks.length > 0) missing.push(`${pendingCrisisTasks.length} nesplněných krizových úkolů`);

  if (hasAfternoonReview) {
    return {
      status: missing.length === 0 ? "completed" : "partial",
      timestamp: crisis.last_afternoon_review_at,
      notes: crisis.afternoon_review_notes || null,
      missing_outputs: missing,
      next_action: missing.length > 0 ? `Dořešit: ${missing.join(", ")}` : null,
    };
  }

  if (hour < 13) {
    return {
      status: "pending",
      timestamp: null,
      notes: null,
      missing_outputs: [],
      next_action: "Midday follow-through po 13:00",
    };
  }

  return {
    status: "missing",
    timestamp: null,
    notes: null,
    missing_outputs: ["Midday follow-through NEPROBĚHL", ...missing],
    next_action: "Zkontrolovat splnění required outputs",
  };
}

function buildPostSessionReview(
  crisis: any, hasSession: boolean, sessions: any[], latestInterview: any, hour: number
): PhaseState {
  if (hasSession) {
    const hasOutcome = !!crisis.last_outcome_recorded_at;
    return {
      status: hasOutcome ? "completed" : "partial",
      timestamp: sessions[0]?.session_date || null,
      notes: crisis.post_session_review_notes || (sessions[0]?.notes ? sessions[0].notes.slice(0, 300) : null),
      missing_outputs: hasOutcome ? [] : ["Chybí výsledek sezení"],
      next_action: hasOutcome ? null : "Zapsat výsledek sezení a pozorování",
    };
  }

  // No session today
  if (hour < 16) {
    return {
      status: "pending",
      timestamp: null,
      notes: null,
      missing_outputs: [],
      next_action: "Sezení zatím neproběhlo — čeká se",
    };
  }

  return {
    status: crisis.sessions_count > 0 ? "missing" : "pending",
    timestamp: null,
    notes: null,
    missing_outputs: crisis.sessions_count > 0 ? ["Plánované sezení NEPROBĚHLO"] : [],
    next_action: crisis.sessions_count > 0 ? "Přeplánovat sezení na zítra" : "Zvážit naplánování sezení",
  };
}

function buildEveningDecision(
  crisis: any, latestInterview: any, hasAssessment: boolean, hasSession: boolean,
  hankaResponded: boolean, kataResponded: boolean, hour: number
): PhaseState {
  const todayDate = new Date().toISOString().slice(0, 10);
  const hasEveningDecision = !!crisis.last_evening_decision_at && crisis.last_evening_decision_at >= todayDate + "T00:00:00";
  
  if (hasEveningDecision) {
    return {
      status: "completed",
      timestamp: crisis.last_evening_decision_at,
      notes: crisis.evening_decision_notes || null,
      missing_outputs: [],
      next_action: null,
    };
  }

  // Karel's interview decision counts as evening decision if made after 16:00
  if (latestInterview?.karel_decision_after_interview && hour >= 16) {
    return {
      status: "completed",
      timestamp: latestInterview.completed_at || null,
      notes: `Interview decision: ${latestInterview.karel_decision_after_interview}. ${(latestInterview.summary_for_team || "").slice(0, 200)}`,
      missing_outputs: [],
      next_action: null,
    };
  }

  if (hour < 18) {
    return {
      status: "pending",
      timestamp: null,
      notes: null,
      missing_outputs: [],
      next_action: "Večerní rozhodnutí po 18:00",
    };
  }

  // After 18:00 and no decision — EXPLICIT missing state
  const missing: string[] = ["CHYBÍ VEČERNÍ ROZHODNUTÍ"];
  const reasons: string[] = [];
  if (!hasAssessment) reasons.push("chybí assessment");
  if (!hasSession) reasons.push("neproběhlo sezení");
  if (!hankaResponded) reasons.push("Hanka neodpověděla");
  if (!kataResponded) reasons.push("Káťa neodpověděla");

  return {
    status: "missing",
    timestamp: null,
    notes: reasons.length > 0 ? `Nelze rozhodnout: ${reasons.join(", ")}` : null,
    missing_outputs: missing,
    next_action: "⚠️ MISSING_REQUIRED_DECISION — Karel musí rozhodnout nebo explicitně odložit",
  };
}

// ── UPDATE PHASE (manual) ────────────────────────────────────

async function handleUpdatePhase(sb: any, body: any) {
  const { crisis_event_id, phase, notes, decision } = body;

  if (!crisis_event_id || !phase) {
    return jsonRes({ error: "crisis_event_id and phase are required" }, 400);
  }

  const validPhases = ["morning_review", "midday_followthrough", "post_session_review", "evening_decision"];
  if (!validPhases.includes(phase)) {
    return jsonRes({ error: `Invalid phase. Use: ${validPhases.join(", ")}` }, 400);
  }

  const update: Record<string, any> = {
    updated_at: new Date().toISOString(),
  };

  const now = new Date().toISOString();

  switch (phase) {
    case "morning_review":
      update.last_morning_review_at = now;
      if (notes) update.morning_review_notes = notes;
      break;
    case "midday_followthrough":
      update.last_afternoon_review_at = now;
      if (notes) update.afternoon_review_notes = notes;
      break;
    case "post_session_review":
      update.last_outcome_recorded_at = now;
      if (notes) update.post_session_review_notes = notes;
      break;
    case "evening_decision":
      update.last_evening_decision_at = now;
      if (notes) update.evening_decision_notes = notes;
      if (decision) update.operating_state = decision;
      break;
  }

  const { error } = await sb
    .from("crisis_events")
    .update(update)
    .eq("id", crisis_event_id);

  if (error) {
    return jsonRes({ error: error.message }, 500);
  }

  // Re-compute cycle state after update
  const { data: crisis } = await sb
    .from("crisis_events")
    .select("*")
    .eq("id", crisis_event_id)
    .single();

  if (crisis) {
    const todayDate = new Date().toISOString().slice(0, 10);
    const pragueHour = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Prague" })).getHours();
    const cycleState = await computeCrisisDailyCycle(sb, crisis, todayDate, pragueHour);
    
    await sb.from("crisis_events")
      .update({ daily_checklist: cycleState })
      .eq("id", crisis_event_id);

    return jsonRes({ success: true, phase, cycle_state: cycleState });
  }

  return jsonRes({ success: true, phase });
}

// ── Log to system_health_log ─────────────────────────────────

async function logCycleMissing(sb: any, crisisId: string, partName: string, missingItems: string[]) {
  if (missingItems.length === 0) return;
  
  await sb.from("system_health_log").insert({
    event_type: "crisis_daily_cycle_missing",
    severity: missingItems.some(m => m.includes("CHYBÍ VEČERNÍ")) ? "warning" : "info",
    message: `${partName}: ${missingItems.slice(0, 5).join("; ")}`.slice(0, 500),
  }).catch(() => {});
}

// ── Helpers ──────────────────────────────────────────────────

function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
