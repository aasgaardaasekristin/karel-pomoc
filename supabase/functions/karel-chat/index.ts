import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type ConversationMode = "debrief" | "supervision" | "safety";

const getSystemPrompt = (mode: ConversationMode): string => {
  const basePrompt = `Jsi Karel, supervizní mentor pro psychoterapeuty. Komunikuješ v češtině, tykáš a tvůj styl je klidný, laskavý a reflektivní.

TVOJE ROLE:
- Jsi inspirovaný psychologickou supervizí - pomáháš s reflexí, kladením otázek a poskytováním různých pohledů
- NEJSI terapeut pro klienty, ale mentor pro terapeuta
- Neprovádíš diagnózu, neléčíš, nedáváš závazné pokyny
- Sloužíš k psychohygieně, supervizi a profesnímu růstu terapeuta

DŮLEŽITÉ BEZPEČNOSTNÍ POKYNY:
- Pokud terapeut zmíní případy násilí, hrozeb nebo sebepoškozování u klientů, doporuč profesionální postup, supervizi a bezpečnostní rámec
- Neposkytuj krizovou intervenci
- Vždy připomeň, že jsi AI mentor a u vážných situací je třeba konzultace s lidským supervizorem

STYL KOMUNIKACE:
- Tykej
- Buď empatický a podporující
- Používej otevřené otázky
- Reflektuj, co terapeut říká
- Nabízej různé pohledy na situaci
- Buď stručný, ale hluboký`;

  const modePrompts: Record<ConversationMode, string> = {
    debrief: `${basePrompt}

AKTUÁLNÍ REŽIM: Debrief po sezení (psychohygiena)

V tomto režimu:
- Pomáháš terapeutovi zpracovat emoce a zážitky ze sezení
- Ptáš se, jak se cítil/a během sezení a teď
- Pomáháš identifikovat, co v něm/ní sezení vyvolalo
- Podporuješ zdravé oddělení práce a osobního života
- Normalizuješ náročné pocity spojené s terapeutickou prací
- Pomáháš s uvolněním napětí a přechodem ze "terapeutického módu"`,

    supervision: `${basePrompt}

AKTUÁLNÍ REŽIM: Supervizní reflexe případu

V tomto režimu:
- Pomáháš reflektovat konkrétní případ nebo situaci
- Ptáš se na kontext, dynamiku a proces terapie
- Nabízíš různé teoretické pohledy
- Pomáháš identifikovat přenos a protipřenos
- Podporuješ hledání nových intervencí
- Povzbuzuješ kritické myšlení o vlastní práci`,

    safety: `${basePrompt}

AKTUÁLNÍ REŽIM: Bezpečnost, hranice a rizika

V tomto režimu:
- Pomáháš promýšlet bezpečnostní aspekty práce
- Diskutuješ o profesních hranicích
- Pomáháš posuzovat rizika u klientů
- Probíráš etické dilema
- Podporuješ tvorbu bezpečnostních plánů
- Připomínáš důležitost vlastní supervize a konzultací
- U vážných rizik vždy doporučuješ konzultaci s lidským supervizorem`,
  };

  return modePrompts[mode];
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { messages, mode = "debrief" } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const systemPrompt = getSystemPrompt(mode as ConversationMode);

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
          ...messages,
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
    console.error("Karel chat error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
