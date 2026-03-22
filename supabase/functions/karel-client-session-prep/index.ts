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

    const { clientId, clientName, duration, additionalInfo, focusArea } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");

    // ── Fetch client data ──
    const [clientRes, sessionsRes, tasksRes] = await Promise.all([
      supabase.from("clients").select("*").eq("id", clientId).single(),
      supabase.from("client_sessions").select("*").eq("client_id", clientId).order("session_date", { ascending: false }).limit(10),
      supabase.from("client_tasks").select("*").eq("client_id", clientId).eq("status", "planned"),
    ]);

    const client = clientRes.data;
    const sessions = sessionsRes.data || [];
    const activeTasks = tasksRes.data || [];

    // Soft guard — warning for empty cards
    const isCardEmpty = !client?.diagnosis && !client?.key_history && !client?.family_context && !client?.notes;
    const emptyCardWarning = (sessions.length === 0 && isCardEmpty)
      ? "\n\n⚠️ UPOZORNĚNÍ: Karta klienta je prázdná a nemáš žádná předchozí sezení. Generuješ POUZE obecný plán. Řekni terapeutce, že plán bude přesnější po doplnění karty."
      : "";

    // Build client context
    const clientContext = [
      `KLIENT: ${clientName}`,
      client?.age ? `Věk: ${client.age}` : null,
      client?.gender ? `Pohlaví: ${client.gender}` : null,
      client?.diagnosis ? `Diagnóza: ${client.diagnosis}` : null,
      client?.therapy_type ? `Typ terapie: ${client.therapy_type}` : null,
      client?.key_history ? `Klíčová anamnéza: ${client.key_history}` : null,
      client?.family_context ? `Rodinný kontext: ${client.family_context}` : null,
      client?.notes ? `Poznámky: ${client.notes}` : null,
    ].filter(Boolean).join("\n");

    const sessionsContext = sessions.slice(0, 8).map((s, i) => {
      return [
        `--- Sezení ${sessions.length - i} (${s.session_date}) ---`,
        s.report_key_theme ? `Téma: ${s.report_key_theme}` : null,
        s.report_context ? `Kontext: ${s.report_context}` : null,
        s.ai_analysis ? `Analýza: ${s.ai_analysis.slice(0, 500)}` : null,
        s.report_next_session_goal ? `Cíl příštího sezení: ${s.report_next_session_goal}` : null,
        s.report_interventions_tried ? `Intervence: ${s.report_interventions_tried}` : null,
        s.report_risks?.length ? `Rizika: ${s.report_risks.join(", ")}` : null,
        s.ai_recommended_methods ? `Doporučené metody: ${s.ai_recommended_methods.slice(0, 300)}` : null,
      ].filter(Boolean).join("\n");
    }).join("\n\n");

    const tasksContext = activeTasks.length > 0
      ? "AKTIVNÍ ÚKOLY:\n" + activeTasks.map(t => `- ${t.task}${t.method ? ` (${t.method})` : ""}`).join("\n")
      : "";

    // ── Perplexity research (if available) ──
    let researchContext = "";
    if (PERPLEXITY_API_KEY && client?.diagnosis) {
      try {
        const searchQuery = [
          `Nejlepší terapeutické strategie a aktivity pro ${client.diagnosis}`,
          client.age ? `pro klienta věk ${client.age}` : "",
          focusArea ? `zaměření na ${focusArea}` : "",
          `evidence-based přístupy, konkrétní techniky, hry a aktivity`,
        ].filter(Boolean).join(", ");

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
                content: "Jsi odborný rešeršní asistent pro klinickou psychologii a psychoterapii. Hledej nejnovější evidence-based přístupy, konkrétní terapeutické techniky, aktivity a hry vhodné pro daný případ. Zaměř se na praktické techniky s popisem provedení.",
              },
              { role: "user", content: searchQuery },
            ],
          }),
        });

        if (perplexityRes.ok) {
          const pData = await perplexityRes.json();
          researchContext = pData.choices?.[0]?.message?.content || "";
          if (researchContext) {
            researchContext = `\n\n═══ VÝSLEDKY REŠERŠE (aktuální vědecké zdroje) ═══\n${researchContext.slice(0, 4000)}`;
          }
        }
      } catch (e) {
        console.error("Perplexity search failed:", e);
      }
    }

    // ── Generate session plan ──
    const systemPrompt = `Jsi Karel – zkušený klinický supervizor a terapeut s 30letou praxí. Připravuješ KONKRÉTNÍ a PODROBNÝ plán sezení pro terapeutku Haničku.

═══ TVŮJ ÚKOL ═══

Sestav detailní plán terapeutického sezení (${duration} minut) na míru klientovi. Plán musí být prakticky proveditelný a okamžitě použitelný.

═══ STRUKTURA PLÁNU ═══

## 🎯 Cíle sezení
- Hlavní cíl sezení
- Vedlejší cíle (2-3)

## 📋 Plán sezení (${duration} min)

Pro každou aktivitu uveď:
### [Čas] Název aktivity (X min)
**Co:** Přesný popis, co terapeutka dělá
**Proč:** Terapeutické zdůvodnění
**Na co si dát pozor:** Specifické pokyny pro pozorování
**Materiály:** Co je potřeba připravit

Zahrň:
1. Úvod a navázání kontaktu (check-in)
2. Hlavní terapeutická aktivita (s diagnostickými prvky schovanými do přirozené činnosti)
3. Případně 2. aktivita
4. Reflexe a uzavření

## 🔍 Skryté diagnostické prvky
- Které testy/metody jsou zabudovány do aktivit
- Na co přesně si má Hanka všímat a proč
- Jak interpretovat různé reakce klienta

## ⚠️ Na co si dát pozor
- Specifická rizika pro tohoto klienta
- Možné triggery a jak na ně reagovat
- Signály, které nesmí přehlédnout

## 📚 Odborné zdroje a doporučení
- Relevantní literatura a studie
- Doporučené metody pro další práci

## 💡 Otázky pro příští sezení
- Konkrétní otázky ke zjištění pokroku

═══ ZÁSADY ═══

- Aktivity přizpůsob věku klienta
- Používej konkrétní techniky (CBT, narativní, projektivní, herní, arteterapi apod.) podle potřeby
- Diagnostické metody schovej do přirozených aktivit přiměřených věku
- Buď KONKRÉTNÍ – ne obecné rady, ale přesné pokyny co říct, co udělat
- Pokud máš málo informací, řekni to a navrhni, co zjistit
- Oslovuj Haničku přímo: "Hani, začni tím, že..."`;

    const userPrompt = [
      clientContext,
      sessionsContext ? `\n\nHISTORIE SEZENÍ:\n${sessionsContext}` : "",
      tasksContext ? `\n\n${tasksContext}` : "",
      researchContext,
      additionalInfo ? `\n\nNOVÉ INFORMACE OD TERAPEUTKY:\n${additionalInfo}` : "",
      focusArea ? `\n\nZAMĚŘENÍ SEZENÍ:\n${focusArea}` : "",
      `\n\nPřiprav detailní plán sezení na ${duration} minut.`,
    ].join("");

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
          { role: "user", content: userPrompt },
        ],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "AI je momentálně přetížené, zkus to za chvíli." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw new Error(`AI error: ${response.status}`);
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("karel-client-session-prep error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
