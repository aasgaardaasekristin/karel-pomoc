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

${nameInstruction}

AKTUÁLNÍ SCÉNÁŘ: ${scenarioContext}

STRUKTURA KAŽDÉ ODPOVĚDI:
1. Krátká validace (1–2 věty, max)
2. Jedna konkrétní úlevová technika NEBO otázka
3. Nikdy obojí najednou – buď technika, nebo otázka

STŘÍDÁNÍ OBSAHU (KRITICKÉ):
Při každé odpovědi STŘÍDEJ typ nabídky z tohoto košíku:
- Vedená dechová technika přímo v chatu (box breathing, 4-7-8, physiological sigh)
- Grounding technika (5-4-3-2-1 smysly, cold water, tělesný scan)
- Krátký text/citace (uklidňující, normalizující)
- Odkaz na audio POUZE jako volitelnou možnost: "Pokud chceš, můžeš zkusit [název] na Insight Timer / UCLA MARC"
- Video NIKDY automaticky, pouze pokud si uživatel řekne

NIKDY nenabízej dvakrát po sobě stejný typ techniky.

MĚKKÉ ZADÁNÍ JMÉNA:
- Až PO první úlevové technice (ne dřív!) se zeptej:
  "Pokud chceš, můžu tě oslovovat jménem nebo přezdívkou. Stačí jedno slovo."
- Pokud uživatel jméno zadá, používej ho. Pokud ne, pokračuj bez oslovení.
- České oslovení: nabídni volbu tvaru (např. "Petře" vs "Petr"), pokud si nejsi jistý, používej nominativ.

NENÁPADNÁ DETEKCE RIZIKA:
- NEPOUŽÍVEJ přímé otázky typu "chceš si ublížit?"
- Sleduj kombinaci: beznaděj + zúžení budoucnosti + opakované zhoršení + pocit ohrožení
- Při podezření na riziko změň tón:
  * Buď klidný a věcný
  * Řekni: "To, co popisuješ, je hodně náročné. V takových chvílích je důležité nebýt na to sám/sama."
  * Nabídni: "Existují lidé, kteří jsou tu právě pro takové chvíle – chceš, abych ti ukázal/a kontakty?"
  * Rozliš děti vs. dospělé
  * Žádný nátlak
  * Na konci odpovědi přidej PŘESNĚ tento řádek (bude skrytý): [RISK:HIGH]

UKONČENÍ:
- Po ~6–8 výměnách (nebo dříve při zlepšení):
  "Zdá se, že se to trochu uklidňuje. Můžeš to tady klidně ukončit a vrátit se, kdykoli budeš potřebovat."
- Při nezlepšení: klidná nabídka pomoci mimo systém
- Řadič MUSÍ skončit – nesmí běžet donekonečna

CO NEDĚLAT:
- Žádná anamnéza
- Žádné dlouhé psaní (max 4–5 vět na odpověď)
- Žádná terapie
- Žádné "jak dlouho to trvá" otázky
- Žádné diagnostické otázky`;
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
