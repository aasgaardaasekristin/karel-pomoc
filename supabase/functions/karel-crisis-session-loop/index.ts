import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * karel-crisis-session-loop — v1
 *
 * Tři akce:
 *   plan_session    → vytvoří krizový session plan z Karlova rozhodnutí
 *   generate_questions → vytvoří povinné post-session otázky
 *   process_answer  → uloží odpověď, a po poslední odpovědi spustí Karlovu analýzu
 *                     + propagaci do karty části
 */

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

const MANDATORY_QUESTIONS = [
  "Co se během sezení změnilo v chování nebo prožívání části?",
  "Co část zvládla a co nezvládla?",
  "Jak reagovalo tělo části během sezení?",
  "Jak se změnila důvěra části během sezení?",
  "Fungoval zvolený zásah? Proč ano/ne?",
  "Co je teď hlavní riziko?",
  "Co Karel potřebuje vědět dál pro další rozhodnutí?",
];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(supabaseUrl, srvKey);

  try {
    const body = await req.json();
    const action = body.action;

    if (action === "plan_session") return await handlePlanSession(sb, body);
    if (action === "generate_questions") return await handleGenerateQuestions(sb, body);
    if (action === "process_answer") return await handleProcessAnswer(sb, body, supabaseUrl, srvKey);

    return jsonRes({ error: "Invalid action. Use plan_session, generate_questions, or process_answer." }, 400);
  } catch (err) {
    console.error("[SESSION-LOOP] Error:", err);
    return jsonRes({ error: String(err) }, 500);
  }
});

// ═══════════════════════════════════════════════════════
// PLAN SESSION
// ═══════════════════════════════════════════════════════

async function handlePlanSession(sb: any, body: any) {
  const { crisis_event_id, part_name, therapist, karel_decision, focus, expected_output } = body;
  if (!crisis_event_id || !part_name) return jsonRes({ error: "crisis_event_id and part_name required" }, 400);

  const today = new Date().toISOString().slice(0, 10);
  const assignedTherapist = therapist || (karel_decision === "needs_kata_support" ? "kata" : "hanka");

  const { data, error } = await sb.from("did_daily_session_plans").insert({
    part_name,
    session_date: today,
    therapist_name: assignedTherapist,
    session_type: "crisis_intervention",
    focus: focus || `Krizová intervence — ${karel_decision || "stabilizace"}`,
    expected_output: expected_output || "Stabilizace, ověření bezpečí, zpětná vazba pro Karla",
    crisis_event_id,
    status: "planned",
  }).select("id").single();

  if (error) return jsonRes({ error: error.message }, 500);

  console.log(`[SESSION-LOOP] Session planned: ${data.id} for ${part_name}, therapist=${assignedTherapist}`);
  return jsonRes({ success: true, session_plan_id: data.id, therapist: assignedTherapist });
}

// ═══════════════════════════════════════════════════════
// GENERATE QUESTIONS
// ═══════════════════════════════════════════════════════

async function handleGenerateQuestions(sb: any, body: any) {
  const { crisis_event_id, session_plan_id, therapist_name } = body;
  if (!crisis_event_id || !therapist_name) return jsonRes({ error: "crisis_event_id and therapist_name required" }, 400);

  const requiredBy = new Date(Date.now() + 4 * 3600_000).toISOString(); // 4h deadline

  const inserts = MANDATORY_QUESTIONS.map((q) => ({
    crisis_event_id,
    session_plan_id: session_plan_id || null,
    therapist_name,
    question_text: q,
    required_by: requiredBy,
  }));

  const { data, error } = await sb.from("crisis_session_questions").insert(inserts).select("id");
  if (error) return jsonRes({ error: error.message }, 500);

  console.log(`[SESSION-LOOP] ${data.length} questions created for ${therapist_name}`);
  return jsonRes({ success: true, questions_created: data.length, question_ids: data.map((d: any) => d.id) });
}

// ═══════════════════════════════════════════════════════
// PROCESS ANSWER + ANALYSIS + CARD PROPAGATION
// ═══════════════════════════════════════════════════════

async function handleProcessAnswer(sb: any, body: any, supabaseUrl: string, srvKey: string) {
  const { question_id, answer_text } = body;
  if (!question_id || !answer_text) return jsonRes({ error: "question_id and answer_text required" }, 400);

  // Fetch question
  const { data: question, error: qErr } = await sb
    .from("crisis_session_questions")
    .select("*")
    .eq("id", question_id)
    .single();
  if (qErr || !question) return jsonRes({ error: "Question not found" }, 404);

  // Score answer quality (simple heuristic)
  const wordCount = answer_text.trim().split(/\s+/).length;
  const qualityScore = Math.min(10, Math.round(wordCount / 5));

  // Save answer
  await sb.from("crisis_session_questions").update({
    answer_text,
    answered_at: new Date().toISOString(),
    answer_quality_score: qualityScore,
  }).eq("id", question_id);

  // Check if all questions for this crisis are answered
  const { data: allQuestions } = await sb
    .from("crisis_session_questions")
    .select("id, answer_text, question_text, answered_at")
    .eq("crisis_event_id", question.crisis_event_id)
    .eq("therapist_name", question.therapist_name)
    .order("created_at", { ascending: true });

  const unanswered = (allQuestions || []).filter((q: any) => !q.answered_at);

  if (unanswered.length > 0) {
    return jsonRes({ success: true, remaining: unanswered.length, analysis_triggered: false });
  }

  // ── All answered → Karel analysis ──────────────────────
  console.log(`[SESSION-LOOP] All questions answered for ${question.crisis_event_id}. Running Karel analysis.`);

  const answeredPairs = (allQuestions || []).map((q: any) =>
    `Q: ${q.question_text}\nA: ${q.answer_text}`
  ).join("\n\n");

  // Fetch crisis context
  const { data: crisis } = await sb
    .from("crisis_events")
    .select("part_name, severity, phase, trigger_description, clinical_summary, operating_state")
    .eq("id", question.crisis_event_id)
    .single();

  const partName = crisis?.part_name || "neznámá";

  let analysis: any = {};
  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("No API key");

    const aiRes = await fetch(AI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `Jsi Karel — klinický psycholog, krizový vedoucí. Analyzuješ odpovědi terapeutky po krizovém sezení s částí "${partName}".
Krize: ${crisis?.trigger_description || "?"}, severity: ${crisis?.severity || "?"}, fáze: ${crisis?.phase || "?"}.
Aktuální klinický souhrn: ${crisis?.clinical_summary || "chybí"}.

Odpověz POUZE JSON:
{
  "intervention_effectiveness": "effective|partially_effective|ineffective|unclear",
  "stabilization_trend": "improving|stable|declining|unclear",
  "main_risk": "stručný popis hlavního rizika",
  "next_action": "konkrétní další krok",
  "what_worked": "co fungovalo" | null,
  "what_failed": "co nefungovalo" | null,
  "karel_recommendation": "doporučení pro další práci",
  "needs_follow_up_session": true/false,
  "needs_crisis_meeting": true/false,
  "prepare_closure": true/false,
  "summary_for_team": "stručný souhrn pro tým"
}`,
          },
          { role: "user", content: `Odpovědi terapeutky ${question.therapist_name}:\n\n${answeredPairs}` },
        ],
      }),
    });

    const aiData = await aiRes.json();
    const raw = aiData.choices?.[0]?.message?.content || "{}";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) analysis = JSON.parse(jsonMatch[0]);
  } catch (aiErr) {
    console.error("[SESSION-LOOP] AI analysis error:", aiErr);
    analysis = {
      intervention_effectiveness: "unclear",
      stabilization_trend: "unclear",
      main_risk: "Nelze vyhodnotit — AI analýza selhala",
      next_action: "Manuální vyhodnocení",
      summary_for_team: "Automatická analýza selhala, nutné manuální vyhodnocení.",
    };
  }

  // Save analysis to each question
  const karelAnalysisText = JSON.stringify(analysis);
  for (const q of (allQuestions || [])) {
    await sb.from("crisis_session_questions").update({
      karel_analysis: karelAnalysisText,
      karel_analyzed_at: new Date().toISOString(),
    }).eq("id", q.id);
  }

  // ── Propagate to crisis_events ─────────────────────────
  const crisisUpdate: Record<string, any> = {
    updated_at: new Date().toISOString(),
    post_session_review_notes: [
      `Efektivita: ${analysis.intervention_effectiveness || "?"}`,
      `Trend: ${analysis.stabilization_trend || "?"}`,
      `Riziko: ${analysis.main_risk || "?"}`,
      `Další krok: ${analysis.next_action || "?"}`,
    ].join("\n"),
    last_outcome_recorded_at: new Date().toISOString(),
  };

  if (analysis.summary_for_team) {
    crisisUpdate.clinical_summary = analysis.summary_for_team;
  }

  if (analysis.stabilization_trend === "improving") {
    crisisUpdate.operating_state = "stabilizing";
  } else if (analysis.prepare_closure) {
    crisisUpdate.operating_state = "ready_for_joint_review";
  }

  const newOutputs: string[] = [];
  if (analysis.needs_follow_up_session) newOutputs.push("Naplánovat follow-up sezení");
  if (analysis.needs_crisis_meeting) newOutputs.push("Svolat krizovou poradu");
  if (analysis.prepare_closure) newOutputs.push("Připravit podklady pro uzavření krize");
  if (newOutputs.length > 0) crisisUpdate.required_outputs_today = newOutputs;

  await sb.from("crisis_events").update(crisisUpdate).eq("id", question.crisis_event_id);

  // ── PROPAGATE TO PART CARD ─────────────────────────────
  console.log(`[SESSION-LOOP] Triggering card propagation for ${partName}`);
  fetch(`${supabaseUrl}/functions/v1/karel-crisis-card-propagation`, {
    method: "POST",
    headers: { Authorization: `Bearer ${srvKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      crisis_event_id: question.crisis_event_id,
      part_name: partName,
      source: "post_session_analysis",
      source_id: `qa_${question.crisis_event_id}_${new Date().toISOString().slice(0, 10)}`,
      data: {
        intervention_effectiveness: analysis.intervention_effectiveness || null,
        stabilization_trend: analysis.stabilization_trend || null,
        main_risk: analysis.main_risk || null,
        next_action: analysis.next_action || null,
        what_worked: analysis.what_worked || null,
        what_failed: analysis.what_failed || null,
        karel_recommendation: analysis.karel_recommendation || null,
        summary_for_team: analysis.summary_for_team || null,
      },
    }),
  }).catch((e) => console.warn("[SESSION-LOOP] Card propagation error:", e));

  console.log(`[SESSION-LOOP] ✅ Analysis complete for ${partName}: ${analysis.intervention_effectiveness}, trend=${analysis.stabilization_trend}`);

  return jsonRes({
    success: true,
    remaining: 0,
    analysis_triggered: true,
    analysis,
    crisis_updated: true,
    card_propagation_triggered: true,
  });
}

// ═══════════════════════════════════════════════════════

function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
