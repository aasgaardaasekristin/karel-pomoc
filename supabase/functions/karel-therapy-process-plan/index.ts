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

    const { clientId, cardAnalysis, modifications } = await req.json();
    if (!clientId) throw new Error("clientId required");

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // Fetch client data
    const [clientRes, sessionsRes, tasksRes] = await Promise.all([
      supabase.from("clients").select("*").eq("id", clientId).single(),
      supabase.from("client_sessions").select("*").eq("client_id", clientId).order("session_date", { ascending: false }).limit(15),
      supabase.from("client_tasks").select("*").eq("client_id", clientId),
    ]);

    const client = clientRes.data;
    if (!client) throw new Error("Client not found");
    const sessions = sessionsRes.data || [];
    const tasks = tasksRes.data || [];

    const clientContext = [
      `KLIENT: ${client.name}`,
      client.age ? `Věk: ${client.age}` : null,
      client.gender ? `Pohlaví: ${client.gender}` : null,
      client.diagnosis ? `Diagnóza: ${client.diagnosis}` : null,
      client.therapy_type ? `Typ terapie: ${client.therapy_type}` : null,
      client.referral_source ? `Zdroj doporučení: ${client.referral_source}` : null,
      client.key_history ? `Klíčová anamnéza: ${client.key_history}` : null,
      client.family_context ? `Rodinný kontext: ${client.family_context}` : null,
      client.notes ? `Poznámky: ${client.notes}` : null,
    ].filter(Boolean).join("\n");

    const sessionsContext = sessions.slice(0, 10).map((s: any, i: number) =>
      `--- Sezení ${sessions.length - i} (${s.session_date}) ---\n${s.ai_analysis?.slice(0, 400) || s.notes || "(bez záznamu)"}`
    ).join("\n\n");

    const tasksContext = tasks.map((t: any) =>
      `- [${t.status}] ${t.task}${t.result ? ` → ${t.result}` : ""}`
    ).join("\n");

    const existingPlan = client.therapy_plan || "";

    // Perplexity research (optional)
    let researchInsights = "";
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    if (PERPLEXITY_API_KEY && client.diagnosis) {
      try {
        const pplxRes = await Promise.race([
          fetch("https://api.perplexity.ai/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "sonar-pro",
              messages: [
                { role: "system", content: "Jsi výzkumný asistent pro klinickou psychologii. Odpovídej česky, stručně, s citacemi." },
                { role: "user", content: `Najdi evidence-based doporučení pro dlouhodobý terapeutický plán: ${client.diagnosis}. Zaměř se na doporučené terapeutické směry, metody, techniky a fáze terapie${client.age ? ` pro klienta věk ${client.age}` : ""}.` },
              ],
            }),
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 25000)),
        ]) as Response;
        if (pplxRes.ok) {
          const d = await pplxRes.json();
          researchInsights = d.choices?.[0]?.message?.content || "";
        }
      } catch (e) {
        console.error("Perplexity failed:", e);
      }
    }

    const isModification = !!modifications && existingPlan;

    const systemPrompt = isModification
      ? `Jsi Karel, klinický supervizor s 30letou praxí. Terapeut požádal o úpravu existujícího terapeutického plánu procesu.

EXISTUJÍCÍ PLÁN:
${existingPlan.slice(0, 3000)}

POŽADAVKY NA ÚPRAVU:
${modifications}

${clientContext}

SEZENÍ (${sessions.length}):
${sessionsContext || "(žádná)"}

ÚKOLY:
${tasksContext || "(žádné)"}

${researchInsights ? `\nRESEARCH INSIGHTS:\n${researchInsights.slice(0, 2000)}` : ""}

Uprav plán podle požadavků terapeuta. Zachovej strukturu. Vrať POUZE markdown text upraveného plánu.`
      : `Jsi Karel, klinický supervizor s 30letou praxí. Na základě kompletní karty klienta sestav CELKOVÝ TERAPEUTICKÝ PLÁN PROCESU – dlouhodobý odborný plán psychoterapie.

${clientContext}

SEZENÍ (${sessions.length}):
${sessionsContext || "(žádná)"}

ÚKOLY:
${tasksContext || "(žádné)"}

${cardAnalysis ? `\nANALÝZA KARTY:\nProfil: ${cardAnalysis.clientProfile?.slice(0, 500) || ""}\nDiagnostika: ${cardAnalysis.diagnosticHypothesis?.primary || ""}\nCo funguje: ${cardAnalysis.therapeuticProgress?.whatWorks?.join(", ") || ""}\nCo nefunguje: ${cardAnalysis.therapeuticProgress?.whatDoesntWork?.join(", ") || ""}` : ""}

${researchInsights ? `\nRESEARCH INSIGHTS:\n${researchInsights.slice(0, 2000)}` : ""}

KRITICKÉ PRAVIDLO: Vycházej VÝHRADNĚ z dat výše. NEVYMÝŠLEJ si fakta.

Sestav plán v tomto formátu (markdown):

# Terapeutický plán procesu – ${client.name}

## 🎯 Cíle terapie
### Krátkodobé cíle (1-3 měsíce)
- ...
### Střednědobé cíle (3-6 měsíců)
- ...
### Dlouhodobé cíle (6-12+ měsíců)
- ...

## 🧭 Doporučený terapeutický směr/přístup
- Primární přístup a zdůvodnění
- Doplňkové přístupy

## 🛠️ Metody a techniky
- Konkrétní terapeutické techniky s popisem použití
- Diagnostické nástroje k průběžnému hodnocení

## 📅 Fáze terapie
### Fáze 1: ... (orientační délka)
### Fáze 2: ...
### Fáze 3: ...

## ⚠️ Rizika a kontraindikace
- ...

## ✅ Kritéria úspěchu a ukončení terapie
- Měřitelné indikátory pokroku
- Podmínky pro ukončení

## 📚 Doporučená literatura a zdroje
- ...

Vrať POUZE markdown text plánu, nic jiného.`;

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
          { role: "user", content: isModification ? "Uprav plán podle požadavků." : "Sestav celkový terapeutický plán procesu." },
        ],
        stream: true,
      }),
    });

    if (!aiRes.ok) {
      if (aiRes.status === 429) return new Response(JSON.stringify({ error: "Rate limit" }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      if (aiRes.status === 402) return new Response(JSON.stringify({ error: "Nedostatek kreditů" }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      throw new Error(`AI error: ${aiRes.status}`);
    }

    return new Response(aiRes.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("karel-therapy-process-plan error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
