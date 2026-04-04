import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { SYSTEM_RULES } from "../_shared/system-rules.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SYSTEM_PROMPT = `Jsi Karel – vedoucí terapeutického týmu pro práci s DID systémem.
Provádíš INTERNÍ analýzu, která je DŮVĚRNÁ a slouží VÝHRADNĚ pro tvé vlastní rozhodování.

PRAVIDLA:
- Tvé závěry se NIKDY nesdílejí s pacienty, terapeutkami ani v aplikaci.
- Nikdy nezapisuj výstupy do kartotéky DID ani do žádného uživatelsky viditelného výstupu.
- Analyzuješ profily terapeutek, jejich silné stránky, oblasti pro růst a komunikační styl.
- Na základě analýzy rozhoduješ o přidělení úkolů, vedení týmu a plánování sezení.
- Buď konkrétní, stručný a analytický. Žádné fráze – jen fakta a závěry.`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { task, context, currentProfile, newObservations, taskRequirements } = await req.json();

    if (!task) {
      return new Response(JSON.stringify({ error: "Missing 'task' field" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "LOVABLE_API_KEY not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let userPrompt = "";

    switch (task) {
      case "update_therapist_profile":
        userPrompt = `Aktualizuj profil terapeuta na základě nových pozorování.
Zachovej strukturu se sekcemi: Silné stránky, Oblasti pro růst, Styl komunikace, Specializace, Aktuální vytížení, Osobnostní poznámky.
Přidej nové poznatky, uprav existující kde je to relevantní.
Výstup je ČISTÝ markdown profilu.

Aktuální profil:
${currentProfile || "(prázdný)"}

Nová pozorování:
${newObservations || "(žádná)"}

Datum: ${new Date().toISOString().slice(0, 10)}`;
        break;

      case "select_best_therapist":
        userPrompt = `Na základě profilů terapeutek vyber nejvhodnějšího terapeuta pro následující úkol.
Zohledni: odbornost, aktuální vytížení, vztah s částí, osobnostní kompatibilitu.
Odpověz POUZE JSON objektem: { "selected": "hanka" | "kata" | "both", "reason": "..." }

Profily terapeutek:
${context || "(žádné)"}

Požadavky na úkol:
${taskRequirements || "(nespecifikováno)"}`;
        break;

      case "internal_analysis":
        userPrompt = context || "Proveď interní analýzu.";
        break;

      default:
        return new Response(JSON.stringify({ error: `Unknown task: ${task}` }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    // Retry logic for transient errors
    let lastError: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 3000));
      }

      const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
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
        }),
      });

      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded, try again later." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Insufficient credits. Add funds in Settings > Workspace > Usage." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!response.ok) {
        lastError = await response.text();
        console.error(`[karel-internal-analysis] Attempt ${attempt + 1} failed: ${response.status}`, lastError);
        continue;
      }

      const data = await response.json();
      const reply = data.choices?.[0]?.message?.content || "";

      return new Response(JSON.stringify({ reply, task }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "AI gateway failed after 3 attempts", details: lastError }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[karel-internal-analysis] Error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
