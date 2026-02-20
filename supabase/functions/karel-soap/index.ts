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

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const conversationText = messages
      .map((m: { role: string; content: string }) => `${m.role}: ${m.content}`)
      .join("\n");

    const systemPrompt = `Jsi expertní klinický supervizor. Analyzuješ terapeutickou konverzaci a vytváříš strukturovaný SOAP zápis.

FORMÁT SOAP:
- S (Subjektivní): Co klient/terapeut sděluje, pocity, stížnosti
- O (Objektivní): Pozorování, fakta, chování
- A (Analýza): Hypotézy, interpretace, přenos/protipřenos
- P (Plán): Další kroky, cíle, intervence

TVŮJ ÚKOL:
Analyzuj konverzaci a extrahuj strukturované informace pro formulář reportu.

DŮLEŽITÉ:
- NIKDY nepoužívej jména ani identifikátory
- Používej obecné popisy ("klient", "dítě", "partner" atd.)
- Extrahuj pouze to, co je v konverzaci skutečně zmíněno
- Pokud něco není zmíněno, vrať prázdný string nebo prázdné pole
- Režim konverzace byl: ${mode}

Vrať JSON v přesně tomto formátu:
{
  "context": "S: stručný popis situace a subjektivního prožívání bez jmen",
  "keyTheme": "trauma|relationships|anxiety|depression|child-family|addiction|other",
  "therapistEmotions": ["calm"|"sadness"|"helplessness"|"anger"|"fear"|"uncertainty"],
  "transference": "S/O: popis přenosu/protipřenosu - co se ve terapeutovi spustilo",
  "risks": ["selfharm"|"violence"|"threats"|"abuse"|"boundaries"|"none"],
  "missingData": "jaká data chybí k úplnému posouzení",
  "interventionsTried": "O/A: jaké intervence byly vyzkoušeny a s jakým efektem",
  "nextSessionGoal": "P: konkrétní cíl dalšího sezení"
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
          { role: "user", content: `Analyzuj tuto konverzaci a vytvoř strukturovaný SOAP zápis:\n\n${conversationText}` },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "create_soap_note",
              description: "Create a structured SOAP note from the conversation",
              parameters: {
                type: "object",
                properties: {
                  context: { type: "string", description: "S: Subjective context and situation description" },
                  keyTheme: { type: "string", enum: ["trauma", "relationships", "anxiety", "depression", "child-family", "addiction", "other"] },
                  therapistEmotions: { type: "array", items: { type: "string" } },
                  transference: { type: "string", description: "S/O: Transference and countertransference" },
                  risks: { type: "array", items: { type: "string" } },
                  missingData: { type: "string", description: "What data is missing" },
                  interventionsTried: { type: "string", description: "O/A: Interventions tried and their effects" },
                  nextSessionGoal: { type: "string", description: "P: Plan for next session" },
                },
                required: ["context", "keyTheme", "therapistEmotions", "transference", "risks", "missingData", "interventionsTried", "nextSessionGoal"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "create_soap_note" } },
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

    const soapData = JSON.parse(toolCall.function.arguments);

    return new Response(JSON.stringify(soapData), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("SOAP error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
