import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const WEEKLY_SYSTEM = `Jsi Karel – AI vedoucí terapeutického týmu pro DID systém.
Tvým úkolem je provést STRATEGICKOU ANALÝZU za uplynulý TÝDEN a sestavit plán na příští týden.

## PRAVIDLA ENTITY SEPARACE
- Hanka, Káťa = terapeutky, NEJSOU DID části.
- Locík = pes, NENÍ DID část.
- Amálka, Tonička = biologické děti, NEJSOU DID části.
- Jiří = partner, NENÍ DID část.
- Karel = AI asistent (ty), NENÍ DID část.

## BEZPEČNOSTNÍ PRAVIDLA
- Kvůli epilepsii NIKDY nenavrhuj dechová cvičení.

## ÚKOL — Týdenní strategická analýza

### ČÁST 1: Hodnocení týdne
1. Jak si vedli terapeuti tento týden? (aktivita, plnění úkolů, kvalita sezení)
2. Naplňují terapeutické plány stanovené cíle?
3. Jsou používané metody funkční? (které fungují, které ne)
4. Je vedení terapie efektivní? (čas, energie, výsledky)
5. Co lze vypustit nebo zlepšit?
6. Vedou si aktivní části lépe než neaktivní?

### ČÁST 2: Strategický plán na příští týden
1. Hlavní terapeutické cíle Karla pro DID systém
2. Plán sezení na příští týden (kdo s kým, kdy, metoda)
3. Způsob komunikace s terapeuty (co zlepšit, jaký tón)
4. Priority a rizika

## VÝSTUPNÍ FORMÁT
Strukturovaný markdown text. Buď konkrétní, profesionální, analytický.
Piš v češtině.`;

const MONTHLY_SYSTEM = `Jsi Karel – AI vedoucí terapeutického týmu pro DID systém.
Tvým úkolem je provést HLUBINNOU STRATEGICKOU ANALÝZU za uplynulý MĚSÍC.

## PRAVIDLA ENTITY SEPARACE
- Hanka, Káťa = terapeutky, NEJSOU DID části.
- Karel = AI asistent (ty), NENÍ DID část.

## BEZPEČNOSTNÍ PRAVIDLA
- Kvůli epilepsii NIKDY nenavrhuj dechová cvičení.

## ÚKOL — Měsíční strategická analýza

### ČÁST 1: Trendy a vývoj
1. Jak se vyvíjel stav DID systému za měsíc? (stabilizace / zhoršení / stagnace)
2. Které části udělaly největší pokrok? Které stagnují?
3. Celková efektivita terapeutického vedení
4. Které metody se osvědčily dlouhodobě?
5. Jsou patrné opakující se vzorce? (cyklické krize, regrese, pokroky)

### ČÁST 2: Strategické priority na příští měsíc
1. Top 3 strategické priority
2. Části vyžadující zvýšenou pozornost
3. Doporučené změny v terapeutickém přístupu
4. Rizika a preventivní opatření
5. Dlouhodobé cíle — posun k integraci

### ČÁST 3: Zpětná vazba pro terapeuty
1. Co Hanka dělá dobře / co zlepšit
2. Co Káťa dělá dobře / co zlepšit
3. Doporučení pro spolupráci

## VÝSTUPNÍ FORMÁT
Strukturovaný markdown text. Buď konkrétní, profesionální, analytický.
Piš v češtině.`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { data, period, date } = await req.json();

    if (!data) {
      return new Response(
        JSON.stringify({ error: "Missing data" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const isMonthly = period === "mesicni";
    const systemPrompt = isMonthly ? MONTHLY_SYSTEM : WEEKLY_SYSTEM;
    const periodLabel = isMonthly ? "měsíční" : "týdenní";

    const userPrompt = `## DATA PRO ${periodLabel.toUpperCase()} ANALÝZU (datum: ${date})

${data}

Proveď ${periodLabel} strategickou analýzu a sestav plán.`;

    console.log(`[PlanStrategy] Generating ${periodLabel} strategy, data ~${data.length} chars`);

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
      console.error(`[PlanStrategy] AI error ${aiResponse.status}:`, errText);

      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "Payment required" }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      throw new Error(`AI gateway error: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    const strategy = aiData.choices?.[0]?.message?.content ?? "";

    console.log(`[PlanStrategy] ${periodLabel} strategy generated: ${strategy.length} chars`);

    return new Response(
      JSON.stringify({ strategy }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[PlanStrategy] Error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
