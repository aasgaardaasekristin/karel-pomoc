import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  // Auth check
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { messages, hint } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const conversationText = messages
      .map((m: { role: string; content: string }) => `${m.role}: ${m.content}`)
      .join("\n");

    const systemPrompt = `Jsi asistent pro extrakci strukturovaných dat z terapeutické konverzace.
    
Tvým úkolem je analyzovat konverzaci a extrahovat relevantní informace pro vyplnění formuláře supervizního reportu.

DŮLEŽITÉ:
- NIKDY nepoužívej jména ani identifikátory
- Používej obecné popisy ("klient", "dítě", "partner" atd.)
- Extrahuj pouze to, co je v konverzaci skutečně zmíněno
- Pokud něco není zmíněno, vrať prázdný string nebo prázdné pole

Vrať JSON v přesně tomto formátu:
{
  "context": "stručný popis situace bez jmen",
  "keyTheme": "trauma|relationships|anxiety|depression|child-family|addiction|other",
  "therapistEmotions": ["calm"|"sadness"|"helplessness"|"anger"|"fear"|"uncertainty"],
  "transference": "popis přenosu/protipřenosu",
  "risks": ["selfharm"|"violence"|"threats"|"abuse"|"boundaries"|"none"],
  "missingData": "jaká data chybí",
  "interventionsTried": "jaké intervence byly vyzkoušeny",
  "nextSessionGoal": "cíl dalšího sezení"
}`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `${hint}\n\nKonverzace:\n${conversationText}` },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "extract_form_data",
              description: "Extract structured form data from conversation",
              parameters: {
                type: "object",
                properties: {
                  context: { type: "string" },
                  keyTheme: { type: "string", enum: ["trauma", "relationships", "anxiety", "depression", "child-family", "addiction", "other"] },
                  therapistEmotions: { type: "array", items: { type: "string" } },
                  transference: { type: "string" },
                  risks: { type: "array", items: { type: "string" } },
                  missingData: { type: "string" },
                  interventionsTried: { type: "string" },
                  nextSessionGoal: { type: "string" },
                },
                required: ["context", "keyTheme", "therapistEmotions", "transference", "risks", "missingData", "interventionsTried", "nextSessionGoal"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "extract_form_data" } },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("AI gateway error:", response.status, text);
      throw new Error("AI gateway error");
    }

    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    
    if (!toolCall) {
      throw new Error("No tool call in response");
    }

    const extractedData = JSON.parse(toolCall.function.arguments);

    return new Response(JSON.stringify(extractedData), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Prefill error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
