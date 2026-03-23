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

    const { clientId } = await req.json();
    if (!clientId) throw new Error("clientId required");

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // Fetch everything
    const [clientRes, sessionsRes, tasksRes] = await Promise.all([
      supabase.from("clients").select("*").eq("id", clientId).single(),
      supabase.from("client_sessions").select("*").eq("client_id", clientId).order("session_date", { ascending: false }),
      supabase.from("client_tasks").select("*").eq("client_id", clientId),
    ]);

    const client = clientRes.data;
    if (!client) throw new Error("Client not found");
    const sessions = sessionsRes.data || [];
    const tasks = tasksRes.data || [];

    const isCardEmpty = !client.diagnosis && !client.key_history && !client.family_context && !client.notes;
    if (sessions.length === 0 && isCardEmpty) {
      return new Response(JSON.stringify({
        error: null,
        result: {
          clientProfile: "Karta klienta je prázdná a nejsou žádná sezení. Doplň kartu nebo proveď první sezení.",
          diagnosticHypothesis: { primary: "", differential: [], confidence: "low", supportingEvidence: [], sources: [] },
          therapeuticProgress: { whatWorks: [], whatDoesntWork: [], clientDynamics: "" },
          nextSessionRecommendations: { focus: [], suggestedTechniques: [], diagnosticTests: [], thingsToAsk: [] },
          dataGaps: ["diagnóza", "anamnéza", "rodinný kontext", "alespoň jedno sezení"],
        },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const sessionsContext = sessions.slice(0, 15).map((s: any, i: number) =>
      `--- Sezení ${sessions.length - i} (${s.session_date}) ---\n${s.ai_analysis?.slice(0, 500) || s.notes || "(bez záznamu)"}\n${s.ai_hypotheses ? `Analýza: ${s.ai_hypotheses.slice(0, 300)}` : ""}`
    ).join("\n\n");

    const tasksContext = tasks.map((t: any) =>
      `- [${t.status}] ${t.task}${t.result ? ` → ${t.result}` : ""}`
    ).join("\n");

    // Perplexity search (parallel, optional)
    let perplexityInsights = "";
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    if (PERPLEXITY_API_KEY && client.diagnosis) {
      try {
        const pplxRes = await Promise.race([
          fetch("https://api.perplexity.ai/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "sonar-pro",
              messages: [
                { role: "system", content: "Jsi výzkumný asistent. Odpovídej česky, stručně, s citacemi." },
                { role: "user", content: `Najdi aktuální evidence-based doporučení pro diagnostiku a terapii: ${client.diagnosis}. Zaměř se na diferenciální diagnostiku a doporučené metody pro děti/adolescenty.` },
              ],
            }),
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Perplexity timeout")), 25000)),
        ]) as Response;

        if (pplxRes.ok) {
          const pplxData = await pplxRes.json();
          perplexityInsights = pplxData.choices?.[0]?.message?.content || "";
        }
      } catch (e) {
        console.error("Perplexity search failed:", e);
      }
    }

    const systemPrompt = `Jsi Karel, klinický supervizor s 30letou praxí. Analyzuj kompletní kartu klienta a vytvoř komplexní klinický obraz.

DŮLEŽITÉ: Terapeutka se jmenuje HANIČKA (Hanka). Oslovuj ji „Hani" nebo „Haničko". NIKDY ji neoslovuj jménem klienta. Klient a terapeutka jsou dvě různé osoby.

KRITICKÉ PRAVIDLO: Vycházej VÝHRADNĚ z dat níže. NEVYMÝŠLEJ si fakta. Pokud něco chybí, uveď to v dataGaps.

KLIENT: ${client.name}
${client.age ? `Věk: ${client.age}` : ""}
${client.gender ? `Pohlaví: ${client.gender}` : ""}
${client.diagnosis ? `Diagnóza: ${client.diagnosis}` : ""}
${client.therapy_type ? `Typ terapie: ${client.therapy_type}` : ""}
${client.referral_source ? `Zdroj doporučení: ${client.referral_source}` : ""}
${client.key_history ? `Anamnéza: ${client.key_history}` : ""}
${client.family_context ? `Rodinný kontext: ${client.family_context}` : ""}
${client.notes ? `Poznámky: ${client.notes}` : ""}
${client.therapy_plan ? `\nTERAPEUTICKÝ PLÁN PROCESU:\n${client.therapy_plan.slice(0, 1000)}` : ""}

SEZENÍ (${sessions.length}):
${sessionsContext || "(žádná)"}

ÚKOLY:
${tasksContext || "(žádné)"}

${perplexityInsights ? `\nRESEARCH INSIGHTS (Perplexity):\n${perplexityInsights}` : ""}

Vrať validní JSON:
{
  "clientProfile": "kdo je klient – shrnutí profilu",
  "diagnosticHypothesis": {
    "primary": "primární hypotéza",
    "differential": ["diferenciální diagnózy"],
    "confidence": "low|medium|high",
    "supportingEvidence": ["podpůrné důkazy z dat"],
    "sources": ["zdroje z research"]
  },
  "therapeuticProgress": {
    "whatWorks": ["co funguje"],
    "whatDoesntWork": ["co nefunguje"],
    "clientDynamics": "popis dynamiky"
  },
  "nextSessionRecommendations": {
    "focus": ["zaměření"],
    "suggestedTechniques": ["techniky"],
    "diagnosticTests": ["doporučené testy"],
    "thingsToAsk": ["otázky k položení"]
  },
  "dataGaps": ["co v kartě chybí"]
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
          { role: "user", content: "Analyzuj kartu klienta a vrať JSON." },
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

    let result: any;
    const fallbackResult = { clientProfile: "Analýza není k dispozici", diagnosticHypothesis: { primary: "", differential: [], confidence: "low", supportingEvidence: [], sources: [] }, therapeuticProgress: { whatWorks: [], whatDoesntWork: [], clientDynamics: "" }, nextSessionRecommendations: { focus: [], suggestedTechniques: [], diagnosticTests: [], thingsToAsk: [] }, dataGaps: [] };
    try {
      // Strip markdown fences
      const stripped = rawContent.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
      result = JSON.parse(stripped);
    } catch {
      // Try extracting JSON object from mixed text (AI sometimes wraps JSON in conversational text)
      try {
        const firstBrace = rawContent.indexOf("{");
        const lastBrace = rawContent.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          result = JSON.parse(rawContent.slice(firstBrace, lastBrace + 1));
        } else {
          result = fallbackResult;
        }
      } catch {
        // Try embedded ```json block
        const embeddedMatch = rawContent.match(/```json\s*([\s\S]*?)```/);
        if (embeddedMatch) {
          try {
            result = JSON.parse(embeddedMatch[1].trim());
          } catch {
            result = fallbackResult;
          }
        } else {
          result = fallbackResult;
        }
      }
    }

    return new Response(JSON.stringify({ result, sessionsCount: sessions.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("karel-card-analysis error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
