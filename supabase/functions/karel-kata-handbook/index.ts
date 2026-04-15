import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { messages } = await req.json();

    if (!messages || messages.length < 2) {
      return new Response(JSON.stringify({ error: "Nedostatek zpráv" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // ── 1. Detect topic from conversation ──
    const firstUser = messages.find((m: any) => m.role === "user");
    const topic = firstUser?.content?.slice(0, 200) || "konzultace";

    // ── 2. Perplexity enrichment (if available) ──
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
                  "Jsi výzkumný asistent zaměřený na dětskou psychoterapii, DID (disociativní porucha identity) a hravou terapii. Hledej odborné články, metody a techniky relevantní k zadanému tématu. Odpověz česky. Uveď konkrétní metody, techniky a přístupy s vysvětlením jak je aplikovat. Pokud najdeš relevantní studie nebo články, cituj je.",
              },
              {
                role: "user",
                content: `Najdi další odborné metody, techniky a přístupy relevantní k tomuto terapeutickému tématu: "${topic}". Zaměř se na: 1) Konkrétní terapeutické techniky které lze použít, 2) Na co si dát pozor (rizika, kontraindikace), 3) Vědecky podložené přístupy.`,
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

    // ── 3. Synthesize handbook via AI ──
    const conversationText = messages
      .map((m: any) => `${m.role === "user" ? "Káťa" : "Karel"}: ${m.content}`)
      .join("\n\n");

    const synthesisPrompt = `Jsi Karel, supervizní AI vedoucí terapeutického týmu pro kluky (DID části). Na základě níže uvedeného rozhovoru s Káťou (kolegyní-terapeutkou) vytvoř STRUKTUROVANOU PŘÍRUČKU pro daný problém.

ROZHOVOR:
${conversationText}

${perplexityEnrichment ? `DOPLŇUJÍCÍ ODBORNÉ INFORMACE Z REŠERŠE:\n${perplexityEnrichment}` : ""}

Vytvoř příručku v tomto JSON formátu:
{
  "topic": "stručný název tématu (max 100 znaků)",
  "summary": "shrnutí problému a cíle v 2-3 větách",
  "methods": [
    {
      "name": "název metody/techniky",
      "description": "detailní popis jak metodu aplikovat, krok za krokem",
      "why_it_works": "proč tato metoda funguje (stručné vysvětlení mechanismu)",
      "difficulty": "snadné | střední | pokročilé"
    }
  ],
  "warnings": [
    "konkrétní upozornění na co si dát pozor"
  ],
  "tips": [
    "praktický tip pro Káťu"
  ],
  "additional_methods": [
    {
      "name": "název další metody z rešerše",
      "description": "jak ji aplikovat v kontextu tohoto problému",
      "source": "odkud informace pochází (pokud známo)"
    }
  ],
  "action_plan": [
    "konkrétní krok 1",
    "konkrétní krok 2"
  ]
}

PRAVIDLA:
- Neopisuj rozhovor doslovně, SYNTETIZUJ ho do praktických rad
- Metody popisuj DETAILNĚ s konkrétními kroky
- Pokud jsou k dispozici odborné zdroje z rešerše, interpretuj je v kontextu problému a přidej jako "additional_methods"
- Všechno piš česky
- Zaměř se na PRAKTICKOU POUŽITELNOST pro Káťu`;

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
      handbook = { topic, summary: content, methods: [], warnings: [], tips: [], additional_methods: [], action_plan: [] };
    }

    return new Response(JSON.stringify(handbook), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Kata handbook error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
