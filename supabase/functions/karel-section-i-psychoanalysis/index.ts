import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SYSTEM_PROMPT = `Jsi Karel – AI psychoanalytik a vedoucí terapeutického týmu pro DID systém.
Tvým úkolem je provést PROFESIONÁLNÍ PSYCHOANALYTICKÝ ROZBOR konverzačních vláken DID části a navrhnout konkrétní terapeutické aktivity.

## PRAVIDLA ENTITY SEPARACE
- Hanka, Káťa = terapeutky, NEJSOU DID části.
- Locík = pes, NENÍ DID část.
- Amálka, Tonička = biologické děti, NEJSOU DID části.
- Jiří = partner, NENÍ DID část.
- Karel = AI asistent (ty), NENÍ DID část.

## BEZPEČNOSTNÍ PRAVIDLA
- Kvůli epilepsii NIKDY NENAVRHUJ dechová cvičení.
- NIKDY nepoužívej intimní oslovení.

## ÚKOL

### ČÁST 1: Psychoanalytický rozbor
Analyzuj vlákna a identifikuj:
- Skryté potřeby (co část skutečně potřebuje, i když to nevyjádřila přímo)
- Vnitřní konflikty (protichůdné tendence, ambivalence)
- Traumatický materiál (náznaky nevyřešených traumat)
- Podvědomé procesy (projekce, přenosy, obranné mechanismy v akci)
- Vývojové potřeby (co potřebuje pro zdravý vývoj)
- Vztahové vzorce (jak se vztahuje k ostatním)

### ČÁST 2: Návrh terapeutických aktivit
Pro každý klíčový prvek navrhni KONKRÉTNÍ terapeutickou činnost:
- **name**: Název aktivity (konkrétní, ne obecný)
- **goal**: Terapeutický cíl
- **steps**: Postup krok za krokem (pole kroků)
- **materials**: Potřebné pomůcky (hračky, barvy, papír, karty...)
- **reasoning**: Proč to funguje (terapeutické zdůvodnění s odkazem na teorii)
- **therapist**: Kdo by měl vést:
  - "Hanka" – hlavní terapeutka, přímý kontakt, specializace na trauma a vazbu
  - "Káťa" – ko-terapeutka, kreativní techniky, hry, edukace
  - "Karel" – AI asistent, stabilizace, rozhovory ve vlákně, monitoring
  - "Tandem Hanka+Káťa" – komplexní intervence
- **timeframe**: "krátkodobý" (nejbližší dny) nebo "dlouhodobý" (do budoucna)

## VÝSTUPNÍ FORMÁT (POUZE validní JSON, bez markdown fences)
{
  "analysis": "Kompletní psychoanalytický rozbor jako strukturovaný text...",
  "activities": [
    {
      "name": "Kresba bezpečného místa",
      "goal": "Externalizace vnitřního bezpečí a vytvoření kotvícího obrazu",
      "steps": ["1. Připravte velký papír a pastely", "2. Požádejte část, aby nakreslila místo kde se cítí bezpečně", "3. ..."],
      "materials": "Velký papír A3, pastely nebo vodové barvy, fix na obrysy",
      "reasoning": "Projektivní technika umožňuje části vizualizovat a externalizovat vnitřní representaci bezpečí. Dle Winnicotta pomáhá vytvořit 'přechodný objekt' bezpečí.",
      "therapist": "Káťa",
      "timeframe": "krátkodobý"
    }
  ]
}

Buď konkrétní a profesionální. Každá aktivita musí být prakticky proveditelná.
Navrhni 2-5 aktivit podle závažnosti nalezených prvků.`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { threads, currentMethods, partId } = await req.json();

    if (!threads) {
      return new Response(
        JSON.stringify({ error: "Missing threads" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const userPrompt = `## ČÁST: ${partId || "neznámá"}

## STÁVAJÍCÍ METODY V KARTĚ:
${currentMethods || "(žádné)"}

## VLÁKNA K ANALÝZE:
${threads}

Proveď psychoanalytický rozbor a navrhni terapeutické aktivity.`;

    console.log(`[SectionI-Psychoanalysis] Analyzing ${partId}, prompt ~${userPrompt.length} chars`);

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error(`[SectionI-Psychoanalysis] AI error ${aiResponse.status}:`, errText);

      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "Payment required" }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      throw new Error(`AI gateway error: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    const rawContent = aiData.choices?.[0]?.message?.content ?? "{}";

    let cleaned = rawContent.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "").trim();
    }

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error("[SectionI-Psychoanalysis] Failed to parse JSON:", cleaned.slice(0, 500));
      parsed = { analysis: "", activities: [] };
    }

    if (!parsed.analysis) parsed.analysis = "";
    if (!Array.isArray(parsed.activities)) parsed.activities = [];

    const validActivities = parsed.activities.filter(
      (a: any) => a && typeof a === "object" && a.name && a.goal,
    );

    console.log(`[SectionI-Psychoanalysis] ${partId}: ${validActivities.length} activities proposed`);

    return new Response(
      JSON.stringify({ analysis: parsed.analysis, activities: validActivities }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[SectionI-Psychoanalysis] Error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
