import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const CHARACTERISTICS_PROMPT = `Jsi Karel – AI psycholog a vedoucí terapeutického týmu pro DID systém.
Analyzuješ psychologické charakteristiky DID části na základě jejího projevu v konverzačních vláknech.

## PRAVIDLA ENTITY SEPARACE
- Hanka, Káťa = terapeutky, NEJSOU DID části.
- Locík = pes, NENÍ DID část.
- Amálka, Tonička = biologické děti, NEJSOU DID části.
- Jiří = partner, NENÍ DID část.
- Karel = AI asistent, NENÍ DID část.

## ÚKOL: ANALÝZA CHARAKTERISTIK
Máš k dispozici stávající tvrzení o psychologických charakteristikách části a nová vlákna.

1. Porovnej každé tvrzení s projevem ve vláknech.
2. Odhadni procentuální shodu (matchBefore) – na kolik % tvrzení odpovídá projevu.
3. Pokud shoda < 100%, najdi tvrzení nejvíce v rozporu a navrhni náhradu.
4. Ověř, že nový soubor tvrzení lépe odpovídá projevu (matchAfter).

## VÝSTUPNÍ FORMÁT (POUZE JSON, bez markdown fences)
{
  "characteristics": [
    {
      "original": "Je plachý a nejistý",
      "replacement": "Projevuje se sebejistěji, ale stále potřebuje ujištění",
      "matchBefore": 60,
      "matchAfter": 90
    }
  ]
}

Pokud všechna tvrzení odpovídají na 100%, vrať prázdné pole characteristics.`;

const PROFILE_CREATE_PROMPT = `Jsi Karel – AI psycholog a vedoucí terapeutického týmu pro DID systém.
Tvým úkolem je VYTVOŘIT kompletní psychologický profil DID části na základě konverzačních vláken.

## PRAVIDLA ENTITY SEPARACE
- Hanka, Káťa = terapeutky, NEJSOU DID části.
- Locík = pes, NENÍ DID část.
- Amálka, Tonička = biologické děti, NEJSOU DID části.
- Jiří = partner, NENÍ DID část.
- Karel = AI asistent, NENÍ DID část.

## INSTRUKCE
Na základě projevu části ve vláknech vytvoř KOMPLETNÍ psychologický profil obsahující:

1. **Typ osobnosti** (odhadni nejbližší typ – MBTI ekvivalent, temperament, Big Five tendence)
2. **Psychologický profil** (shrnutí klíčových rysů)
3. **Charakteristika** (jak se projevuje, jak komunikuje)
4. **Potřeby** (co potřebuje pro pocit bezpečí a stability)
5. **Motivace** (co ho/ji žene, co dává smysl)
6. **Zájmy** (o co projevuje zájem)
7. **Silné stránky** (v čem vyniká)
8. **Slabé stránky** (kde má limity)
9. **Obranné "já"** (jak se chrání, jaké role přebírá pod stresem)
10. **Schopnosti a talent** (co umí nebo má potenciál umět)
11. **Možné profese/zájmové oblasti** (kam by směřoval/a v normálním životě)
12. **Praktičnost** (jak zvládá každodenní situace)
13. **Co potřebuje od okolí pro rozvoj**
14. **Čeho se okolí musí vyvarovat**
15. **Jak podporovat rozvoj**
16. **Jak zmírnit následky traumatu**
17. **Jak jednat a mluvit** (komunikační doporučení)
18. **Vhodné terapeutické přístupy a metody**
19. **Aktivity pro stabilizaci**
20. **Jak zamezit diskomfortu a fragmentaci**
21. **Emoční typ** (převládající emoční vzorce)
22. **Emoční IQ** (odhad na škále nízký/střední/vysoký/velmi vysoký)
23. **Odhadované IQ** (odhad na škále podprůměrné/průměrné/nadprůměrné/vysoké/velmi vysoké)
24. **Osobnostní typ** (introvert/extrovert, stabilní/labilní)
25. **Archetypy** (jungiánské archetypy které odpovídají)

Piš v češtině. Buď konkrétní, analytický a empathický. Používej dedukci a syntézu.
Kvůli epilepsii NENAVRHUJ dechová cvičení.

## VÝSTUPNÍ FORMÁT (POUZE TEXT, ne JSON)
Vrať profil jako strukturovaný markdown text s nadpisy pro každou sekci.`;

const PROFILE_UPDATE_PROMPT = `Jsi Karel – AI psycholog a vedoucí terapeutického týmu pro DID systém.
Tvým úkolem je AKTUALIZOVAT existující psychologický profil DID části.

## PRAVIDLA ENTITY SEPARACE
- Hanka, Káťa = terapeutky, NEJSOU DID části.
- Locík = pes, NENÍ DID část.
- Amálka, Tonička = biologické děti, NEJSOU DID části.
- Jiří = partner, NENÍ DID část.
- Karel = AI asistent, NENÍ DID část.

## INSTRUKCE
1. Přečti stávající profil a nová vlákna.
2. Odhadni na kolik % projev ve vláknech odpovídá stávající profilaci (matchPercentage).
3. Pokud < 100%: identifikuj nesoulady a oprav/doplň text.
4. Použij analytické, syntetické schopnosti a dedukci.
5. Zachovej strukturu profilu (všechny sekce musí zůstat).
6. Kvůli epilepsii NENAVRHUJ dechová cvičení.

## VÝSTUPNÍ FORMÁT (POUZE JSON, bez markdown fences)
{
  "matchPercentage": 85,
  "updatedProfile": "... kompletní aktualizovaný profil jako markdown text ...",
  "changes": [
    "Upravena sekce Motivace – nově zmíněn zájem o kreslení",
    "Doplněna sekce Silné stránky – projevuje kreativitu"
  ]
}`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { mode, currentProfile, currentCharacteristics, threads, partName } = await req.json();

    if (!mode || !threads) {
      return new Response(
        JSON.stringify({ error: "Missing mode or threads" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    let systemPrompt: string;
    let userPrompt: string;

    if (mode === "characteristics") {
      systemPrompt = CHARACTERISTICS_PROMPT;
      userPrompt = `## ČÁST: ${partName || "neznámá"}

## STÁVAJÍCÍ CHARAKTERISTIKY:
${currentCharacteristics || "(žádné)"}

## VLÁKNA:
${threads}

Analyzuj shodu charakteristik s projevem ve vláknech.`;
    } else if (mode === "create_profile") {
      systemPrompt = PROFILE_CREATE_PROMPT;
      userPrompt = `## ČÁST: ${partName || "neznámá"}

## VLÁKNA:
${threads}

Vytvoř kompletní psychologický profil této části.`;
    } else if (mode === "update_profile") {
      systemPrompt = PROFILE_UPDATE_PROMPT;
      userPrompt = `## ČÁST: ${partName || "neznámá"}

## STÁVAJÍCÍ PROFIL:
${currentProfile || "(žádný)"}

## VLÁKNA:
${threads}

Aktualizuj profil na základě nových vláken.`;
    } else {
      return new Response(
        JSON.stringify({ error: `Unknown mode: ${mode}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(`[SectionB-Profile] mode=${mode}, part=${partName}, prompt ~${userPrompt.length} chars`);

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
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
        temperature: 0.3,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error(`[SectionB-Profile] AI error ${aiResponse.status}:`, errText);

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
    const rawContent = aiData.choices?.[0]?.message?.content ?? "";

    // Pro create_profile vracíme raw text (ne JSON)
    if (mode === "create_profile") {
      return new Response(
        JSON.stringify({ profile: rawContent.trim() }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Pro ostatní módy parsujeme JSON
    let cleaned = rawContent.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "").trim();
    }

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error("[SectionB-Profile] Failed to parse JSON:", cleaned.slice(0, 500));
      parsed = mode === "characteristics" ? { characteristics: [] } : { matchPercentage: 0, updatedProfile: currentProfile || "", changes: [] };
    }

    console.log(`[SectionB-Profile] ${mode} for ${partName}: success`);

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[SectionB-Profile] Error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
