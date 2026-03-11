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
                content: `Najdi další odborné zdroje, metody a přístupy relevantní k tomuto terapeutickému/výzkumnému tématu: "${topic || "konzultace"}". Zaměř se na: 1) Konkrétní terapeutické techniky s detailním postupem, 2) Diagnostické nástroje a testy, 3) Vědecky podložené přístupy, 4) Doporučené články a studie.`,
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
    const normalizedCreatedBy = createdBy === "Káťa" ? "Káťa" : (createdBy || "Hana");
    const therapistLabel = normalizedCreatedBy;
    const osobniOsloveni = normalizedCreatedBy === "Káťa" ? "Káťo" : "Haničko";
    const conversationText = messages
      .map((m: any) => `${m.role === "user" ? therapistLabel : "Karel"}: ${m.content}`)
      .join("\n\n");

    // ── 3. Synthesize handbook with therapist-focused structure ──
    const synthesisPrompt = `Jsi Karel, supervizní AI asistent. Na základě níže uvedeného rozhovoru s terapeutem/kou (${therapistLabel}) vytvoř STRUKTUROVANOU PŘÍRUČKU – praktický návod pro terapeuta k vytištění.

KRITICKÉ PRAVIDLO OSLOVENÍ: Tato příručka je pro ${therapistLabel}. V textu oslovuj VÝHRADNĚ "${osobniOsloveni}". NIKDY nepoužívej jiné jméno. Nepředstavuj se jako "tady Karel".

ROZHOVOR:
${conversationText}

${perplexityEnrichment ? `DOPLŇUJÍCÍ ODBORNÉ INFORMACE Z REŠERŠE:\n${perplexityEnrichment}` : ""}

Vytvoř příručku v tomto JSON formátu. KAŽDÁ metoda/aktivita musí být KOMPLETNÍ NÁVOD pro terapeuta:

{
  "topic": "stručný název tématu (max 100 znaků)",
  "createdBy": "${therapistLabel}",
  "summary": "shrnutí tématu a klíčové závěry v 3-5 větách – co terapeut najde v této příručce",
  "activities": [
    {
      "name": "NÁZEV metody/hry/aktivity/techniky",
      "target_group": "pro koho je určena – např. 'děti předškolního věku (3-6 let)', 'adolescenti', 'dospělí s traumatem', 'dětské části v DID systému' apod.",
      "goal": "účel aktivity – CO má metoda dosáhnout (např. regulace emocí, budování důvěry, prolomení vnitřních zábran, stabilizace...)",
      "principle": "srozumitelné vysvětlení PROČ metoda funguje – jaký je psychologický/neurovědní princip za ní",
      "materials": ["seznam pomůcek, které si terapeut musí připravit PŘEDEM – např. 'papíry A4', 'pastelky', 'figurky zvířat', 'přikrývka', 'hudební přehrávač' atd."],
      "introduction": "JAK metodu/hru uvést – konkrétní slova, příběh, pohádka, pokus, hra. Jak to terapeut klientovi představí, aby to bylo přirozené a bezpečné.",
      "steps": ["krok 1: ...", "krok 2: ...", "krok 3: ..."],
      "expected_course": "jak by měl průběh ideálně vypadat – co se typicky děje, jak klient reaguje",
      "expected_outcome": "očekávaný výsledek – např. 'dítě by se mělo uklidnit', 'klient se více otevře', 'získá důvěru v terapeuta', 'prolomí vnitřní zábrany' apod.",
      "diagnostic_watch": ["na co si terapeut má VŠÍMAT – konkrétní reakce klienta, signály, projevy, které mají diagnostickou hodnotu"],
      "warnings": ["bezpečnostní poznámky, kontraindikace, co NEDĚLAT"],
      "difficulty": "snadné | střední | pokročilé",
      "duration": "přibližná délka aktivity (např. '15-20 minut', '30-45 minut')"
    }
  ],
  "general_tips": [
    "obecné praktické tipy pro terapeutickou praxi relevantní k tématu"
  ],
  "sources": [
    {
      "title": "název článku/studie/knihy",
      "url": "funkční URL (pokud existuje)",
      "description": "stručný popis relevance"
    }
  ],
  "karel_notes": "Karlovy poznámky pro ${osobniOsloveni} – jak výsledky propojit s praxí, doporučení pro terapeuta. OSLOVUJ VÝHRADNĚ ${osobniOsloveni}."
}

PRAVIDLA:
- Každá aktivita musí být KOMPLETNÍ NÁVOD – terapeut by měl být schopen ji provést jen z tohoto PDF
- Popisuj KONKRÉTNĚ: jaká slova použít, jaké pomůcky, jak uvést, co pozorovat
- Pokud je aktivit více, seřaď je logicky (od jednodušších ke složitějším, nebo podle průběhu sezení)
- U zdrojů používej VÝHRADNĚ zdroje z vyhledávání a rozhovoru – NEVYMÝŠLEJ citace
- Všechno piš česky
- Materiály/pomůcky VŽDY uveď – i kdyby to bylo "žádné speciální pomůcky nejsou potřeba"
- "steps" musí být KONKRÉTNÍ kroky, ne obecné fráze`;

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
      handbook = { topic: topic || "konzultace", summary: content, activities: [], general_tips: [], sources: [], karel_notes: "" };
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
