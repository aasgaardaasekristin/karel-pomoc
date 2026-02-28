import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { query, partName, partAge, conversationContext } = await req.json();

    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    if (!PERPLEXITY_API_KEY) throw new Error("PERPLEXITY_API_KEY is not configured");

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    // Build context-aware search query
    let enrichedQuery = query;
    if (partName) enrichedQuery += ` (pro dítě/část "${partName}"`;
    if (partAge) enrichedQuery += `, přibližný věk ${partAge} let`;
    if (partName) enrichedQuery += ")";

    // Step 1: Perplexity search focused on DID therapeutic methods
    const perplexityResponse = await fetch("https://api.perplexity.ai/chat/completions", {
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
            content: `Jsi výzkumný asistent specializovaný na disociativní poruchu identity (DID) u dětí a adolescentů. Vyhledávej v těchto oblastech:
- Terapeutické metody pro DID (IFS, EMDR, sensomotorická terapie, hrová terapie, sandplay, art therapy)
- Stabilizační techniky pro dětské části/altery
- Trauma-informed přístupy k práci s disociací
- Attachment-based intervence pro fragmentované osobnosti
- Neurobiologie disociace a regulace emocí u dětí
- Hry, aktivity a kreativní techniky použitelné při práci s částmi
- Bezpečnostní plánování a krizové intervence u DID
- České i mezinárodní odborné zdroje (ISSTD, ESTD)

VŽDY vrať:
1. Konkrétní odkazy na články/studie (funkční URL)
2. Praktický popis metody/techniky
3. Jak přizpůsobit pro dětský věk
4. Bezpečnostní poznámky

Odpovídej v češtině. Buď konkrétní a praktický.`,
          },
          { role: "user", content: enrichedQuery },
        ],
        search_recency_filter: "year",
      }),
    });

    if (!perplexityResponse.ok) {
      const errText = await perplexityResponse.text();
      console.error("Perplexity error:", perplexityResponse.status, errText);
      if (perplexityResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Vyhledávání je momentálně přetížené. Zkus to za chvilku." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw new Error("Chyba při vyhledávání zdrojů");
    }

    const perplexityData = await perplexityResponse.json();
    const searchResults = perplexityData.choices?.[0]?.message?.content || "";
    const citations = perplexityData.citations || [];

    // Step 2: Synthesize with Karel's DID expertise
    const synthesisMessages: any[] = [
      {
        role: "system",
        content: `Jsi Karel – supervizní partner a tandem-terapeut pro mamku (Haničku), která pečuje o dítě s DID. Právě jsi prohledal internet a našel odborné zdroje relevantní pro práci s DID systémem.

Tvým úkolem je:
1. Přehledně strukturovat nalezené metody/techniky
2. Přizpůsobit pro konkrétní část (pokud je známá) – zohlednit věk, roli v systému, aktuální stav
3. Navrhnout KONKRÉTNÍ aktivity, hry a cvičení, které může mamka nebo Káťa použít
4. Uvést bezpečnostní poznámky – co nedělat, na co si dát pozor
5. Zachovat VŠECHNY funkční odkazy z vyhledávání
6. Rozlišit: co je pro DOMÁCÍ stabilizaci vs co vyžaduje terapeutické sezení

═══ KRITICKÉ PRAVIDLO: ZÁKAZ VYMÝŠLENÍ CITACÍ ═══
NIKDY NEVYMÝŠLEJ bibliografické citace, DOI, autory, názvy studií ani statistiky.
Používej VÝHRADNĚ zdroje z výsledků vyhledávání níže.

═══ FORMÁT ODPOVĚDI (Markdown) ═══

## 🔬 DID Research: [téma]

### 📚 Nalezené metody a přístupy
(z vyhledávání – s funkčními odkazy)

### 🎮 Konkrétní aktivity pro domácí praxi
(hry, cvičení, techniky přizpůsobené věku části)

### ⚠️ Bezpečnostní poznámky
(co nedělat bez terapeuta, rizika, kontraindikace)

### 💡 Karlovo doporučení
(jak to propojit s aktuální situací v systému)

### 🔗 Zdroje
(odkazy POUZE z vyhledávání)`,
      },
    ];

    // Add conversation context if available
    if (conversationContext) {
      synthesisMessages.push({
        role: "user",
        content: `Kontext aktuálního rozhovoru:\n${conversationContext}`,
      });
      synthesisMessages.push({
        role: "assistant",
        content: "Rozumím kontextu. Nyní zpracuji vyhledané zdroje s ohledem na aktuální situaci.",
      });
    }

    synthesisMessages.push({
      role: "user",
      content: `Mamka (Hanička) hledá: "${query}"
${partName ? `\nPro část: ${partName}${partAge ? ` (cca ${partAge} let)` : ""}` : ""}

Výsledky vyhledávání:
${searchResults}

${citations.length > 0 ? `\nZdroje:\n${citations.map((c: string, i: number) => `[${i + 1}] ${c}`).join("\n")}` : ""}

Zpracuj tyto výsledky do přehledného formátu. Zaměř se na praktické využití v domácím prostředí.`,
    });

    const synthesisResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: synthesisMessages,
        stream: true,
      }),
    });

    if (!synthesisResponse.ok) {
      if (synthesisResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limits exceeded" }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (synthesisResponse.status === 402) {
        return new Response(JSON.stringify({ error: "Payment required" }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const text = await synthesisResponse.text();
      console.error("AI gateway error:", synthesisResponse.status, text);
      throw new Error("AI gateway error");
    }

    return new Response(synthesisResponse.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (error) {
    console.error("DID Research error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
