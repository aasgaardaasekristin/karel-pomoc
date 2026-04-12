import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ═══════════════════════════════════════════════════════════════
// KAREL CRISIS SESSION LOOP — v1
//
// Tři akce:
//   plan_session     → vytvoří krizový session plan z Karlova rozhodnutí
//   generate_questions → vygeneruje povinné post-session otázky
//   process_answer   → uloží odpověď, vyhodnotí, propíše do krize
// ═══════════════════════════════════════════════════════════════

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const AI_MODEL = "google/gemini-2.5-flash";

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
    const action = body.action;

    if (action === "plan_session") return await handlePlanSession(sb, body);
    if (action === "generate_questions") return await handleGenerateQuestions(sb, body);
    if (action === "process_answer") return await handleProcessAnswer(sb, body);
    return jsonRes({ error: "Invalid action. Use plan_session, generate_questions, or process_answer." }, 400);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[CRISIS-SESSION-LOOP] FATAL:", msg);
    return jsonRes({ error: msg }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════
// 1. PLAN SESSION — from Karel's interview decision
// ═══════════════════════════════════════════════════════════════

async function handlePlanSession(sb: any, body: any) {
  const { crisis_event_id, interview_id, decision, part_name, session_goal, session_format } = body;

  if (!crisis_event_id || !part_name) {
    return jsonRes({ error: "crisis_event_id and part_name are required" }, 400);
  }

  // Determine therapist assignment from decision
  const sessionDecisions = ["needs_hana_session", "needs_kata_support", "needs_joint_crisis_meeting", "escalate", "continue_crisis"];
  const resolvedDecision = decision || "needs_hana_session";

  let therapist = "hanka";
  let sessionLead = "hanka";
  if (resolvedDecision === "needs_kata_support") {
    therapist = "kata";
    sessionLead = "kata";
  } else if (resolvedDecision === "needs_joint_crisis_meeting" || resolvedDecision === "escalate") {
    therapist = "both";
    sessionLead = "hanka";
  }

  // Fetch crisis for context
  const { data: crisis } = await sb
    .from("crisis_events")
    .select("severity, days_active, clinical_summary, phase, operating_state")
    .eq("id", crisis_event_id)
    .single();

  const severity = crisis?.severity || "moderate";
  const dayNum = crisis?.days_active || 1;

  // Determine format
  const format = session_format || (severity === "critical" ? "crisis_intervention" : "stabilization");
  const goal = session_goal || buildDefaultGoal(part_name, resolvedDecision, dayNum);

  // Build plan markdown
  const planMarkdown = buildCrisisSessionPlan(part_name, goal, format, therapist, dayNum, severity, crisis?.clinical_summary);

  // Resolve user_id
  const { data: userRow } = await sb.from("did_part_registry").select("user_id").limit(1).single();
  const userId = userRow?.user_id || "00000000-0000-0000-0000-000000000000";

  const todayDate = new Date().toISOString().slice(0, 10);

  // Check for existing plan today
  const { data: existing } = await sb
    .from("did_daily_session_plans")
    .select("id")
    .eq("selected_part", part_name)
    .eq("plan_date", todayDate)
    .in("status", ["pending", "planned"])
    .limit(1);

  let planId: string;

  if (existing && existing.length > 0) {
    // Update existing plan
    planId = existing[0].id;
    await sb.from("did_daily_session_plans").update({
      plan_markdown: planMarkdown,
      plan_html: `<pre>${planMarkdown}</pre>`,
      session_format: format,
      session_lead: sessionLead,
      therapist,
      urgency_score: severity === "critical" ? 100 : 85,
      urgency_breakdown: { source: "crisis_session_loop", decision: resolvedDecision, crisis_day: dayNum },
      crisis_event_id,
      generated_by: "crisis_session_loop",
      part_tier: "crisis",
    }).eq("id", planId);
  } else {
    // Insert new plan
    const { data: inserted, error: insertErr } = await sb.from("did_daily_session_plans").insert({
      selected_part: part_name,
      plan_date: todayDate,
      plan_markdown: planMarkdown,
      plan_html: `<pre>${planMarkdown}</pre>`,
      session_format: format,
      session_lead: sessionLead,
      therapist,
      urgency_score: severity === "critical" ? 100 : 85,
      urgency_breakdown: { source: "crisis_session_loop", decision: resolvedDecision, crisis_day: dayNum },
      status: "pending",
      generated_by: "crisis_session_loop",
      part_tier: "crisis",
      user_id: userId,
    }).select("id").single();

    if (insertErr) return jsonRes({ error: insertErr.message }, 500);
    planId = inserted.id;
  }

  // Update crisis_events operating state
  await sb.from("crisis_events").update({
    operating_state: "awaiting_session_result",
    awaiting_response_from_therapists: [therapist === "both" ? "hanka" : therapist],
    updated_at: new Date().toISOString(),
  }).eq("id", crisis_event_id);

  console.log(`[CRISIS-SESSION-LOOP] Session planned: ${planId} for ${part_name} (${resolvedDecision})`);

  return jsonRes({
    success: true,
    session_plan_id: planId,
    therapist,
    session_lead: sessionLead,
    format,
    goal,
  });
}

// ═══════════════════════════════════════════════════════════════
// 2. GENERATE QUESTIONS — mandatory post-session Q/A
// ═══════════════════════════════════════════════════════════════

async function handleGenerateQuestions(sb: any, body: any) {
  const { crisis_event_id, session_plan_id, therapist_name } = body;

  if (!crisis_event_id) {
    return jsonRes({ error: "crisis_event_id is required" }, 400);
  }

  const therapist = therapist_name || "hanka";
  const requiredBy = new Date(Date.now() + 24 * 3600000).toISOString().slice(0, 10);

  // Fetch crisis context for tailored questions
  const { data: crisis } = await sb
    .from("crisis_events")
    .select("part_name, severity, days_active, clinical_summary, operating_state")
    .eq("id", crisis_event_id)
    .single();

  const partName = crisis?.part_name || "část";
  const dayNum = crisis?.days_active || 1;

  // Standard crisis post-session questions
  const questions = [
    {
      question_text: `Co se během sezení s ${partName} změnilo? Jaký byl hlavní posun nebo moment?`,
      therapist_name: therapist,
      required_by: requiredBy,
    },
    {
      question_text: `Co ${partName} během sezení zvládl/a a co ne? Kde byly limity?`,
      therapist_name: therapist,
      required_by: requiredBy,
    },
    {
      question_text: `Jak reagovalo tělo ${partName}? Somatické projevy, napětí, uvolnění?`,
      therapist_name: therapist,
      required_by: requiredBy,
    },
    {
      question_text: `Jak reagovala důvěra ${partName} vůči tobě? Posílila se, oslabila, zůstala stejná?`,
      therapist_name: therapist,
      required_by: requiredBy,
    },
    {
      question_text: `Fungoval zvolený zásah? Co by Karel měl příště upravit?`,
      therapist_name: therapist,
      required_by: requiredBy,
    },
    {
      question_text: `Co je teď hlavní riziko u ${partName}? Na co si dávat pozor?`,
      therapist_name: therapist,
      required_by: requiredBy,
    },
    {
      question_text: `Co Karel potřebuje vědět pro další rozhodování o ${partName}? Cokoliv, co ti přijde důležité.`,
      therapist_name: therapist,
      required_by: requiredBy,
    },
  ];

  // Deduplicate — don't create questions that already exist today
  const { data: existingQ } = await sb
    .from("crisis_session_questions")
    .select("question_text")
    .eq("crisis_event_id", crisis_event_id)
    .gte("created_at", new Date().toISOString().slice(0, 10) + "T00:00:00");

  const existingTexts = new Set((existingQ || []).map((q: any) => q.question_text.slice(0, 40)));
  const newQuestions = questions.filter(q => !existingTexts.has(q.question_text.slice(0, 40)));

  if (newQuestions.length === 0) {
    return jsonRes({ success: true, questions_created: 0, message: "Questions already exist for today" });
  }

  // Insert questions
  const inserts = newQuestions.map(q => ({
    crisis_event_id,
    session_plan_id: session_plan_id || null,
    question_text: q.question_text,
    therapist_name: q.therapist_name,
    required_by: q.required_by,
  }));

  const { error: insertErr } = await sb.from("crisis_session_questions").insert(inserts);

  if (insertErr) {
    console.error("[CRISIS-SESSION-LOOP] Questions insert error:", insertErr.message);
    return jsonRes({ error: insertErr.message }, 500);
  }

  // Update crisis required outputs
  const existingOutputs = Array.isArray(crisis?.required_outputs_today) ? crisis.required_outputs_today : [];
  const outputLabel = `Odpovědi po sezení s ${partName} (${therapist})`;
  if (!existingOutputs.some((o: any) => typeof o === "string" ? o.includes("Odpovědi po sezení") : o?.label?.includes("Odpovědi po sezení"))) {
    await sb.from("crisis_events").update({
      awaiting_response_from_therapists: [therapist],
      updated_at: new Date().toISOString(),
    }).eq("id", crisis_event_id);
  }

  console.log(`[CRISIS-SESSION-LOOP] ${newQuestions.length} questions created for ${partName} (${therapist})`);

  return jsonRes({
    success: true,
    questions_created: newQuestions.length,
    therapist,
    required_by: requiredBy,
  });
}

// ═══════════════════════════════════════════════════════════════
// 3. PROCESS ANSWER — save answer, analyze, propagate
// ═══════════════════════════════════════════════════════════════

async function handleProcessAnswer(sb: any, body: any) {
  const { question_id, answer_text } = body;

  if (!question_id || !answer_text) {
    return jsonRes({ error: "question_id and answer_text are required" }, 400);
  }

  // Fetch question
  const { data: question, error: fetchErr } = await sb
    .from("crisis_session_questions")
    .select("id, crisis_event_id, session_plan_id, therapist_name, question_text")
    .eq("id", question_id)
    .single();

  if (fetchErr || !question) {
    return jsonRes({ error: "Question not found" }, 404);
  }

  // Save answer
  const answerQualityScore = computeAnswerQuality(answer_text);

  await sb.from("crisis_session_questions").update({
    answer_text,
    answered_at: new Date().toISOString(),
    answer_quality_score: answerQualityScore,
  }).eq("id", question_id);

  // Check if all questions for this crisis are now answered
  const { data: allQuestions } = await sb
    .from("crisis_session_questions")
    .select("id, answer_text, answered_at, question_text")
    .eq("crisis_event_id", question.crisis_event_id)
    .gte("created_at", new Date().toISOString().slice(0, 10) + "T00:00:00");

  const answeredCount = (allQuestions || []).filter((q: any) => q.answered_at).length;
  const totalCount = (allQuestions || []).length;
  const allAnswered = answeredCount === totalCount && totalCount > 0;

  let karelAnalysis: string | null = null;

  if (allAnswered) {
    // All questions answered → run Karel's analysis
    karelAnalysis = await runKarelAnalysis(sb, question.crisis_event_id, allQuestions || []);
  }

  console.log(`[CRISIS-SESSION-LOOP] Answer saved: ${question_id} (${answeredCount}/${totalCount})`);

  return jsonRes({
    success: true,
    question_id,
    answer_quality_score: answerQualityScore,
    all_answered: allAnswered,
    answers_progress: `${answeredCount}/${totalCount}`,
    karel_analysis: karelAnalysis ? "completed" : "pending_more_answers",
  });
}

// ═══════════════════════════════════════════════════════════════
// KAREL ANALYSIS — runs when all post-session Q/A complete
// ═══════════════════════════════════════════════════════════════

async function runKarelAnalysis(sb: any, crisisEventId: string, questions: any[]): Promise<string | null> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) {
    console.warn("[CRISIS-SESSION-LOOP] No LOVABLE_API_KEY — skipping AI analysis");
    return runDeterministicAnalysis(sb, crisisEventId, questions);
  }

  // Fetch crisis context
  const { data: crisis } = await sb
    .from("crisis_events")
    .select("part_name, severity, days_active, clinical_summary, phase")
    .eq("id", crisisEventId)
    .single();

  const partName = crisis?.part_name || "část";

  // Build Q/A context
  const qaContext = questions.map((q: any) =>
    `OTÁZKA: ${q.question_text}\nODPOVĚĎ: ${q.answer_text || "(bez odpovědi)"}`
  ).join("\n\n");

  const systemPrompt = `Jsi Karel, vedoucí terapeutického týmu pro DID systém. Analyzuješ odpovědi terapeutky po krizovém sezení s částí ${partName} (den ${crisis?.days_active || "?"} krize, severity: ${crisis?.severity || "?"}).

Tvůj výstup MUSÍ být strukturovaný JSON:
{
  "intervention_effectiveness": "effective|partially_effective|ineffective|unclear",
  "stabilization_trend": "improving|stagnating|declining",
  "needs_followup_session": true/false,
  "needs_crisis_meeting": true/false,
  "needs_new_interview": true/false,
  "can_prepare_closure": true/false,
  "main_risk": "stručný popis hlavního rizika",
  "key_finding": "hlavní poznatek z odpovědí",
  "next_action": "konkrétní další krok",
  "summary_for_team": "3-4 věty shrnutí pro tým"
}

Buď přísný a kritický. Nebuď optimistický bez důkazů. Pokud odpovědi jsou vágní, napiš "unclear".`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    const response = await fetch(AI_URL, {
      signal: controller.signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Klinické shrnutí krize: ${(crisis?.clinical_summary || "").slice(0, 500)}\n\n${qaContext}` },
        ],
        temperature: 0.2,
        max_tokens: 2000,
      }),
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`[CRISIS-SESSION-LOOP] AI HTTP ${response.status}`);
      return runDeterministicAnalysis(sb, crisisEventId, questions);
    }

    const data = await response.json();
    const analysisText = data.choices?.[0]?.message?.content || "";

    // Parse JSON from response
    const analysisJson = extractJson(analysisText);

    if (analysisJson) {
      // Save analysis to each question
      for (const q of questions) {
        await sb.from("crisis_session_questions").update({
          karel_analysis: analysisJson.summary_for_team || analysisText.slice(0, 500),
          karel_analyzed_at: new Date().toISOString(),
        }).eq("id", q.id);
      }

      // Propagate to crisis_events
      await propagateAnalysisToCrisis(sb, crisisEventId, analysisJson, partName);

      return analysisJson.summary_for_team || analysisText.slice(0, 500);
    }

    return runDeterministicAnalysis(sb, crisisEventId, questions);
  } catch (e) {
    console.warn("[CRISIS-SESSION-LOOP] AI analysis failed:", e);
    return runDeterministicAnalysis(sb, crisisEventId, questions);
  }
}

// Deterministic fallback when AI unavailable
function runDeterministicAnalysis(sb: any, crisisEventId: string, questions: any[]): string {
  const answered = questions.filter((q: any) => q.answer_text);
  const avgLength = answered.reduce((sum: number, q: any) => sum + (q.answer_text?.length || 0), 0) / (answered.length || 1);
  const hasRiskMentions = answered.some((q: any) => /rizik|nebezpeč|ublíž|suicid|sebepoškoz/i.test(q.answer_text || ""));
  const hasPositive = answered.some((q: any) => /zlepš|uklidn|zvládl|důvěr|bezpeč/i.test(q.answer_text || ""));

  const analysis = {
    intervention_effectiveness: hasPositive ? "partially_effective" : "unclear",
    stabilization_trend: hasRiskMentions ? "declining" : (hasPositive ? "improving" : "stagnating"),
    needs_followup_session: true,
    needs_crisis_meeting: hasRiskMentions,
    needs_new_interview: !hasPositive,
    can_prepare_closure: false,
    main_risk: hasRiskMentions ? "Identifikovány rizikové signály v odpovědích" : "Nedostatek dat pro hodnocení",
    key_finding: `${answered.length}/${questions.length} odpovědí, průměrná délka ${Math.round(avgLength)} znaků`,
    next_action: hasRiskMentions ? "Eskalovat — kontaktovat Haničku ihned" : "Naplánovat follow-up sezení do 48h",
    summary_for_team: `Deterministická analýza: ${answered.length}/${questions.length} odpovědí. ${hasRiskMentions ? "⚠️ Rizikové signály." : ""} ${hasPositive ? "Pozitivní signály přítomny." : "Bez jasných pozitivních signálů."}`,
  };

  // Save and propagate
  (async () => {
    for (const q of questions) {
      await sb.from("crisis_session_questions").update({
        karel_analysis: analysis.summary_for_team,
        karel_analyzed_at: new Date().toISOString(),
      }).eq("id", q.id);
    }
    await propagateAnalysisToCrisis(sb, crisisEventId, analysis, "");
  })().catch(e => console.warn("[CRISIS-SESSION-LOOP] Determ propagation error:", e));

  return analysis.summary_for_team;
}

// ═══════════════════════════════════════════════════════════════
// PROPAGATION — write analysis results back to crisis_events
// ═══════════════════════════════════════════════════════════════

async function propagateAnalysisToCrisis(sb: any, crisisEventId: string, analysis: any, partName: string) {
  const update: Record<string, any> = {
    updated_at: new Date().toISOString(),
  };

  // Clinical summary
  if (analysis.summary_for_team) {
    update.clinical_summary = analysis.summary_for_team;
  }

  // Post-session review notes
  update.post_session_review_notes = [
    `[Post-session analysis ${new Date().toISOString().slice(0, 10)}]`,
    `Efektivita: ${analysis.intervention_effectiveness}`,
    `Trend: ${analysis.stabilization_trend}`,
    `Riziko: ${analysis.main_risk}`,
    `Klíčový nález: ${analysis.key_finding}`,
    `Další krok: ${analysis.next_action}`,
  ].join("\n");

  update.last_outcome_recorded_at = new Date().toISOString();

  // Operating state transitions
  if (analysis.can_prepare_closure) {
    update.operating_state = "ready_for_joint_review";
  } else if (analysis.needs_crisis_meeting) {
    update.operating_state = "awaiting_joint_review";
    update.crisis_meeting_required = true;
    update.crisis_meeting_reason = `Post-session analýza: ${analysis.main_risk}`;
  } else if (analysis.stabilization_trend === "improving") {
    update.operating_state = "stabilizing";
  } else {
    update.operating_state = "active";
  }

  // Required outputs based on analysis
  const newOutputs: string[] = [];
  if (analysis.needs_followup_session) newOutputs.push(`Naplánovat follow-up sezení s ${partName || "částí"}`);
  if (analysis.needs_new_interview) newOutputs.push(`Karel provede nový rozhovor s ${partName || "částí"}`);
  if (analysis.needs_crisis_meeting) newOutputs.push("Svolat krizovou poradu");
  if (analysis.can_prepare_closure) newOutputs.push("Připravit podklady pro closure");

  if (newOutputs.length > 0) {
    update.required_outputs_today = newOutputs;
  }

  // Clear awaiting if analysis complete
  update.awaiting_response_from_therapists = [];

  const { error } = await sb.from("crisis_events").update(update).eq("id", crisisEventId);

  if (error) {
    console.warn("[CRISIS-SESSION-LOOP] Crisis propagation error:", error.message);
  } else {
    console.log(`[CRISIS-SESSION-LOOP] Analysis propagated to crisis ${crisisEventId}`);
  }

  // Log
  await sb.from("system_health_log").insert({
    event_type: "crisis_session_analysis_completed",
    severity: analysis.needs_crisis_meeting ? "warning" : "info",
    message: `Post-session analysis: ${analysis.summary_for_team || ""}`.slice(0, 500),
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function buildDefaultGoal(partName: string, decision: string, dayNum: number): string {
  const goals: Record<string, string> = {
    needs_hana_session: `Stabilizační sezení s ${partName} (den ${dayNum}) — ověřit aktuální stav, provést grounding, zmapovat trend`,
    needs_kata_support: `Dálková podpora ${partName} (den ${dayNum}) — ověřit bezpečí, nabídnout regulační techniky`,
    needs_joint_crisis_meeting: `Koordinační sezení pro ${partName} (den ${dayNum}) — sjednotit postup, rozdělit zodpovědnost`,
    continue_crisis: `Follow-up sezení s ${partName} (den ${dayNum}) — ověřit stav, identifikovat změny`,
    escalate: `Krizová intervence ${partName} (den ${dayNum}) — okamžitá stabilizace, ověření bezpečí`,
    stabilize_and_monitor: `Monitorovací sezení ${partName} (den ${dayNum}) — ověřit stabilitu, zmapovat protektivní faktory`,
  };
  return goals[decision] || `Krizové sezení s ${partName} (den ${dayNum})`;
}

function buildCrisisSessionPlan(
  partName: string, goal: string, format: string, therapist: string,
  dayNum: number, severity: string, clinicalSummary: string | null,
): string {
  return [
    `# Krizové sezení: ${partName} (den ${dayNum})`,
    ``,
    `## Kontext`,
    `Severity: ${severity} | Den krize: ${dayNum}`,
    clinicalSummary ? `Klinické shrnutí: ${clinicalSummary.slice(0, 300)}` : "",
    ``,
    `## Cíl`,
    goal,
    ``,
    `## Formát`,
    format === "crisis_intervention" ? "Krizová intervence (30 min)" : "Stabilizační sezení (30–45 min)",
    ``,
    `## Vede`,
    therapist === "both" ? "Hanička + Káťa" : (therapist === "kata" ? "Káťa" : "Hanička"),
    ``,
    `## Metoda`,
    `1. Kotvení — zahájit groundingem, neotevírat traumatický materiál`,
    `2. Check-in — jak se cítíš? co se změnilo?`,
    `3. Mapování — identifikovat trend, rizika, protektivní faktory`,
    `4. Uzavření — bezpečné místo, dohoda na dalším kontaktu`,
    ``,
    `## Povinné výstupy po sezení`,
    `Karel vyžaduje odpovědi na 7 standardních otázek.`,
    `Odpovědi slouží pro Karlovo rozhodování o dalším postupu.`,
    ``,
    `## Očekávaný výstup pro Karla`,
    `- Aktuální risk level`,
    `- Trend krize (zlepšení/stagnace/zhoršení)`,
    `- Výsledek zvoleného zásahu`,
    `- Doporučení pro další den`,
  ].filter(Boolean).join("\n");
}

function computeAnswerQuality(answer: string): number {
  if (!answer) return 0;
  const len = answer.length;
  let score = 0;

  // Length-based scoring
  if (len >= 200) score += 4;
  else if (len >= 100) score += 3;
  else if (len >= 50) score += 2;
  else if (len >= 20) score += 1;

  // Detail indicators
  if (/protože|důvod|příčin/i.test(answer)) score += 1;
  if (/pozoroval|všiml|zaznamenal/i.test(answer)) score += 1;
  if (/rizik|nebezpeč|ohrož/i.test(answer)) score += 1;
  if (/zlepš|zhorš|stejn|stabiln/i.test(answer)) score += 1;
  if (/doporuč|navrh|plán/i.test(answer)) score += 1;
  if (/konkrétn|specifick|příklad/i.test(answer)) score += 1;

  return Math.min(score, 10);
}

function extractJson(text: string): any | null {
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch { /* continue */ }
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch { /* continue */ }
  }
  return null;
}

function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
