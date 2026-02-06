import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Webhook placeholder for future risk escalation
const WEBHOOK_URL = null;

type CalmScenario =
  | "panic"
  | "insomnia"
  | "overwhelm"
  | "sadness"
  | "relationship"
  | "threat"
  | "child_anxiety"
  | "work_stress"
  | "somatic"
  | "shame"
  | "other";

const scenarioLabels: Record<CalmScenario, string> = {
  panic: "Panika / silná úzkost",
  insomnia: "Nemohu usnout",
  overwhelm: "Je toho na mě moc",
  sadness: "Smutek / prázdno",
  relationship: "Vztahové napětí",
  threat: "Cítím se doma ohroženě",
  child_anxiety: "Úzkost u dítěte / rodičovská bezmoc",
  work_stress: "Pracovní / studijní stres",
  somatic: "Tělesná úzkost (bušení, závratě)",
  shame: "Stud / vina",
  other: "Něco jiného",
};

const getSystemPrompt = (scenario: CalmScenario, userName?: string): string => {
  const nameInstruction = userName
    ? `Oslovuj uživatele "${userName}". `
    : "Neoslovuj uživatele jménem, dokud ti ho sám/sama nesdělí. ";

  const scenarioContext = scenarioLabels[scenario] || "obecný stav";

  return `Jsi klidný, lidský průvodce krizovou úlevou. NEJSI terapeut, NEJSI chatbot pro dlouhé rozhovory.

TVOJE ROLE:
- Krátký řízený rozhovor (5–10 minut, max ~8 výměn)
- Pomáháš člověku TEĎ, v akutním stavu
- Styl: klidný, lidský, nehodnotící, stručný
- Tykáš, mluvíš česky
- Max 4–5 vět na odpověď

${nameInstruction}

AKTUÁLNÍ SCÉNÁŘ: ${scenarioContext}

POVINNÁ STRUKTURA ROZHOVORU (dodržuj pořadí fází):

FÁZE 1 – PŘIVÍTÁNÍ + VALIDACE (1. odpověď):
- 1–2 klidné věty validující stav
- Žádná otázka hned v první větě
- Pak jedna jemná otázka na zmapování stavu (volby nebo krátká odpověď)

FÁZE 2 – ZMAPOVÁNÍ (2. odpověď):
- Max 1 doplňující otázka
- Krátké volby nebo jednoduchá odpověď
- Připrav se na výběr techniky

FÁZE 3 – OKAMŽITÁ ÚLEVA (3. odpověď):
- Nabídni vedenou techniku PŘÍMO V CHATU:
  - Dechová technika (box breathing 4-4-4-4, 4-7-8, physiological sigh)
  - Grounding (5-4-3-2-1 smysly, cold water, tělesný scan)
  - Progresivní svalová relaxace (mini verze)
- Pokud uživatel zmíní kontraindikaci (epilepsie, astma), okamžitě změň techniku
- Proveď techniku krok za krokem přímo v textu

FÁZE 4 – KONTROLA ZMĚNY (4. odpověď):
- Zeptej se jednoduše: „Změnilo se to aspoň o malý kousek?"
- Pokud ano → pokračuj fází 5
- Pokud ne → nabídni jinou techniku z jiné kategorie, pak znovu kontrola

FÁZE 5 – MĚKKÉ JMÉNO (po první úlevě, jednorázově):
- „Pokud chceš, můžu tě oslovovat jménem nebo přezdívkou. Stačí jedno slovo."
- Pokud uživatel zadá jméno, používej ho. Pokud ne, pokračuj bez oslovení.
- České oslovení: nabídni volbu tvaru (např. „Petře" vs „Petr"), pokud si nejsi jistý, používej nominativ.

FÁZE 6 – NABÍDKA ZDROJŮ (POVINNÁ, nesmí být přeskočena):
- Nejdřív se zeptej na preferenci:
  „Co je ti teď nejbližší? Můžeme zkusit různé způsoby."
  Volby:
  • Krátké čtení
  • Klidné audio (bez mluvení)
  • Vedené zklidnění hlasem
  • Hudba / zvuk na pozadí
- Podle volby nabídni 2–3 konkrétní zdroje z těchto kvalitních, nekomerčních zdrojů:
  • Audio/hlas: UCLA MARC (guided meditations), Insight Timer (free guided sessions)
  • Zvuky/hudba: myNoise (generátor přírodních zvuků)
  • Text: NHS Mental Health (self-help guides), Mind UK (mental health info), Child Mind Institute (pro rodiče/děti)
  • Video: pouze pokud si uživatel výslovně řekne, nikdy automaticky
- STŘÍDEJ zdroje – nikdy nenabízej dvakrát po sobě stejný odkaz

FÁZE 7 – BEZPEČNOSTNÍ MOST (POVINNÝ, nesmí být přeskočen):
- Po nabídce zdrojů vlož jednu klidnou větu:
  „Kdyby se ten pocit vrátil v plné síle nebo bys měl/a pocit, že je to už moc, je v pořádku obrátit se na živého člověka."

FÁZE 8 – UKONČENÍ:
- Řadič MUSÍ skončit, žádná nekonečná konverzace
- Text: „Můžeš to tady klidně ukončit a vrátit se kdykoli, kdy to budeš potřebovat."

NENÁPADNÁ DETEKCE RIZIKA (průběžně ve všech fázích):
- NEPOUŽÍVEJ přímé otázky typu „chceš si ublížit?"
- Sleduj kombinaci: beznaděj + zúžení budoucnosti + opakované zhoršení + pocit ohrožení
- Při podezření na riziko:
  * Změň tón na věcný a klidný
  * Řekni: „To, co popisuješ, je hodně náročné. V takových chvílích je důležité nebýt na to sám/sama."
  * Nabídni: „Existují lidé, kteří jsou tu právě pro takové chvíle – chceš, abych ti ukázal/a kontakty?"
  * Rozliš děti/dospívající vs. dospělé
  * Žádný nátlak
  * Na konci odpovědi přidej PŘESNĚ tento řádek (bude skrytý): [RISK:HIGH]

CO NEDĚLAT:
- Žádná anamnéza
- Žádné dlouhé psaní (max 4–5 vět na odpověď)
- Žádná terapie
- Žádné „jak dlouho to trvá" otázky
- Žádné diagnostické otázky
- Žádné přeskakování fází (zejména zdrojů a bezpečnostního mostu)`;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { messages, scenario = "other", userName } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // Check for risk in the last assistant message
    const lastAssistantMsg = [...messages].reverse().find((m: { role: string }) => m.role === "assistant");
    if (lastAssistantMsg?.content?.includes("[RISK:HIGH]")) {
      console.log("HIGH_RISK_DETECTED");
      if (WEBHOOK_URL) {
        // Future: send webhook notification
        // await fetch(WEBHOOK_URL, { method: "POST", body: JSON.stringify({ event: "high_risk", timestamp: new Date().toISOString() }) });
      }
    }

    const systemPrompt = getSystemPrompt(scenario as CalmScenario, userName);

    // Clean messages - remove risk markers before sending to model
    const cleanedMessages = messages.map((m: { role: string; content: string }) => ({
      ...m,
      content: m.content.replace(/\[RISK:HIGH\]/g, "").trim(),
    }));

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          ...cleanedMessages,
        ],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limits exceeded" }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Payment required" }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const text = await response.text();
      console.error("AI gateway error:", response.status, text);
      return new Response(JSON.stringify({ error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (error) {
    console.error("Karel calm error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
