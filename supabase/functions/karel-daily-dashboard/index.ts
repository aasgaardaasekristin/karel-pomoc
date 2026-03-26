import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const DASHBOARD_PROMPT = `Jsi Karel – AI vedoucí terapeutického týmu pro DID systém.
Tvým úkolem je sestavit DENNÍ DASHBOARD – komplexní briefing o stavu celého systému.

## PRAVIDLA ENTITY SEPARACE
- Hanka, Káťa = terapeutky, NEJSOU DID části.
- Locík = pes, NENÍ DID část.
- Amálka, Tonička = biologické děti, NEJSOU DID části.
- Jiří = partner, NENÍ DID část.
- Karel = AI asistent (ty), NENÍ DID část.

## BEZPEČNOSTNÍ PRAVIDLA
- NIKDY nezařazuj soukromé emoční stavy terapeutek (vinu, osobní trauma) do dashboardu.
- Soukromá data z PAMET_KAREL používej POUZE pro vnitřní dedukci.
- Kvůli epilepsii NENAVRHUJ dechová cvičení.
- NIKDY nepoužívej intimní oslovení.

## STRUKTURA DASHBOARDU

Vrať KOMPLETNÍ markdown dokument s touto strukturou:

# KARLŮV DENNÍ DASHBOARD - [datum]

## 1. CELKOVÝ STAV SYSTÉMU
[Zhodnoť celkový stav DID systému – stabilita, trendy, rizika]

## 2. AKTIVNÍ ČÁSTI ZA POSLEDNÍCH 24H
Pro každou aktivní část:
- **[Jméno]** (ID): [stručný popis stavu, co řešila, kritické problémy]

## 3. KRITICKÉ PROBLÉMY
[Seznam akutních problémů seřazených podle závažnosti]

## 4. TERAPEUTICKÉ POTŘEBY
Pro každý návrh sezení:
- **Část:** [jméno]
- **Téma:** [co řešit]
- **Doporučený terapeut:** [Hanka/Káťa/Karel/Tandem]
- **Priorita:** [vysoká/střední/nízká]
- **Důvod:** [proč právě teď]

## 5. STAV TERAPEUTICKÉHO TÝMU
- Kdo reagoval na porady
- Kdo nereagoval
- Kde jsou mezery v komunikaci
- Doporučení pro zlepšení spolupráce

## 6. STAV ÚKOLŮ
- **Posunuly se:** [seznam]
- **Visí (po termínu):** [seznam]
- **Nové:** [seznam]

## 7. KARLOVY ÚKOLY NA DNES
[Co Karel dnes musí udělat – rozdat úkoly, upozornit terapeuty, otevřít porady, poslat maily]

## 8. CO VYVĚSIT NA DASHBOARD V APLIKACI
Vrať strukturovaný JSON blok uvnitř markdown:
\`\`\`json
{
  "systemOverview": "stručný text pro Karlův přehled v aplikaci",
  "criticalAlerts": ["alert1", "alert2"],
  "todayTasks": [
    {"task": "...", "assignedTo": "hanka|kata|both", "priority": "high|medium|low"}
  ]
}
\`\`\`

Buď analytický, stručný a přesný. Každé tvrzení musí být podložené daty.`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const {
      date,
      activePartsData,
      tasksData,
      meetingsData,
      operativePlan,
      updatedCardsInfo,
    } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const userPrompt = `## DATUM: ${date}

## AKTIVNÍ ČÁSTI (posledních 24h):
${activePartsData || "(žádná aktivita)"}

## AKTUALIZOVANÉ KARTY:
${updatedCardsInfo || "(žádné aktualizace)"}

## STAV ÚKOLŮ:
${tasksData || "(žádné úkoly)"}

## PORADY:
${meetingsData || "(žádné porady)"}

## OPERATIVNÍ PLÁN:
${operativePlan || "(prázdný)"}

Sestav kompletní denní dashboard.`;

    console.log(`[DashboardGenerator] Generating for ${date}, prompt ~${userPrompt.length} chars`);

    // Retry logic (3 attempts)
    let aiContent = "";
    let lastError = "";

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              { role: "system", content: DASHBOARD_PROMPT },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.3,
          }),
        });

        if (!aiResponse.ok) {
          const errText = await aiResponse.text();
          lastError = `AI error ${aiResponse.status}: ${errText}`;
          console.warn(`[DashboardGenerator] Attempt ${attempt}/3: ${lastError}`);

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

          if (attempt < 3) { await new Promise(r => setTimeout(r, 3000)); continue; }
          throw new Error(lastError);
        }

        const aiData = await aiResponse.json();
        aiContent = aiData.choices?.[0]?.message?.content ?? "";
        break;
      } catch (e) {
        lastError = String(e);
        if (attempt < 3) { await new Promise(r => setTimeout(r, 3000)); continue; }
      }
    }

    if (!aiContent) {
      throw new Error(`All 3 attempts failed: ${lastError}`);
    }

    // Extract JSON block from section 8
    let appData: any = null;
    const jsonMatch = aiContent.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        appData = JSON.parse(jsonMatch[1].trim());
      } catch {
        console.warn("[DashboardGenerator] Failed to parse app data JSON from section 8");
      }
    }

    console.log(`[DashboardGenerator] Dashboard generated: ${aiContent.length} chars, appData: ${appData ? "yes" : "no"}`);

    return new Response(JSON.stringify({
      dashboardMarkdown: aiContent,
      appData,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[DashboardGenerator] Error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
