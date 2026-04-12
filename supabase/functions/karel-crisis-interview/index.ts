import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ═══════════════════════════════════════════════════════════════
// KAREL CRISIS INTERVIEW — v1
//
// Karlův vlastní krizový rozhovor s částí.
// Dva režimy:
//   action=start  → založí interview záznam
//   action=complete → uloží výsledek, propíše do crisis_events
//
// Volá se z UI (detail krize) nebo z orchestrace.
// ═══════════════════════════════════════════════════════════════

const VALID_DECISIONS = [
  "continue_crisis",
  "stabilize_and_monitor",
  "needs_hana_session",
  "needs_kata_support",
  "needs_joint_crisis_meeting",
  "prepare_closure",
  "escalate",
] as const;

const VALID_INTERVIEW_TYPES = [
  "diagnostic",
  "stabilization",
  "follow_up",
  "micro_intervention",
  "trust_building",
  "reality_check",
] as const;

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
    const action = body.action; // "start" | "complete"

    if (action === "start") {
      return await handleStart(sb, body);
    } else if (action === "complete") {
      return await handleComplete(sb, body);
    } else {
      return jsonRes({ error: "Invalid action. Use 'start' or 'complete'." }, 400);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[CRISIS-INTERVIEW] FATAL:", msg);
    return jsonRes({ error: msg }, 500);
  }
});

// ── START ─────────────────────────────────────────────────────

async function handleStart(sb: any, body: any) {
  const { crisis_event_id, part_name, interview_type, interview_goal } = body;

  if (!crisis_event_id || !part_name) {
    return jsonRes({ error: "crisis_event_id and part_name are required" }, 400);
  }

  // Verify crisis exists and is active
  const { data: crisis, error: crisisErr } = await sb
    .from("crisis_events")
    .select("id, part_name, phase, severity")
    .eq("id", crisis_event_id)
    .single();

  if (crisisErr || !crisis) {
    return jsonRes({ error: "Crisis event not found" }, 404);
  }

  // Check for existing incomplete interview today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data: existing } = await sb
    .from("crisis_karel_interviews")
    .select("id, started_at")
    .eq("crisis_event_id", crisis_event_id)
    .is("completed_at", null)
    .gte("started_at", todayStart.toISOString())
    .limit(1);

  if (existing && existing.length > 0) {
    return jsonRes({
      success: true,
      interview_id: existing[0].id,
      message: "Existing incomplete interview found for today",
      resumed: true,
    });
  }

  // Create new interview
  const type = VALID_INTERVIEW_TYPES.includes(interview_type) ? interview_type : "diagnostic";

  const { data: interview, error: insertErr } = await sb
    .from("crisis_karel_interviews")
    .insert({
      crisis_event_id,
      part_name,
      interview_type: type,
      interview_goal: interview_goal || `Diagnostický rozhovor — den ${crisis.days_active || "?"}`,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertErr) {
    console.error("[CRISIS-INTERVIEW] Insert error:", insertErr.message);
    return jsonRes({ error: insertErr.message }, 500);
  }

  console.log(`[CRISIS-INTERVIEW] Started: ${interview.id} for ${part_name} (${crisis_event_id})`);

  return jsonRes({
    success: true,
    interview_id: interview.id,
    resumed: false,
  });
}

// ── COMPLETE ──────────────────────────────────────────────────

async function handleComplete(sb: any, body: any) {
  const {
    interview_id,
    hidden_diagnostic_hypotheses,
    stabilization_methods_used,
    observed_regulation,
    observed_trust,
    observed_coherence,
    observed_somatic_state,
    observed_risk_signals,
    what_shifted,
    what_remains_unclear,
    karel_decision_after_interview,
    next_required_actions,
    summary_for_team,
  } = body;

  if (!interview_id) {
    return jsonRes({ error: "interview_id is required" }, 400);
  }

  // Validate decision
  const decision = VALID_DECISIONS.includes(karel_decision_after_interview)
    ? karel_decision_after_interview
    : "continue_crisis";

  // Fetch the interview to get crisis_event_id
  const { data: interview, error: fetchErr } = await sb
    .from("crisis_karel_interviews")
    .select("id, crisis_event_id, part_name")
    .eq("id", interview_id)
    .single();

  if (fetchErr || !interview) {
    return jsonRes({ error: "Interview not found" }, 404);
  }

  // Update interview with results
  const { error: updateErr } = await sb
    .from("crisis_karel_interviews")
    .update({
      completed_at: new Date().toISOString(),
      hidden_diagnostic_hypotheses: hidden_diagnostic_hypotheses || [],
      stabilization_methods_used: stabilization_methods_used || [],
      observed_regulation: observed_regulation ?? null,
      observed_trust: observed_trust ?? null,
      observed_coherence: observed_coherence ?? null,
      observed_somatic_state: observed_somatic_state || null,
      observed_risk_signals: observed_risk_signals || [],
      what_shifted: what_shifted || null,
      what_remains_unclear: what_remains_unclear || null,
      karel_decision_after_interview: decision,
      next_required_actions: next_required_actions || [],
      summary_for_team: summary_for_team || null,
    })
    .eq("id", interview_id);

  if (updateErr) {
    console.error("[CRISIS-INTERVIEW] Update error:", updateErr.message);
    return jsonRes({ error: updateErr.message }, 500);
  }

  // ── Propagate to crisis_events ──────────────────────────────

  const crisisUpdate: Record<string, any> = {
    updated_at: new Date().toISOString(),
  };

  // Clinical summary from interview
  if (summary_for_team) {
    crisisUpdate.clinical_summary = summary_for_team;
  }

  // Update morning/afternoon review based on time of day
  const hour = new Date().getHours();
  if (hour < 13) {
    crisisUpdate.morning_review_notes = `[Karel interview ${new Date().toISOString().slice(0, 10)}] ${(summary_for_team || "").slice(0, 500)}`;
    crisisUpdate.last_morning_review_at = new Date().toISOString();
  } else {
    crisisUpdate.afternoon_review_notes = `[Karel interview ${new Date().toISOString().slice(0, 10)}] ${(summary_for_team || "").slice(0, 500)}`;
    crisisUpdate.last_afternoon_review_at = new Date().toISOString();
  }

  // Required outputs from interview decision
  const newOutputs: string[] = [];
  const awaitingFrom: string[] = [];

  if (decision === "needs_hana_session") {
    newOutputs.push("Naplánovat stabilizační sezení s Hanou");
    awaitingFrom.push("hanka");
  } else if (decision === "needs_kata_support") {
    newOutputs.push("Zapojit Káťu — dálková podpora");
    awaitingFrom.push("kata");
  } else if (decision === "needs_joint_crisis_meeting") {
    newOutputs.push("Svolat krizovou poradu");
    awaitingFrom.push("hanka", "kata");
  } else if (decision === "escalate") {
    newOutputs.push("ESKALACE — okamžitá intervence");
    awaitingFrom.push("hanka", "kata");
  } else if (decision === "prepare_closure") {
    newOutputs.push("Připravit podklady pro uzavření krize");
  }

  if (next_required_actions && Array.isArray(next_required_actions) && next_required_actions.length > 0) {
    for (const action of next_required_actions.slice(0, 5)) {
      if (typeof action === "string") newOutputs.push(action);
      else if (action?.text) newOutputs.push(action.text);
    }
  }

  if (newOutputs.length > 0) {
    crisisUpdate.required_outputs_today = newOutputs;
  }
  if (awaitingFrom.length > 0) {
    crisisUpdate.awaiting_response_from_therapists = awaitingFrom;
  }

  // Operating state mapping
  const stateMap: Record<string, string> = {
    continue_crisis: "active",
    stabilize_and_monitor: "stabilizing",
    needs_hana_session: "awaiting_session_result",
    needs_kata_support: "active",
    needs_joint_crisis_meeting: "awaiting_joint_review",
    prepare_closure: "ready_for_joint_review",
    escalate: "active",
  };
  crisisUpdate.operating_state = stateMap[decision] || "active";

  const { error: crisisUpdateErr } = await sb
    .from("crisis_events")
    .update(crisisUpdate)
    .eq("id", interview.crisis_event_id);

  if (crisisUpdateErr) {
    console.warn("[CRISIS-INTERVIEW] Crisis event update error:", crisisUpdateErr.message);
  }

  // ── Log ─────────────────────────────────────────────────────

  await sb.from("system_health_log").insert({
    event_type: "crisis_interview_completed",
    severity: decision === "escalate" ? "warning" : "info",
    message: `Interview ${interview_id}: ${interview.part_name} → decision=${decision}. ${(summary_for_team || "").slice(0, 200)}`,
  }).catch(() => {});

  console.log(`[CRISIS-INTERVIEW] Completed: ${interview_id}, decision=${decision}`);

  return jsonRes({
    success: true,
    interview_id,
    decision,
    crisis_event_updated: !crisisUpdateErr,
    required_outputs: newOutputs,
    awaiting_from: awaitingFrom,
    operating_state: crisisUpdate.operating_state,
  });
}

// ── Helpers ───────────────────────────────────────────────────

function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
