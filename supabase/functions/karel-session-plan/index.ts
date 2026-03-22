import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing auth");

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");

    const { clientId, baseAnalysis, customRequest, modificationsRequested } = await req.json();
    if (!clientId) throw new Error("clientId required");

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const [clientRes, sessionsRes] = await Promise.all([
      supabase.from("clients").select("*").eq("id", clientId).single(),
      supabase.from("client_sessions").select("*").eq("client_id", clientId).order("session_date", { ascending: false }).limit(5),
    ]);

    const client = clientRes.data;
    if (!client) throw new Error("Client not found");
    const sessions = sessionsRes.data || [];
    const nextSessionNum = sessions.length + 1;

    const lastSessionContext = sessions[0]
      ? `Poslední sezení (${sessions[0].session_date}):\n${sessions[0].ai_analysis?.slice(0, 500) || sessions[0].notes || "(bez záznamu)"}\nCíl příště: ${sessions[0].report_next_session_goal || "(neuvedeno)"}`
      : "(žádné předchozí sezení)";

    const analysisContext = baseAnalysis
      ? `\nANALÝZA KARTY:\nProfil: ${baseAnalysis.clientProfile?.slice(0, 300) || ""}\nDoporučení: ${JSON.stringify(baseAnalysis.nextSessionRecommendations || {})}`
      : "";

    const systemPrompt = `Jsi Karel, klinický supervizor. Sestav kompletní 60minutový plán sezení pro terapeuta.

KLIENT: ${client.name}
${client.age ? `Věk: ${client.age}` : ""}
${client.diagnosis ? `Diagnóza: ${client.diagnosis}` : ""}
${client.therapy_type ? `Typ terapie: ${client.therapy_type}` : ""}
${client.key_history ? `Anamnéza: ${client.key_history}` : ""}
${client.family_context ? `Rodinný kontext: ${client.family_context}` : ""}

${lastSessionContext}
${analysisContext}
${customRequest ? `\nSPECIÁLNÍ POŽADAVEK TERAPEUTA: ${customRequest}` : ""}
${modificationsRequested ? `\nÚPRAVY NÁVRHU: ${modificationsRequested}` : ""}

KRITICKÉ PRAVIDLO: Buď KONKRÉTNÍ. Uveď přesné věty, které má terapeut říct. Uveď přesné pomůcky. Uveď co dělat, když klient odmítne.

Vrať validní JSON:
{
  "sessionGoal": "hlavní cíl sezení",
  "phases": [
    {
      "timeStart": "00:00", "timeEnd": "05:00",
      "name": "Zahájení",
      "technique": "technika",
      "procedure": ["krok 1", "krok 2"],
      "howToStart": "konkrétní věta pro terapeuta",
      "watchFor": ["čeho si všímat"]
    },
    {
      "timeStart": "05:00", "timeEnd": "20:00",
      "name": "Hlavní téma",
      "topic": "téma",
      "technique": "technika",
      "whyThisTechnique": "zdůvodnění",
      "procedure": ["krok 1", "krok 2"],
      "supplies": ["pomůcky"],
      "triggers": ["na co si dát pozor"],
      "fallback": "co dělat pokud klient odmítne"
    },
    {
      "timeStart": "20:00", "timeEnd": "45:00",
      "name": "Aktivita",
      "activityName": "název aktivity",
      "clientInstruction": "přesně co říct klientovi",
      "supplies": ["pomůcky"],
      "procedure": ["krok 1"],
      "observationGuide": ["co pozorovat"],
      "fallback": "alternativa"
    },
    {
      "timeStart": "45:00", "timeEnd": "55:00",
      "name": "Zpracování",
      "questions": ["otevřené otázky"],
      "avoid": ["co neptat a proč"]
    },
    {
      "timeStart": "55:00", "timeEnd": "60:00",
      "name": "Uzavření",
      "closingTechnique": "technika",
      "closingPhrase": "konkrétní věta",
      "homeworkForClient": "domácí úkol nebo null"
    }
  ],
  "whyThisPlan": "zdůvodnění celého plánu"
}`;

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-pro",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Sestav plán sezení č. ${nextSessionNum} pro klienta ${client.name}.` },
        ],
      }),
    });

    if (!aiRes.ok) {
      if (aiRes.status === 429) return new Response(JSON.stringify({ error: "Rate limit" }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      if (aiRes.status === 402) return new Response(JSON.stringify({ error: "Nedostatek kreditů" }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      throw new Error(`AI error: ${aiRes.status}`);
    }

    const aiData = await aiRes.json();
    const rawContent = aiData.choices?.[0]?.message?.content || "";

    let plan: any;
    try {
      const jsonStr = rawContent.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      plan = JSON.parse(jsonStr);
    } catch {
      plan = { sessionGoal: "Plán nebyl vygenerován ve správném formátu", phases: [], whyThisPlan: rawContent };
    }

    return new Response(JSON.stringify({ plan, sessionNumber: nextSessionNum }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("karel-session-plan error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
