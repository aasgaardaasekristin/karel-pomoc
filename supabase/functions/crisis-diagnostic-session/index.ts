import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

async function callGemini(system: string, user: string): Promise<string> {
  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(AI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`AI ${res.status}`);
    const d = await res.json();
    return d.choices?.[0]?.message?.content || "";
  } finally { clearTimeout(timer); }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, srvKey);

  try {
    const { crisisId, threadMessages } = await req.json();
    if (!crisisId || !threadMessages) {
      return new Response(JSON.stringify({ error: "crisisId and threadMessages required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: crisis } = await sb.from("crisis_events").select("*").eq("id", crisisId).single();
    if (!crisis) return new Response(JSON.stringify({ error: "Crisis not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const prompt = `Jsi Karel — klinický psycholog provádějící diagnostický rozhovor s částí "${crisis.part_name}" DID systému.

Část je v krizovém stavu od ${crisis.opened_at}.
Popis krize: ${crisis.trigger_description}

Dostal jsi přepis rozhovoru kde jsi s touto částí vedl diagnostický rozhovor.

ANALYZUJ rozhovor a vyhodnoť tyto diagnostické oblasti:

1. BAREVNÝ TEST (Lüscher adaptovaný):
   Pokud se v rozhovoru objevily barvy — interpretuj volbu barev.
   Pokud ne — zapiš "neprovedeno". Skóre: 0-15

2. TEST STROMU (Baum-test adaptovaný):
   Pokud část popisovala strom — interpretuj:
   Kořeny=zakotvení, Kmen=síla ega, Koruna=aspirace, Okolí=vnímání prostředí
   Skóre: 0-15

3. PROJEKTIVNÍ PŘÍBĚH:
   Pokud část vyprávěla příběh — analyzuj:
   Hlavní postava=projekce části, Konflikt=vnitřní konflikt, Rozuzlení=copingová strategie
   Skóre: 0-15

4. ŠKÁLOVÁNÍ:
   Pokud část odpovídala na škálu — zapiš. Skóre: 0-15

5. ČASOVÁ ORIENTACE:
   Mluví o budoucnosti? Plánuje? Má přání? Skóre: 0-15

6. VZTAHOVÁ SONDA:
   Identifikuje bezpečné osoby? Důvěřuje? Skóre: 0-15

7. REALITY TESTING:
   Orientace v čase/prostoru, koherence, adekvátní reakce. Skóre: 0-10

CELKOVÉ SKÓRE: součet všech oblastí (max 100)

PRAHY:
0-30: KRITICKÝ stav, návrat do akutní fáze
31-50: NESTABILNÍ, pokračovat v intenzivní práci
51-64: ZLEPŠENÍ ale nedostatečné pro uzavření
65-80: STABILIZOVANÝ, lze navrhnout uzavření
81-100: PLNĚ STABILIZOVANÝ, doporučeno uzavření

VÝSTUP (JSON):
{
  "total_score": číslo,
  "areas": {
    "color_test": {"score": 0-15, "interpretation": "text", "raw_data": "co řekl"},
    "tree_test": {"score": 0-15, "interpretation": "text", "raw_data": "co řekl"},
    "projective": {"score": 0-15, "interpretation": "text", "raw_data": "co řekl"},
    "scaling": {"score": 0-15, "interpretation": "text", "raw_data": "co řekl"},
    "time_orientation": {"score": 0-15, "interpretation": "text", "raw_data": "co řekl"},
    "relationship": {"score": 0-15, "interpretation": "text", "raw_data": "co řekl"},
    "reality_testing": {"score": 0-10, "interpretation": "text", "raw_data": "co řekl"}
  },
  "overall_assessment": "celkové hodnocení",
  "recommendation": "close_crisis|continue_stabilization|return_to_acute",
  "recommendation_reason": "důvod",
  "concerns": ["obavy"],
  "strengths": ["silné stránky"],
  "follow_up_plan": "co dál"
}

ROZHOVOR:
${typeof threadMessages === "string" ? threadMessages : JSON.stringify(threadMessages).slice(0, 60000)}`;

    const raw = await callGemini("Jsi Karel, klinický psycholog provádějící diagnostiku. Odpovídej POUZE JSON.", prompt);

    let result: any = {};
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) result = JSON.parse(m[0]);
    } catch { result = { total_score: 0, recommendation: "continue_stabilization" }; }

    const areas = result.areas || {};
    const totalScore = result.total_score || 0;

    // Save to crisis_session_logs
    await sb.from("crisis_session_logs").insert({
      crisis_id: crisisId,
      session_type: "diagnostic",
      emotional_regulation_ok: totalScore >= 50,
      safety_ok: totalScore >= 40,
      coherence_score: Math.round(totalScore / 10),
      trust_level: areas.relationship?.score ? Math.round(areas.relationship.score * 10 / 15) : 5,
      future_mentions: (areas.time_orientation?.score || 0) >= 8,
      summary: result.overall_assessment?.slice(0, 2000),
      karel_notes: result.follow_up_plan?.slice(0, 2000),
      risk_signals: result.concerns || [],
      positive_signals: result.strengths || [],
      color_test_result: JSON.stringify(areas.color_test || {}),
      tree_test_result: JSON.stringify(areas.tree_test || {}),
      projective_story_result: JSON.stringify(areas.projective || {}),
      scaling_score: areas.scaling?.score || 0,
      reality_testing_ok: (areas.reality_testing?.score || 0) >= 7,
    });

    // Update crisis_events
    await sb.from("crisis_events").update({
      diagnostic_score: totalScore,
      diagnostic_report: result.overall_assessment,
      diagnostic_date: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", crisisId);

    // Trigger phase change based on score
    if (totalScore >= 65) {
      const evalUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/evaluate-crisis`;
      await fetch(evalUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${srvKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ crisisId, forcePhaseChange: "closing" }),
      });
    } else if (totalScore < 31) {
      const evalUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/evaluate-crisis`;
      await fetch(evalUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${srvKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ crisisId, forcePhaseChange: "acute" }),
      });
    }

    return new Response(JSON.stringify({ success: true, ...result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[crisis-diagnostic] Error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
