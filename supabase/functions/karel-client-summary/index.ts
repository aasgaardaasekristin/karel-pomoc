import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing auth");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");

    const { clientId } = await req.json();
    if (!clientId) throw new Error("clientId required");

    // Fetch client + sessions
    const [clientRes, sessionsRes] = await Promise.all([
      supabase.from("clients").select("*").eq("id", clientId).single(),
      supabase.from("client_sessions")
        .select("*")
        .eq("client_id", clientId)
        .order("session_date", { ascending: false }),
    ]);

    const client = clientRes.data;
    const sessions = sessionsRes.data || [];

    if (!client) throw new Error("Client not found");

    if (sessions.length === 0) {
      return new Response(JSON.stringify({
        caseSummary: `${client.name} – nový klient, zatím žádná sezení v kartotéce.${client.diagnosis ? ` Diagnóza: ${client.diagnosis}.` : ""}${client.age ? ` Věk: ${client.age}.` : ""}`,
        lastSessionSummary: null,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Build context for AI
    const clientInfo = [
      `Jméno: ${client.name}`,
      client.age ? `Věk: ${client.age}` : null,
      client.gender ? `Pohlaví: ${client.gender}` : null,
      client.diagnosis ? `Diagnóza: ${client.diagnosis}` : null,
      client.therapy_type ? `Typ terapie: ${client.therapy_type}` : null,
      client.key_history ? `Klíčová anamnéza: ${client.key_history}` : null,
      client.family_context ? `Rodinný kontext: ${client.family_context}` : null,
      client.referral_source ? `Zdroj doporučení: ${client.referral_source}` : null,
      client.notes ? `Poznámky: ${client.notes}` : null,
    ].filter(Boolean).join("\n");

    const sessionSummaries = sessions.slice(0, 20).map((s, i) => {
      const parts = [
        `Sezení ${sessions.length - i} (${s.session_date})`,
        s.report_key_theme ? `Téma: ${s.report_key_theme}` : null,
        s.report_context ? `Kontext: ${s.report_context}` : null,
        s.ai_analysis ? `AI analýza: ${s.ai_analysis.slice(0, 500)}` : null,
        s.report_risks?.length ? `Rizika: ${s.report_risks.join(", ")}` : null,
        s.report_next_session_goal ? `Cíl příštího sezení: ${s.report_next_session_goal}` : null,
        s.voice_analysis ? `Hlasová analýza: ${s.voice_analysis.slice(0, 300)}` : null,
      ].filter(Boolean).join("\n");
      return parts;
    }).join("\n\n---\n\n");

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const prompt = `Jsi Karel, klinický supervizor. Na základě údajů z karty klienta a záznamů ze sezení vytvoř DVĚ stručná shrnutí v češtině:

1. **Shrnutí případu** (1 odstavec, max 150 slov): Základní údaje o klientovi, hlavní diagnóza/téma, klíčové vzorce z celé historie sezení, kde se terapie aktuálně nachází.

2. **Poslední sezení** (1 odstavec, max 80 slov): Co se dělo na posledním sezení, klíčové téma, jak klient reagoval, kam směřovat příště.

Vrať JSON: { "caseSummary": "...", "lastSessionSummary": "..." }

KARTA KLIENTA:
${clientInfo}

ZÁZNAMY ZE SEZENÍ (${sessions.length} celkem):
${sessionSummaries}`;

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "Jsi klinický supervizor Karel. Piš stručně, odborně, v češtině." },
          { role: "user", content: prompt },
        ],
        tools: [{
          type: "function",
          function: {
            name: "client_summary",
            description: "Return case and last session summaries",
            parameters: {
              type: "object",
              properties: {
                caseSummary: { type: "string", description: "Overall case summary paragraph" },
                lastSessionSummary: { type: "string", description: "Last session summary paragraph" },
              },
              required: ["caseSummary", "lastSessionSummary"],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "client_summary" } },
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error("AI error:", aiRes.status, errText);
      // Fallback: return basic summary without AI
      const fallback = `${client.name}${client.age ? `, ${client.age} let` : ""}. ${sessions.length} sezení.${client.diagnosis ? ` Diagnóza: ${client.diagnosis}.` : ""}`;
      const lastS = sessions[0];
      return new Response(JSON.stringify({
        caseSummary: fallback,
        lastSessionSummary: lastS?.report_key_theme ? `Téma: ${lastS.report_key_theme}. ${lastS.report_context || ""}`.trim() : null,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const aiData = await aiRes.json();
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    
    let result;
    if (toolCall?.function?.arguments) {
      result = JSON.parse(toolCall.function.arguments);
    } else {
      // Try parsing content as JSON
      const content = aiData.choices?.[0]?.message?.content || "";
      try {
        result = JSON.parse(content.replace(/```json\n?/g, "").replace(/```/g, "").trim());
      } catch {
        result = { caseSummary: content, lastSessionSummary: null };
      }
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("karel-client-summary error:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
