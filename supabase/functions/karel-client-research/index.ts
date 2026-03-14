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

    const { clientId, clientName, sessionReport, messages, mode } = await req.json();
    
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // Fetch all client data
    const [clientRes, sessionsRes] = await Promise.all([
      supabase.from("clients").select("*").eq("id", clientId).single(),
      supabase.from("client_sessions").select("*").eq("client_id", clientId).order("session_date", { ascending: false }),
    ]);

    const client = clientRes.data;
    const sessions = sessionsRes.data || [];

    const clientContext = [
      client?.name ? `Klient: ${client.name}` : `Klient: ${clientName}`,
      client?.age ? `Věk: ${client.age}` : null,
      client?.diagnosis ? `Diagnóza: ${client.diagnosis}` : null,
      client?.therapy_type ? `Typ terapie: ${client.therapy_type}` : null,
      client?.key_history ? `Anamnéza: ${client.key_history}` : null,
    ].filter(Boolean).join("\n");

    const methodsUsed = sessions
      .map(s => s.report_interventions_tried || s.ai_analysis?.match(/(?:metod|technik|interven)[^\n]*/gi)?.join(", "))
      .filter(Boolean)
      .join("; ");

    // If chat mode (follow-up), stream via Lovable AI
    if (mode === "chat" && messages?.length > 0) {
      const systemPrompt = `Jsi Karel, klinický supervizor specializovaný na výzkum nových terapeutických přístupů. Máš k dispozici plnou historii klienta. Pomáháš terapeutce najít nové metody, testy a techniky, které se s tímto klientem ještě nezkoušely.

KONTEXT KLIENTA:
${clientContext}

VYZKOUŠENÉ METODY:
${methodsUsed || "Žádné zaznamenané"}

POSLEDNÍ ZÁPIS:
${sessionReport?.slice(0, 1000) || "Nedostupný"}

Odpovídej v češtině, odborně ale přístupně. Doporučuj konkrétní metody s odkazy na studie.`;

      const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: systemPrompt },
            ...messages,
          ],
          stream: true,
        }),
      });

      if (!response.ok) throw new Error(`AI error: ${response.status}`);
      return new Response(response.body, {
        headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
      });
    }

    // Initial analysis - use Perplexity if available, otherwise Lovable AI
    let researchResults = "";

    if (PERPLEXITY_API_KEY) {
      const searchQuery = `nové terapeutické metody pro ${client?.diagnosis || "klinický případ"} ${client?.age ? `věk ${client.age}` : ""} - psychoterapie moderní přístupy evidence-based 2024 2025`;

      const perplexityRes = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "sonar-pro",
          messages: [
            {
              role: "system",
              content: "Jsi odborný výzkumník v oblasti psychoterapie. Hledej nejnovější evidence-based metody, testy a přístupy relevantní pro daný klinický případ. Odpovídej v češtině.",
            },
            {
              role: "user",
              content: `Klient: ${clientContext}\n\nJiž vyzkoušené metody: ${methodsUsed || "neznámé"}\n\nNajdi nové metody, testy nebo přístupy, které by mohly pomoci a které se ještě nezkoušely. Zaměř se na: 1) Nové terapeutické techniky, 2) Diagnostické nástroje, 3) Evidence-based intervence, 4) Experimentální přístupy z poslední doby.`,
            },
          ],
          search_recency_filter: "year",
        }),
      });

      if (perplexityRes.ok) {
        const pData = await perplexityRes.json();
        researchResults = pData.choices?.[0]?.message?.content || "";
        const citations = pData.citations || [];
        if (citations.length > 0) {
          researchResults += "\n\n**Zdroje:**\n" + citations.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n");
        }
      }
    }

    // Synthesize with Lovable AI
    const synthesisPrompt = `Jsi Karel, klinický supervizor. Terapeutka chce poradit se na internetu o novém přístupu k jejímu klientovi.

KONTEXT KLIENTA:
${clientContext}

VYZKOUŠENÉ METODY:
${methodsUsed || "Žádné zaznamenané"}

POSLEDNÍ ZÁPIS:
${sessionReport?.slice(0, 1500) || "Nedostupný"}

${researchResults ? `VÝSLEDKY REŠERŠE Z INTERNETU:\n${researchResults}` : ""}

Napiš terapeutce přehled:
1. **Co už se zkusilo** (stručný seznam)
2. **Nové doporučené přístupy** (3-5 konkrétních metod/technik s popisem, které se ještě nezkusily)
3. **Diagnostické nástroje** (testy, dotazníky k zvážení)
4. **Experimentální přístupy** (pokud relevantní)
5. **Doporučený další krok** (co konkrétně udělat příště)

Piš v češtině, odborně ale přístupně. Buď konkrétní – uveď názvy metod, autory, studie.`;

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "Jsi Karel, odborný klinický supervizor. Piš v češtině." },
          { role: "user", content: synthesisPrompt },
        ],
      }),
    });

    if (!aiRes.ok) throw new Error(`AI error: ${aiRes.status}`);
    const aiData = await aiRes.json();
    const response = aiData.choices?.[0]?.message?.content || "";

    return new Response(JSON.stringify({ response }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("karel-client-research error:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
