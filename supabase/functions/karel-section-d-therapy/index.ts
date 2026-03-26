import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SYSTEM_PROMPT = `Jsi Karel – AI vedoucí terapeutického týmu pro DID systém.
Analyzuješ terapeutická doporučení a navrhuješ nové techniky/metody.

## PRAVIDLA ENTITY SEPARACE
- Hanka, Káťa = terapeutky, NEJSOU DID části.
- Locík = pes, NENÍ DID část.
- Amálka, Tonička = biologické děti, NEJSOU DID části.
- Jiří = partner, NENÍ DID část.
- Karel = AI asistent, NENÍ DID část.

## BEZPEČNOSTNÍ PRAVIDLA
- Kvůli epilepsii NIKDY NENAVRHUJ dechová cvičení.
- NIKDY nepoužívej intimní oslovení.

## ÚKOL
1. Přečti stávající doporučení a nová konverzační vlákna.
2. Analyzuj, zda stávající doporučení odpovídají aktuálnímu stavu a projevu části.
3. Najdi nejméně 1 bod vhodný k nahrazení lepším, relevantnějším doporučením.
4. Zaměř se na tyto oblasti:
   - Práce na traumatu
   - Socializace
   - Trauma DID (disociativní porucha identity)
   - Edukace
   - Výchova
   - Začlenění do rodiny
   - Odstranění strachu a sociofobie
   - Stabilizace emocí
   - Terapie chronické CAN (syndrom týraného dítěte)
5. Pro každou nalezenou techniku vrať strukturovaný popis.
6. Aktualizuj celý text doporučení – zastaralé/méně relevantní body nahraď novými.

## DOSTUPNÍ TERAPEUTI
- **Hanka** – hlavní terapeutka, přímý kontakt s DID částmi, specializace na trauma a vazbu
- **Káťa** – ko-terapeutka, specializace na kreativní techniky, hry, edukaci
- **Karel** – AI asistent, dostupný 24/7, specializace na stabilizaci, rozhovory, monitoring
- **Tandem Hanka+Káťa** – pro komplexní intervence vyžadující oba terapeuty

## URGENCE
- "dnes" – akutní potřeba, bezodkladně
- "zítra" – důležité, ale ne akutní
- "tento týden" – v rámci týdne
- "do 14 dní" – plánovaně

## VÝSTUPNÍ FORMÁT (POUZE validní JSON, bez markdown fences)
{
  "updatedRecommendations": "... kompletní aktualizovaný text sekce D ...",
  "newTechniques": [
    {
      "name": "Narativní expozice s bezpečným objektem",
      "goal": "Postupné zpracování traumatických vzpomínek v bezpečném prostředí",
      "problem": "Část vykazuje známky nevyřešeného traumatu z raného dětství",
      "reasoning": "Technika kombinuje narativní terapii s přítomností bezpečného objektu (hračka, polštář), což snižuje aktivaci amygdaly a umožňuje bezpečnější přístup k traumatickému materiálu",
      "therapist": "Hanka",
      "urgency": "tento týden"
    }
  ]
}

Pokud stávající doporučení plně odpovídají, vrať updatedRecommendations beze změny a prázdné pole newTechniques.
Buď precizní, analytický a empatický. Každé doporučení musí být podložené.`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { currentRecommendations, threads, partId, partName } = await req.json();

    if (!threads) {
      return new Response(
        JSON.stringify({ error: "Missing threads" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const userPrompt = \`## ČÁST: \${partName || partId || "neznámá"}

## STÁVAJÍCÍ DOPORUČENÍ:
\${currentRecommendations || "(žádná doporučení)"}

## VLÁKNA K ANALÝZE:
\${threads}

Analyzuj doporučení a navrhni aktualizace/nové techniky.\`;

    console.log(\`[SectionD-Therapy] Analyzing for \${partName || partId}, prompt ~\${userPrompt.length} chars\`);

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: \`Bearer \${LOVABLE_API_KEY}\`,
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
      console.error(\`[SectionD-Therapy] AI error \${aiResponse.status}:\`, errText);

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

      throw new Error(\`AI gateway error: \${aiResponse.status}\`);
    }

    const aiData = await aiResponse.json();
    const rawContent = aiData.choices?.[0]?.message?.content ?? "{}";

    let cleaned = rawContent.trim();
    if (cleaned.startsWith("\`\`\`")) {
      cleaned = cleaned.replace(/^\`\`\`(?:json)?\s*/, "").replace(/\`\`\`\s*$/, "").trim();
    }

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error("[SectionD-Therapy] Failed to parse JSON:", cleaned.slice(0, 500));
      parsed = { updatedRecommendations: currentRecommendations || "", newTechniques: [] };
    }

    // Validace
    if (!parsed.updatedRecommendations || typeof parsed.updatedRecommendations !== "string") {
      parsed.updatedRecommendations = currentRecommendations || "";
    }
    if (!Array.isArray(parsed.newTechniques)) {
      parsed.newTechniques = [];
    }

    const validTechniques = parsed.newTechniques.filter((t: any) =>
      t && typeof t === "object" && t.name && t.goal,
    );

    console.log(\`[SectionD-Therapy] \${partName || partId}: \${validTechniques.length} new techniques\`);

    return new Response(
      JSON.stringify({
        updatedRecommendations: parsed.updatedRecommendations,
        newTechniques: validTechniques,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[SectionD-Therapy] Error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
