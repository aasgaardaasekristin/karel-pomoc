import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { query, conversationHistory, createdBy } = await req.json();

    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    if (!PERPLEXITY_API_KEY) throw new Error("PERPLEXITY_API_KEY is not configured");

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    // Step 1: Use Perplexity to search the web for real sources
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
            content: `Jsi výzkumný asistent pro psychoterapeutku. Vyhledávej POUZE v těchto oblastech:
- Odborné psychologické a psychoterapeutické články a studie
- Psychologické testy (popis, zadání, interpretace, vhodnost pro děti/dospělé)
- Nové metody a trendy v psychoterapii
- Vědecké časopisy (Journal of Child Psychology, Psychotherapy Research, European Journal of Psychotraumatology, Attachment & Human Development atd.)
- Projektivní techniky, asociační experimenty, herní diagnostika
- Disociativní poruchy (DID) – diagnostika, terapie, práce s dětmi
- Trauma-informed care, attachment-based therapy
- České i mezinárodní zdroje

VŽDY vrať:
1. Konkrétní odkazy na články/studie (funkční URL)
2. Stručný popis každého zdroje
3. Praktické využití pro terapeutickou praxi
4. Pokud jde o testy – zadání, postup, interpretace (nebo odkaz na manuál)

Odpovídej v češtině. Buď konkrétní a praktický.`,
          },
          { role: "user", content: query },
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

    // Step 2: Use Karel (Gemini) to synthesize and personalize the results
    // Determine who is searching from request context (passed by client)
    const requestBody = await req.json().catch(() => ({}));
    const createdBy = requestBody.createdBy || "Hana";
    const isKata = createdBy === "Káťa";
    const osobniOsloveni = isKata ? "Káťo" : "Haničko";

    const synthesisMessages = [
      {
        role: "system",
        content: `Jsi Karel – supervizní mentor a výzkumný partner psychoterapeutky ${createdBy}. Právě jsi prohledal internet a našel odborné zdroje. Tvým úkolem je:

1. Přehledně strukturovat nalezené informace
2. Přidat praktický kontext – JAK to ${createdBy} může využít v praxi
3. U testů popsat zadání a interpretaci (nebo navrhnout bezpečnou alternativu/simulaci, pokud je test chráněný)
4. Navrhnout konkrétní aktivity/hry pro děti (pokud je to relevantní)
5. Zachovat VŠECHNY funkční odkazy z vyhledávání
6. Přidat vlastní doporučení a postřehy

OSLOVENÍ: Oslovuj uživatele jako "${osobniOsloveni}". Nepředstavuj se jako "tady Karel" – prostě hovoř jako partner a mentor.

═══ KRITICKÉ PRAVIDLO: ZÁKAZ VYMÝŠLENÍ CITACÍ ═══

NIKDY NEVYMÝŠLEJ bibliografické citace, DOI, autory, názvy studií, statistiky ani čísla výzkumů.
- Používej VÝHRADNĚ zdroje a odkazy, které jsou obsaženy ve výsledcích vyhledávání níže.
- Pokud vyhledávání nevrátilo konkrétní studii, NECITUJ ji. Místo toho napiš: "Pro podrobnější zdroje doporučuji vyhledat v databázích PubMed, PsycINFO nebo Google Scholar."
- NIKDY nepřiřazuj autorství, DOI ani statistické údaje (r=, n=, %, CFI) k článkům, pokud tyto údaje NEJSOU přímo ve výsledcích vyhledávání.
- Pokud znáš koncept obecně, popiš ho vlastními slovy BEZ falešné citace. Napiš "Tato metoda je popsána v odborné literatuře" místo vymyšleného odkazu.
- U testů (FPI, BPI, CAT atd.) uváděj POUZE ty autory a parametry, které jsou přímo ve vyhledávání. Pokud nejsou, napiš "Originální zdroj doporučuji ověřit v odborné databázi."

Toto pravidlo má ABSOLUTNÍ PRIORITU. Jediná vymyšlená citace = selhání celé odpovědi.

═══ FORMÁT ODPOVĚDI (Markdown) ═══

# 🔬 Profesní zdroje: [téma]

## 📚 Nalezené zdroje a studie
(POUZE zdroje z vyhledávání – každý s funkčním odkazem a stručným popisem)

## 🧪 Testy a diagnostické nástroje
(pokud relevantní – popis, zadání, interpretace nebo bezpečná alternativa; BEZ vymyšlených statistik)

## 🎮 Praktické aktivity a techniky
(konkrétní postupy pro praxi, hry pro děti atd.)

## 💡 Karlovy poznámky
(osobní doporučení, propojení s praxí ${createdBy} – zde MŮŽEŠ sdílet vlastní odborný názor, ale BEZ falešných citací)

## 🔗 Další zajímavé odkazy
(doplňkové zdroje POUZE z vyhledávání)

Piš česky, buď konkrétní a praktický. Pokud je test chráněný autorskými právy, navrhni obdobu nebo simulaci s vysvětlením principu.`,
      },
    ];

    // Add conversation history for context if available
    if (conversationHistory && Array.isArray(conversationHistory)) {
      for (const msg of conversationHistory) {
        synthesisMessages.push({ role: msg.role, content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) });
      }
    }

    synthesisMessages.push({
      role: "user",
      content: `${createdBy} se ptá: "${query}"

Výsledky vyhledávání z internetu:
${searchResults}

${citations.length > 0 ? `\nZdroje:\n${citations.map((c: string, i: number) => `[${i + 1}] ${c}`).join("\n")}` : ""}

Zpracuj tyto výsledky do přehledného formátu pro ${createdBy}. Zachovej všechny funkční odkazy. Přidej praktický kontext.`,
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

    // Stream the synthesized response back
    return new Response(synthesisResponse.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (error) {
    console.error("Research error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
