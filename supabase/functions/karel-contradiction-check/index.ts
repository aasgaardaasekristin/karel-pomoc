import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { existingText, newInfo } = await req.json();

    if (!existingText || !newInfo) {
      return new Response(
        JSON.stringify({ found: false, contradictedSentence: null, reasoning: null }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const systemPrompt = `Jsi analytik rozporů v klinických záznamech DID terapie.
Dostaneš EXISTUJÍCÍ TEXT (část karty) a NOVOU INFORMACI (z rozhovoru s DID částí).

Tvým úkolem je:
1. Zjistit, zda NOVÁ INFORMACE je v ROZPORU s něčím v EXISTUJÍCÍM TEXTU.
2. Pokud ano, identifikovat KONKRÉTNÍ VĚTU/FRÁZI v existujícím textu, se kterou je rozpor.
3. Vysvětlit, proč se jedná o rozpor.

POZOR: Rozpor NENÍ:
- Nová informace, která v textu ještě není (to je doplnění, ne rozpor)
- Vývoj nebo změna stavu (části se mění, to je normální)

Rozpor JE:
- Přímý protiklad (text říká "má rád X", nová info říká "nemá rád X")
- Faktický nesoulad (text říká "nemluví s Y", nová info říká "mluvil s Y")

Odpověz POUZE validním JSON:
{
  "found": true/false,
  "contradictedSentence": "přesná věta z existujícího textu" nebo null,
  "reasoning": "vysvětlení rozporu" nebo null
}`;

    const userPrompt = `EXISTUJÍCÍ TEXT:\n${existingText}\n\nNOVÁ INFORMACE:\n${newInfo}`;

    let lastError: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(
          "https://ai.gateway.lovable.dev/v1/chat/completions",
          {
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
              temperature: 0.1,
            }),
          },
        );

        if (response.status === 429 || response.status === 402) {
          return new Response(
            JSON.stringify({
              error: response.status === 429
                ? "Rate limit exceeded"
                : "Insufficient credits",
            }),
            {
              status: response.status,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        if (!response.ok) {
          lastError = `HTTP ${response.status}`;
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          throw new Error(lastError);
        }

        const aiData = await response.json();
        const raw = aiData.choices?.[0]?.message?.content ?? "";

        // Parse JSON from AI response
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          return new Response(
            JSON.stringify({ found: false, contradictedSentence: null, reasoning: null }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        const parsed = JSON.parse(jsonMatch[0]);
        return new Response(
          JSON.stringify({
            found: !!parsed.found,
            contradictedSentence: parsed.contradictedSentence ?? null,
            reasoning: parsed.reasoning ?? null,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      } catch (retryErr) {
        lastError = String(retryErr);
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }

    console.error("[contradiction-check] All retries failed:", lastError);
    return new Response(
      JSON.stringify({ found: false, contradictedSentence: null, reasoning: null }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[contradiction-check] Error:", err);
    return new Response(
      JSON.stringify({ found: false, contradictedSentence: null, reasoning: null }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
