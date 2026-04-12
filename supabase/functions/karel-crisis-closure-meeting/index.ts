import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ═══════════════════════════════════════════════════════════════
// KAREL CRISIS CLOSURE MEETING — v1
//
// Řídí closure meeting protocol a state machine pro krize.
//
// Akce:
//   initiate_closure_meeting  — založí closure meeting
//   submit_position           — Hanka/Káťa zadá stanovisko
//   generate_karel_statement  — Karel vytvoří finální statement
//   check_closure_readiness   — vyhodnotí 4-vrstvou closure readiness
//   transition_state          — přepne operating_state s validací
// ═══════════════════════════════════════════════════════════════

// ── STATE MACHINE ────────────────────────────────────────────

const VALID_STATES = [
  "active",
  "intervened",
  "stabilizing",
  "awaiting_session_result",
  "awaiting_therapist_feedback",
  "ready_for_joint_review",
  "ready_to_close",
  "closed",
  "monitoring_post",
] as const;

type OperatingState = typeof VALID_STATES[number];

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  active: ["intervened", "stabilizing"],
  intervened: ["stabilizing", "active", "awaiting_session_result"],
  stabilizing: ["awaiting_session_result", "awaiting_therapist_feedback", "ready_for_joint_review", "active"],
  awaiting_session_result: ["stabilizing", "awaiting_therapist_feedback", "active"],
  awaiting_therapist_feedback: ["stabilizing", "ready_for_joint_review", "active"],
  ready_for_joint_review: ["ready_to_close", "stabilizing", "active"],
  ready_to_close: ["closed", "ready_for_joint_review", "active"],
  closed: ["monitoring_post"],
  monitoring_post: ["active", "closed"],
};

// ── CLOSURE READINESS CHECKER ────────────────────────────────

interface ClosureReadiness {
  clinical: { met: boolean; details: Record<string, boolean>; blockers: string[] };
  process: { met: boolean; details: Record<string, boolean>; blockers: string[] };
  team: { met: boolean; details: Record<string, boolean>; blockers: string[] };
  operational: { met: boolean; details: Record<string, boolean>; blockers: string[] };
  overall_ready: boolean;
  all_blockers: string[];
}

async function checkClosureReadiness(sb: any, crisisEventId: string): Promise<ClosureReadiness> {
  const { data: crisis } = await sb.from("crisis_events").select("*").eq("id", crisisEventId).single();
  if (!crisis) throw new Error("Crisis not found");

  const { data: interviews } = await sb.from("crisis_karel_interviews")
    .select("*").eq("crisis_event_id", crisisEventId).order("created_at", { ascending: false }).limit(3);

  const { data: sessions } = await sb.from("did_daily_session_plans")
    .select("*").eq("crisis_event_id", crisisEventId);

  const { data: questions } = await sb.from("crisis_session_questions")
    .select("*").eq("crisis_event_id", crisisEventId);

  const { data: meetings } = await sb.from("did_meetings")
    .select("*").eq("crisis_event_id", crisisEventId).eq("is_closure_meeting", true);

  const { data: checklist } = await sb.from("crisis_closure_checklist")
    .select("*").eq("crisis_event_id", crisisEventId).order("created_at", { ascending: false }).limit(1);

  const cl = checklist?.[0];
  const closureMeeting = meetings?.[0];
  const lastInterview = interviews?.[0];

  // ── CLINICAL ──
  const noRisk = cl?.no_risk_signals === true || crisis.indicator_safety >= 7;
  const triggerManaged = crisis.trigger_resolved === true || cl?.trigger_managed === true;
  const lastContactStable = lastInterview?.observed_regulation >= 6 && lastInterview?.observed_trust >= 5;
  const emotionalStable = cl?.emotional_stable_days >= 2 || (crisis.stable_since && daysSince(crisis.stable_since) >= 2);

  const clinicalBlockers: string[] = [];
  if (!noRisk) clinicalBlockers.push("Aktivní rizikové signály");
  if (!triggerManaged) clinicalBlockers.push("Trigger není pod kontrolou");
  if (!lastContactStable) clinicalBlockers.push("Poslední kontakt nepotvrzuje stabilizaci");
  if (!emotionalStable) clinicalBlockers.push("Méně než 2 dny emoční stability");

  // ── PROCESS ──
  const sessionsExist = (sessions?.length || 0) >= 1;
  const interventionResults = crisis.intervention_result_completeness >= 70;
  const unanswered = questions?.filter((q: any) => !q.answered_at) || [];
  const noOpenQuestions = unanswered.length === 0;
  const todayAssessment = crisis.daily_checklist != null;
  const eveningDecision = crisis.last_evening_decision_at && isToday(crisis.last_evening_decision_at);

  const processBlockers: string[] = [];
  if (!sessionsExist) processBlockers.push("Žádná proběhlá sezení");
  if (!interventionResults) processBlockers.push("Neúplné výsledky intervencí");
  if (!noOpenQuestions) processBlockers.push(`${unanswered.length} nezodpovězených otázek`);
  if (!todayAssessment) processBlockers.push("Chybí dnešní hodnocení");
  if (!eveningDecision) processBlockers.push("Chybí evening decision");

  // ── TEAM ──
  const hankaPosition = closureMeeting?.hanka_position != null;
  const kataPosition = closureMeeting?.kata_position != null;
  const closureMeetingDone = closureMeeting?.status === "finalized";
  const karelStatement = closureMeeting?.karel_final_statement != null;

  const teamBlockers: string[] = [];
  if (!hankaPosition) teamBlockers.push("Chybí stanovisko Hanky");
  if (!kataPosition) teamBlockers.push("Chybí stanovisko Káti");
  if (!closureMeetingDone) teamBlockers.push("Closure meeting neproběhl / nefinalizován");
  if (!karelStatement) teamBlockers.push("Chybí Karlův finální statement");

  // ── OPERATIONAL ──
  const monitoringPlan = crisis.closure_reason != null || cl?.relapse_plan_exists === true;
  const cardPropagated = true; // checked via dedup log if needed
  const whatToWatch = cl?.relapse_plan_exists === true;

  const operationalBlockers: string[] = [];
  if (!monitoringPlan) operationalBlockers.push("Chybí plán monitoringu");
  if (!whatToWatch) operationalBlockers.push("Chybí relapse plán");

  const allBlockers = [...clinicalBlockers, ...processBlockers, ...teamBlockers, ...operationalBlockers];

  return {
    clinical: { met: clinicalBlockers.length === 0, details: { noRisk, triggerManaged, lastContactStable, emotionalStable }, blockers: clinicalBlockers },
    process: { met: processBlockers.length === 0, details: { sessionsExist, interventionResults, noOpenQuestions, todayAssessment, eveningDecision }, blockers: processBlockers },
    team: { met: teamBlockers.length === 0, details: { hankaPosition, kataPosition, closureMeetingDone, karelStatement }, blockers: teamBlockers },
    operational: { met: operationalBlockers.length === 0, details: { monitoringPlan, whatToWatch }, blockers: operationalBlockers },
    overall_ready: allBlockers.length === 0,
    all_blockers: allBlockers,
  };
}

// ── HANDLERS ─────────────────────────────────────────────────

async function handleInitiateClosureMeeting(sb: any, body: any) {
  const { crisis_event_id, reason, agenda } = body;
  if (!crisis_event_id) return jsonRes({ error: "crisis_event_id required" }, 400);

  // Check for existing closure meeting
  const { data: existing } = await sb.from("did_meetings")
    .select("id, status").eq("crisis_event_id", crisis_event_id).eq("is_closure_meeting", true).limit(1);

  if (existing?.length) {
    return jsonRes({ success: true, meeting_id: existing[0].id, already_exists: true, status: existing[0].status });
  }

  const { data: crisis } = await sb.from("crisis_events").select("part_name").eq("id", crisis_event_id).single();
  if (!crisis) return jsonRes({ error: "Crisis not found" }, 404);

  const { data: meeting, error } = await sb.from("did_meetings").insert({
    topic: `Uzavírací porada — krize ${crisis.part_name}`,
    agenda: agenda || `1. Zhodnocení průběhu krize\n2. Stanovisko Hanky\n3. Stanovisko Káti\n4. Karlův finální statement\n5. Rozhodnutí o uzavření`,
    crisis_event_id,
    is_closure_meeting: true,
    status: "open",
    triggered_by: reason || "closure_readiness",
    messages: [],
    meeting_conclusions: { clinical: null, process: null, recommendation: null },
  }).select("id").single();

  if (error) throw error;

  // Update crisis_events
  await sb.from("crisis_events").update({
    closure_meeting_id: meeting.id,
    operating_state: "ready_for_joint_review",
    updated_at: new Date().toISOString(),
  }).eq("id", crisis_event_id);

  return jsonRes({ success: true, meeting_id: meeting.id, already_exists: false });
}

async function handleSubmitPosition(sb: any, body: any) {
  const { meeting_id, therapist, position } = body;
  if (!meeting_id || !therapist || !position) {
    return jsonRes({ error: "meeting_id, therapist, position required" }, 400);
  }
  if (!["hanka", "kata"].includes(therapist)) {
    return jsonRes({ error: "therapist must be hanka or kata" }, 400);
  }

  const update: Record<string, any> = {
    [`${therapist}_position`]: position,
    [`${therapist}_joined_at`]: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await sb.from("did_meetings").update(update).eq("id", meeting_id);
  return jsonRes({ success: true, therapist, recorded: true });
}

async function handleGenerateKarelStatement(sb: any, body: any) {
  const { crisis_event_id } = body;
  if (!crisis_event_id) return jsonRes({ error: "crisis_event_id required" }, 400);

  const { data: crisis } = await sb.from("crisis_events").select("*").eq("id", crisis_event_id).single();
  if (!crisis) return jsonRes({ error: "Crisis not found" }, 404);

  const { data: meeting } = await sb.from("did_meetings")
    .select("*").eq("crisis_event_id", crisis_event_id).eq("is_closure_meeting", true).limit(1).single();
  if (!meeting) return jsonRes({ error: "No closure meeting found" }, 404);

  const readiness = await checkClosureReadiness(sb, crisis_event_id);

  const { data: interviews } = await sb.from("crisis_karel_interviews")
    .select("*").eq("crisis_event_id", crisis_event_id).order("created_at", { ascending: false }).limit(5);

  // Generate Karel's final statement via AI
  const aiPayload = {
    model: "google/gemini-2.5-flash",
    messages: [{
      role: "user",
      content: `Jsi Karel, klinický AI analytik. Napiš finální uzavírací statement pro tuto krizi.

KRIZE: ${crisis.part_name}
Trigger: ${crisis.trigger_description}
Trvání: ${crisis.days_active || "?"} dní
Severity: ${crisis.severity}
Fáze: ${crisis.phase}

STANOVISKO HANKY: ${meeting.hanka_position || "Zatím nedodáno"}
STANOVISKO KÁTI: ${meeting.kata_position || "Zatím nedodáno"}

CLOSURE READINESS:
${JSON.stringify(readiness, null, 2)}

POSLEDNÍ ROZHOVORY:
${(interviews || []).map((i: any) => `- ${i.interview_type}: ${i.summary_for_team || "?"} (regulace: ${i.observed_regulation}, důvěra: ${i.observed_trust})`).join("\n")}

Napiš:
1. KLINICKÉ ZHODNOCENÍ (3-5 vět)
2. DOPORUČENÍ (uzavřít / pokračovat / eskalovat)
3. CO SLEDOVAT PO UZAVŘENÍ (3-5 bodů)
4. RIZIKA RELAPSU (2-3 body)
5. ZÁVĚR (1-2 věty)

Piš česky, stručně, klinicky přesně.`
    }],
  };

  const aiResp = await fetch("https://ai.lovable.dev/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("LOVABLE_API_KEY")}` },
    body: JSON.stringify(aiPayload),
  });

  let karelStatement = "Karel statement generation failed";
  if (aiResp.ok) {
    const aiData = await aiResp.json();
    karelStatement = aiData.choices?.[0]?.message?.content || karelStatement;
  }

  // Determine closure recommendation
  const recommendation = readiness.overall_ready ? "DOPORUČUJI UZAVŘÍT" :
    readiness.clinical.met && readiness.process.met ? "PODMÍNĚNĚ DOPORUČUJI — čekám na tým" :
    "NEDOPORUČUJI UZAVŘÍT — " + readiness.all_blockers.slice(0, 3).join(", ");

  await sb.from("did_meetings").update({
    karel_final_statement: karelStatement,
    closure_recommendation: recommendation,
    meeting_conclusions: {
      clinical_ready: readiness.clinical.met,
      process_ready: readiness.process.met,
      team_ready: readiness.team.met,
      operational_ready: readiness.operational.met,
      blockers: readiness.all_blockers,
      recommendation,
    },
    updated_at: new Date().toISOString(),
  }).eq("id", meeting.id);

  // Update crisis_events
  await sb.from("crisis_events").update({
    closure_statement: karelStatement,
    closure_reason: recommendation,
    updated_at: new Date().toISOString(),
  }).eq("id", crisis_event_id);

  return jsonRes({
    success: true,
    karel_statement: karelStatement,
    recommendation,
    readiness,
  });
}

async function handleTransitionState(sb: any, body: any) {
  const { crisis_event_id, target_state, reason } = body;
  if (!crisis_event_id || !target_state) {
    return jsonRes({ error: "crisis_event_id, target_state required" }, 400);
  }

  if (!VALID_STATES.includes(target_state)) {
    return jsonRes({ error: `Invalid state: ${target_state}. Valid: ${VALID_STATES.join(", ")}` }, 400);
  }

  const { data: crisis } = await sb.from("crisis_events").select("*").eq("id", crisis_event_id).single();
  if (!crisis) return jsonRes({ error: "Crisis not found" }, 404);

  const currentState = crisis.operating_state || "active";
  const allowed = ALLOWED_TRANSITIONS[currentState] || [];

  if (!allowed.includes(target_state)) {
    return jsonRes({
      error: `Transition ${currentState} → ${target_state} not allowed`,
      current_state: currentState,
      allowed_transitions: allowed,
    }, 400);
  }

  // ── HARD GUARDS ──
  if (target_state === "ready_to_close") {
    const readiness = await checkClosureReadiness(sb, crisis_event_id);
    if (!readiness.clinical.met || !readiness.team.met) {
      return jsonRes({
        error: "Cannot transition to ready_to_close",
        reason: "Clinical and team readiness required",
        blockers: readiness.all_blockers,
      }, 400);
    }
  }

  if (target_state === "closed") {
    const readiness = await checkClosureReadiness(sb, crisis_event_id);
    if (!readiness.overall_ready) {
      return jsonRes({
        error: "Cannot close crisis — not all 4 layers met",
        blockers: readiness.all_blockers,
        readiness,
      }, 400);
    }
  }

  const update: Record<string, any> = {
    operating_state: target_state,
    updated_at: new Date().toISOString(),
  };

  if (target_state === "closed") {
    update.phase = "closed";
    update.closed_at = new Date().toISOString();
  }

  if (target_state === "ready_for_joint_review") {
    update.closure_proposed_at = new Date().toISOString();
    update.closure_proposed_by = "karel_system";
  }

  await sb.from("crisis_events").update(update).eq("id", crisis_event_id);

  // Fire card propagation for significant transitions
  if (["ready_for_joint_review", "ready_to_close", "closed", "monitoring_post"].includes(target_state)) {
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      fetch(`${supabaseUrl}/functions/v1/karel-crisis-card-propagation`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${srvKey}` },
        body: JSON.stringify({
          crisis_event_id,
          part_name: crisis.part_name,
          source: target_state === "closed" ? "closure_summary" : "state_transition",
          source_id: `transition_${currentState}_${target_state}`,
          data: {
            from_state: currentState,
            to_state: target_state,
            reason: reason || "",
            days_active: crisis.days_active,
            closure_reason: crisis.closure_reason,
            closure_statement: crisis.closure_statement,
            trigger_description: crisis.trigger_description,
            clinical_summary: crisis.clinical_summary,
          },
        }),
      }).catch(e => console.warn("[closure-meeting] Propagation fire-and-forget error:", e));
    } catch (e) {
      console.warn("[closure-meeting] Propagation error:", e);
    }
  }

  return jsonRes({
    success: true,
    previous_state: currentState,
    new_state: target_state,
    reason,
  });
}

// ── MAIN SERVE ───────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const body = await req.json();
    const action = body.action;

    switch (action) {
      case "initiate_closure_meeting":
        return await handleInitiateClosureMeeting(sb, body);
      case "submit_position":
        return await handleSubmitPosition(sb, body);
      case "generate_karel_statement":
        return await handleGenerateKarelStatement(sb, body);
      case "check_closure_readiness":
        if (!body.crisis_event_id) return jsonRes({ error: "crisis_event_id required" }, 400);
        return jsonRes(await checkClosureReadiness(sb, body.crisis_event_id));
      case "transition_state":
        return await handleTransitionState(sb, body);
      default:
        return jsonRes({ error: "Unknown action. Use: initiate_closure_meeting, submit_position, generate_karel_statement, check_closure_readiness, transition_state" }, 400);
    }
  } catch (err) {
    console.error("[closure-meeting] Error:", err);
    return jsonRes({ error: String(err) }, 500);
  }
});

// ── HELPERS ──────────────────────────────────────────────────

function daysSince(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function isToday(dateStr: string): boolean {
  return new Date(dateStr).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
}

function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
