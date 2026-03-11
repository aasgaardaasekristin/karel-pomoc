import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { messages, topic, createdBy } = await req.json();

    if (!messages || messages.length < 2) {
      return new Response(JSON.stringify({ error: "Nedostatek zpráv" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // ── 1. Perplexity enrichment ──
    let perplexityEnrichment = "";
    if (PERPLEXITY_API_KEY) {
      try {
        const pxRes = await fetch("https://api.perplexity.ai/chat/completions", {
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
                content:
                  "Jsi výzkumný asistent zaměřený na psychoterapii, diagnostiku a terapeutické metody. Hledej odborné články, metody a techniky relevantní k zadanému tématu. Odpověz česky. Uveď konkrétní metody, techniky a přístupy s vysvětlením jak je aplikovat. Pokud najdeš relevantní studie nebo články, cituj je s funkčními URL.",
              },
              {
                role: "user",
                content: `Najdi další odborné zdroje, metody a přístupy relevantní k tomuto terapeutickému/výzkumnému tématu: "${topic || "konzultace"}". Zaměř se na: 1) Konkrétní terapeutické techniky, 2) Diagnostické nástroje a testy, 3) Vědecky podložené přístupy, 4) Doporučené články a studie.`,
              },
            ],
            search_mode: "academic",
          }),
        });
        if (pxRes.ok) {
          const pxData = await pxRes.json();
          perplexityEnrichment = pxData.choices?.[0]?.message?.content || "";
          const citations = pxData.citations || [];
          if (citations.length > 0) {
            perplexityEnrichment += "\n\nZdroje:\n" + citations.map((c: string, i: number) => `[${i + 1}] ${c}`).join("\n");
          }
        }
      } catch (e) {
        console.warn("Perplexity enrichment failed:", e);
      }
    }

    // ── 2. Build conversation text ──
    const therapistLabel = createdBy || "Terapeut";
    const conversationText = messages
      .map((m: any) => `${m.role === "user" ? therapistLabel : "Karel"}: ${m.content}`)
      .join("\n\n");

    // ── 3. Synthesize handbook ──
    const synthesisPrompt = `Jsi Karel, supervizní AI asistent a výzkumný partner. Na základě níže uvedeného rozhovoru s terapeutem (${therapistLabel}) vytvoř STRUKTUROVANOU PŘÍRUČKU – profesní zdroj shrnující výsledky rešerše a konzultace.

ROZHOVOR:
${conversationText}

${perplexityEnrichment ? `DOPLŇUJÍCÍ ODBORNÉ INFORMACE Z REŠERŠE:\n${perplexityEnrichment}` : ""}

Vytvoř příručku v tomto JSON formátu:
{
  "topic": "stručný název tématu (max 100 znaků)",
  "createdBy": "${therapistLabel}",
  "summary": "shrnutí tématu, cíle rešerše a klíčové závěry v 3-5 větách",
  "methods": [
    {
      "name": "název metody/techniky/přístupu",
      "description": "detailní popis – jak metodu aplikovat, krok za krokem",
      "application": "kde a u koho lze metodu použít (cílová skupina, typy problémů)",
      "difficulty": "snadné | střední | pokročilé"
    }
  ],
  "diagnostic_tools": [
    {
      "name": "název testu/nástroje",
      "description": "popis, zadání, interpretace",
      "target_group": "pro koho je vhodný"
    }
  ],
  "warnings": [
    "konkrétní upozornění, kontraindikace, rizika"
  ],
  "tips": [
    "praktický tip pro terapeutickou praxi"
  ],
  "sources": [
    {
      "title": "název článku/studie/knihy",
      "url": "funkční URL (pokud existuje)",
      "description": "stručný popis relevance"
    }
  ],
  "action_plan": [
    "konkrétní krok/návrh pro další postup"
  ],
  "karel_notes": "Karlovy poznámky – jak výsledky propojit s praxí, návrhy na využití v kartotéce, doporučení pro oba terapeuty"
}

PRAVIDLA:
- SYNTETIZUJ rozhovor do praktických rad, neopisuj doslovně
- Metody popisuj DETAILNĚ s konkrétními kroky
- U zdrojů používej VÝHRADNĚ zdroje z vyhledávání a rozhovoru – NEVYMÝŠLEJ citace
- Všechno piš česky
- Zaměř se na PRAKTICKOU POUŽITELNOST v terapeutické praxi
- Pokud jde o DID-relevantní téma, zdůrazni to v karel_notes`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "Jsi klinický supervizní asistent. Odpovídej VŽDY validním JSON." },
          { role: "user", content: synthesisPrompt },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("AI synthesis error:", response.status, text);
      throw new Error("Synthesis failed");
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "{}";

    let handbook;
    try {
      handbook = JSON.parse(content);
    } catch {
      handbook = { topic: topic || "konzultace", summary: content, methods: [], diagnostic_tools: [], warnings: [], tips: [], sources: [], action_plan: [], karel_notes: "" };
    }

    return new Response(JSON.stringify(handbook), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Research handbook error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
