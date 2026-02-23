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
    const { form, contextFromChat } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const formSummary = `
Kontext: ${form.context || "neuvedeno"}
Téma: ${form.keyTheme || "neuvedeno"}
Emoce terapeuta: ${form.therapistEmotions?.join(", ") || "neuvedeno"}
Přenos/protipřenos: ${form.transference || "neuvedeno"}
Rizika: ${form.risks?.join(", ") || "žádná"}
Chybějící data: ${form.missingData || "neuvedeno"}
Vyzkoušené intervence: ${form.interventionsTried || "neuvedeno"}
Cíl dalšího sezení: ${form.nextSessionGoal || "neuvedeno"}
`;

    const systemPrompt = `Jsi expertní klinický supervizor s hlubokou znalostí psychoterapie, diagnostiky a krizové intervence.

Tvým úkolem je provést TRIAGE - identifikovat, co je diagnosticky rozhodující pro další práci s klientem.

ZÁSADY:
- Ptej se CÍLENĚ, ne plošně - jen to, co může změnit hypotézu, riziko nebo volbu metody
- Pokud text naznačuje rodinnou/neurologickou zátěž, ptej se na hereditu, neurologii, medikaci
- Pokud jde o trauma, zaměř se na disociaci, flashbacky, somatizaci
- Pokud jde o vztahy, zaměř se na attachment, vzorce, triggery
- Kontraindikace uváděj jen pokud jsou reálně relevantní

Vrať JSON přesně v tomto formátu (bez markdown, bez komentářů):
{
  "followUpQuestions": [{"q": "otázka", "why": "proč je důležitá"}],
  "criticalDataToCollect": [{"item": "co zjistit", "why": "proč"}],
  "contraindicationFlags": [{"flag": "varování", "why": "proč"}],
  "recommendedNextSteps": ["krok 1", "krok 2"]
}

Počty:
- followUpQuestions: 8-15 položek
- criticalDataToCollect: 5-12 položek
- contraindicationFlags: 0-8 položek (jen pokud relevantní!)
- recommendedNextSteps: 1-3 položky`;

    const userContent = contextFromChat 
      ? `FORMULÁŘ:\n${formSummary}\n\nKONTEXT Z CHATU:\n${contextFromChat}`
      : `FORMULÁŘ:\n${formSummary}`;

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
          { role: "user", content: userContent },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "generate_triage",
              description: "Generate clinical triage analysis",
              parameters: {
                type: "object",
                properties: {
                  followUpQuestions: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        q: { type: "string" },
                        why: { type: "string" },
                      },
                      required: ["q", "why"],
                    },
                  },
                  criticalDataToCollect: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        item: { type: "string" },
                        why: { type: "string" },
                      },
                      required: ["item", "why"],
                    },
                  },
                  contraindicationFlags: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        flag: { type: "string" },
                        why: { type: "string" },
                      },
                      required: ["flag", "why"],
                    },
                  },
                  recommendedNextSteps: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                required: ["followUpQuestions", "criticalDataToCollect", "contraindicationFlags", "recommendedNextSteps"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "generate_triage" } },
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

    const triageData = JSON.parse(toolCall.function.arguments);

    return new Response(JSON.stringify(triageData), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Triage error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
