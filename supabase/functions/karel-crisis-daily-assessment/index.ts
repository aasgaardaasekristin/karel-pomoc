import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SYSTEM_RULES } from "../_shared/system-rules.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

async function callAI(systemPrompt: string, userMessage: string, apiKey: string): Promise<any> {
  const resp = await fetch(AI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("AI call failed:", resp.status, errText);
    throw new Error(`AI call failed: ${resp.status}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  const cleaned = content.replace(/```json\s*/g, "").replace(/```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    console.error("JSON parse failed, raw:", cleaned.slice(0, 500));
    return {
      part_interview_summary: "Hodnoceni se nepodarilo zpracovat",
      part_emotional_state: 5,
      part_cooperation_level: "mixed",
      risk_indicators: [],
      protective_factors: [],
      tests_to_administer: [],
      questions_for_hana: [],
      tasks_for_hana: [],
      questions_for_kata: [],
      tasks_for_kata: [],
      risk_assessment: "moderate",
      reasoning: "AI odpoved nebyla validni JSON. Nastaveno vychozi hodnoceni.",
      decision: "needs_more_data",
      next_day_plan: {},
      conversation_starters: [],
    };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") || Deno.env.get("OPENAI_API_KEY") || "";

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return new Response(
        JSON.stringify({ error: "Missing env vars" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!LOVABLE_API_KEY) {
      return new Response(
        JSON.stringify({ error: "Missing LOVABLE_API_KEY" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const body = await req.json().catch(() => ({}));
    const { crisis_alert_id } = body;

    // 1. Load active crises
    let crises: any[];
    if (crisis_alert_id) {
      const { data } = await supabase.from("crisis_alerts").select("*").eq("id", crisis_alert_id).single();
      crises = data ? [data] : [];
    } else {
      const { data } = await supabase.from("crisis_alerts").select("*").in("status", ["ACTIVE", "ACKNOWLEDGED"]);
      crises = data || [];
    }

    if (crises.length === 0) {
      return new Response(JSON.stringify({ message: "Zadne aktivni krize" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results = [];

    for (const crisis of crises) {
      // 2. Count previous assessments
      const { count: prevCount } = await supabase
        .from("crisis_daily_assessments")
        .select("id", { count: "exact", head: true })
        .eq("crisis_alert_id", crisis.id);
      const dayNumber = (prevCount || 0) + 1;

      // 3. Previous assessments
      const { data: prevData } = await supabase
        .from("crisis_daily_assessments")
        .select("*")
        .eq("crisis_alert_id", crisis.id)
        .order("assessment_date", { ascending: false })
        .limit(3);

      // 4. Recent threads
      const { data: recentThreads } = await supabase
        .from("did_threads")
        .select("id, messages, last_activity_at, sub_mode")
        .eq("part_name", crisis.part_name)
        .order("last_activity_at", { ascending: false })
        .limit(2);

      const recentMessages = (recentThreads || []).flatMap((t: any) => {
        const msgs = Array.isArray(t.messages) ? t.messages : [];
        return msgs.slice(-10);
      });

      // 5. Kartoteka (may not exist)
      let kartoteka = null;
      try {
        const { data } = await supabase.from("did_kartoteka").select("*").eq("part_name", crisis.part_name).maybeSingle();
        kartoteka = data;
      } catch { /* table may not exist */ }

      // 6. Registry
      const { data: registry } = await supabase
        .from("did_part_registry")
        .select("*")
        .eq("part_name", crisis.part_name)
        .maybeSingle();

      // 7. Metrics last 3 days
      const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
      const { data: recentMetrics } = await supabase
        .from("daily_metrics")
        .select("*")
        .eq("part_name", crisis.part_name)
        .gte("metric_date", threeDaysAgo)
        .order("metric_date", { ascending: true });

      // 8. Therapist notes
      const { data: therapistNotes } = await supabase
        .from("therapist_notes")
        .select("*")
        .eq("part_name", crisis.part_name)
        .order("created_at", { ascending: false })
        .limit(5);

      // 9. AI assessment
      const systemPrompt = `Jsi Karel, AI terapeut specializovany na DID. Provadis DENNI KRIZOVE HODNOCENI pro cast "${crisis.part_name}".

DIAGNOSTICKE NASTROJE:
- Projektivni testy (kresba, nedokoncene vety, asociace)
- Strukturovany rozhovor
- Behavioralni pozorovani
- Sebehodnotici skaly (1-10)
- Stabilizacni cviceni (grounding, kontejnment)
- Kognitivni screening
- Sledovani vzorcu

KRITERIA PRO UKONCENI KRIZE:
- Emocni valence stabilne >= 5 po 2+ dny
- Zadne rizikove signaly
- Kooperativni postoj
- Pozitivni hodnoceni od obou terapeutek
- Zadne krizove switching incidenty
- Cast dokaze regulovat emoce
- Ochranne faktory prevazuji

ODPOVEZ PRESNE V TOMTO JSON FORMATU:
{
  "part_interview_summary": "shrnuti stavu casti",
  "part_emotional_state": 1-10,
  "part_cooperation_level": "cooperative|resistant|avoidant|hostile|mixed",
  "risk_indicators": ["rizikovy faktor"],
  "protective_factors": ["ochranny faktor"],
  "tests_to_administer": [{"test_name": "...", "test_type": "projective|interview|behavioral|self_report|observational", "description": "...", "purpose": "..."}],
  "questions_for_hana": ["otazka"],
  "tasks_for_hana": ["ukol"],
  "questions_for_kata": ["otazka"],
  "tasks_for_kata": ["ukol"],
  "risk_assessment": "critical|high|moderate|low|minimal",
  "reasoning": "zduvodneni (min 3 vety)",
  "decision": "crisis_continues|crisis_improving|crisis_resolved|needs_more_data",
  "interview_request": true/false,
  "interview_type": "diagnostic|projective_test|stabilization|check_in",
  "interview_reason": "proc Karel potrebuje rozhovor (1 veta)",
  "therapist_interview_needed": true/false,
  "therapist_questions_specific": ["konkretni otazka pro terapeutku - napr. 'Hanko, vsimla sis u Arthura dnes zmeny nalady?'"],
  "next_day_plan": {"planned_session_type": "...", "planned_tests": [], "therapist_tasks": [], "focus_areas": [], "intervention_strategy": "..."},
  "conversation_starters": ["otazka pro zahajeni"]
}`;

      const userMessage = `KRIZE: ${crisis.summary || "bez popisu"}
SEVERITY: ${crisis.severity}
DEN KRIZE: ${dayNumber}
CAST: ${crisis.part_name}

KARTOTEKA: ${kartoteka ? JSON.stringify(kartoteka, null, 2).slice(0, 2000) : "Neni k dispozici"}

REGISTRY: ${registry ? JSON.stringify({ role: registry.role_in_system, strengths: registry.known_strengths, triggers: registry.known_triggers }, null, 2) : "Neni k dispozici"}

PREDCHOZI HODNOCENI:
${prevData?.length ? prevData.map((p: any) => `Den ${p.day_number}: risk=${p.karel_risk_assessment}, decision=${p.karel_decision}, valence=${p.part_emotional_state}`).join("\n") : "Zadna"}

METRIKY: ${recentMetrics ? JSON.stringify(recentMetrics, null, 2).slice(0, 1500) : "Zadne"}

POSLEDNI ZPRAVY:
${recentMessages.length > 0 ? recentMessages.map((m: any) => `[${m.role}]: ${(typeof m.content === "string" ? m.content : "...").slice(0, 200)}`).join("\n") : "Zadne"}

POZNAMKY TERAPEUTEK:
${therapistNotes?.length ? therapistNotes.map((n: any) => `[${n.note_type}] ${(n.note_text || "").slice(0, 200)}`).join("\n") : "Zadne"}

Proved denni krizove hodnoceni.`;

      const fullSystemPrompt = SYSTEM_RULES + "\n\n" + systemPrompt;
      const assessment = await callAI(fullSystemPrompt, userMessage, LOVABLE_API_KEY);

      // 10. Save assessment
      const { data: savedAssessment } = await supabase
        .from("crisis_daily_assessments")
        .insert({
          crisis_alert_id: crisis.id,
          assessment_date: new Date().toISOString().slice(0, 10),
          day_number: dayNumber,
          part_name: crisis.part_name,
          part_interview_summary: assessment.part_interview_summary,
          part_emotional_state: assessment.part_emotional_state,
          part_cooperation_level: assessment.part_cooperation_level,
          part_risk_indicators: assessment.risk_indicators || [],
          tests_administered: assessment.tests_to_administer || [],
          karel_risk_assessment: assessment.risk_assessment,
          karel_reasoning: assessment.reasoning,
          karel_decision: assessment.decision,
          next_day_plan: assessment.next_day_plan || {},
        })
        .select()
        .single();

      // 11. Create therapist tasks
      const therapistTasks: any[] = [];

      if (assessment.questions_for_hana?.length || assessment.tasks_for_hana?.length) {
        therapistTasks.push({
          task: `[KRIZE den ${dayNumber}] Ukoly pro Hanicku — ${crisis.part_name}`,
          assigned_to: "hanka",
          description: ["OTAZKY:", ...(assessment.questions_for_hana || []).map((q: string, i: number) => `${i + 1}. ${q}`), "", "UKOLY:", ...(assessment.tasks_for_hana || []).map((t: string, i: number) => `${i + 1}. ${t}`)].join("\n"),
          priority: "critical",
          status: "not_started",
          category: "crisis",
        });
      }

      if (assessment.questions_for_kata?.length || assessment.tasks_for_kata?.length) {
        therapistTasks.push({
          task: `[KRIZE den ${dayNumber}] Ukoly pro Katu — ${crisis.part_name}`,
          assigned_to: "kata",
          description: ["OTAZKY:", ...(assessment.questions_for_kata || []).map((q: string, i: number) => `${i + 1}. ${q}`), "", "UKOLY:", ...(assessment.tasks_for_kata || []).map((t: string, i: number) => `${i + 1}. ${t}`)].join("\n"),
          priority: "critical",
          status: "not_started",
          category: "crisis",
        });
      }

      for (const test of (assessment.tests_to_administer || [])) {
        therapistTasks.push({
          task: `[KRIZE] Test: ${test.test_name}`,
          assigned_to: "both",
          description: `TYP: ${test.test_type}\n\n${test.description}\n\nUCEL: ${test.purpose}`,
          priority: "critical",
          status: "not_started",
          category: "crisis",
        });
      }

      if (therapistTasks.length > 0) {
        await supabase.from("did_therapist_tasks").insert(therapistTasks);
      }

      // 11b. Therapist-specific interview tasks (from AI)
      if (assessment.therapist_interview_needed) {
        const specificQuestions = assessment.therapist_questions_specific || [];
        if (specificQuestions.length > 0) {
          await supabase.from("did_therapist_tasks").insert({
            task: `[KRIZE den ${dayNumber}] Karel VYZADUJE informace od terapeutek — ${crisis.part_name}`,
            assigned_to: "both",
            description: `Karel potrebuje odpovedi na nasledujici otazky:\n\n${specificQuestions.map((q: string, i: number) => `${i + 1}. ${q}`).join("\n")}\n\nProsim odpovezte v poznamkach k casti ${crisis.part_name}.`,
            priority: "urgent",
            status: "not_started",
            category: "interview",
          });
        }
      }

      // 11c. Plan sessions based on assessment
      const shouldPlanSession =
        assessment.risk_assessment === "critical" // critical → every day
        || (assessment.decision === "crisis_continues" && dayNumber % 2 === 0) // continues → every 2nd day
        || (dayNumber >= 7) // 7+ days → always plan
        || assessment.interview_request; // Karel explicitly requests interview

      if (shouldPlanSession) {
        // Check if session already planned in last 48h
        const { data: recentPlanned } = await supabase
          .from("did_daily_session_plans")
          .select("id")
          .eq("selected_part", crisis.part_name)
          .gte("created_at", new Date(Date.now() - 48 * 3600000).toISOString())
          .limit(1);

        if (!recentPlanned || recentPlanned.length === 0) {
          const sessionFormat = assessment.interview_request
            ? (assessment.interview_type || "diagnostic")
            : "crisis_check_in";
          const planMarkdown = [
            `# Krizové sezení — ${crisis.part_name} (den ${dayNumber})`,
            ``,
            `**Typ:** ${sessionFormat}`,
            `**Důvod:** ${assessment.interview_request ? assessment.interview_reason : `Krize trvá ${dayNumber} dní, risk=${assessment.risk_assessment}`}`,
            ``,
            `## Zaměření`,
            ...(assessment.next_day_plan?.focus_areas || ["Stabilizace, grounding, evaluace stavu"]).map((f: string) => `- ${f}`),
            ``,
            `## Strategie`,
            assessment.next_day_plan?.intervention_strategy || "Stabilizační techniky, neotevírat traumatický materiál.",
            ``,
            `## Plánované testy`,
            ...(assessment.next_day_plan?.planned_tests || []).map((t: string) => `- ${t}`),
            ``,
            `## Otevírací otázky`,
            ...(assessment.conversation_starters || []).map((q: string) => `- "${q}"`),
          ].join("\n");

          await supabase.from("did_daily_session_plans").insert({
            selected_part: crisis.part_name,
            plan_date: new Date().toISOString().slice(0, 10),
            plan_markdown: planMarkdown,
            plan_html: `<pre>${planMarkdown}</pre>`,
            session_format: sessionFormat,
            session_lead: "karel",
            therapist: "both",
            urgency_score: assessment.risk_assessment === "critical" ? 100 : 80,
            urgency_breakdown: { risk: assessment.risk_assessment, day: dayNumber, decision: assessment.decision },
            status: "pending",
            generated_by: "crisis_assessment",
            part_tier: "crisis",
          });

          console.log(`[CRISIS SESSION PLANNED] ${crisis.part_name} day ${dayNumber}: format=${sessionFormat}`);
        } else {
          console.log(`[CRISIS SESSION SKIP] ${crisis.part_name}: session already planned in last 48h`);
        }
      }

      // 12. If RESOLVED -> close crisis
      if (assessment.decision === "crisis_resolved") {
        const monitoringUntil = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
        await supabase.from("crisis_alerts").update({
          status: "RESOLVED",
          resolution_date: new Date().toISOString(),
          days_in_crisis: dayNumber,
          resolution_method: "karel_assessment",
          resolution_assessment_id: savedAssessment?.id,
          post_crisis_monitoring_until: monitoringUntil,
          resolution_notes: assessment.reasoning,
        }).eq("id", crisis.id);

        await supabase.from("did_therapist_tasks").insert({
          task: `[POST-KRIZE] Monitoring ${crisis.part_name} do ${monitoringUntil}`,
          assigned_to: "both",
          description: `Krize vyresena po ${dayNumber} dnech.\n\nDuvod: ${assessment.reasoning}\n\nSLEDUJTE:\n- Emocni stabilitu\n- Pripadne relapsy\n- Navrat rizikovych signalu\n- Monitoring do: ${monitoringUntil}`,
          priority: "high",
          status: "not_started",
          category: "crisis",
        });
      }

      // 13. Update days_in_crisis
      await supabase.from("crisis_alerts").update({ days_in_crisis: dayNumber }).eq("id", crisis.id);

      results.push({
        crisis_id: crisis.id,
        part_name: crisis.part_name,
        day_number: dayNumber,
        decision: assessment.decision,
        risk_level: assessment.risk_assessment,
        tasks_created: therapistTasks.length,
        tests_planned: (assessment.tests_to_administer || []).length,
      });
    }

    return new Response(JSON.stringify({ assessed: results.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("Top-level crisis assessment error:", error);
    return new Response(
      JSON.stringify({ error: error.message, stack: error.stack }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
