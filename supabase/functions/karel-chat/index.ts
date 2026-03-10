import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";
import { getSystemPrompt, ConversationMode } from "./systemPrompts.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  // Auth check
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { messages, mode, didInitialContext, didSubMode, notebookProject } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // For kata submode, use dedicated kata prompt
    const effectiveMode = (mode === "childcare" && didSubMode === "kata") ? "kata" : mode;
    let systemPrompt = getSystemPrompt(effectiveMode as ConversationMode);

    // Runtime context from UI (form snapshot, live supervision instructions, etc.)
    if (typeof didInitialContext === "string" && didInitialContext.trim().length > 0) {
      systemPrompt += `\n\n═══ RUNTIME KONTEXT Z APLIKACE (DOKUMENTY Z KARTOTÉKY DID) ═══\n\n${didInitialContext}`;
    }

    // DID-specific metadata
    if ((mode === "childcare" || effectiveMode === "kata") && didSubMode) {
      systemPrompt += `\n\n═══ AKTIVNÍ PODREŽIM ═══\nAktuální didSubMode: "${didSubMode}"`;
    }

    // ═══ LANGUAGE ADAPTATION for "cast" mode ═══
    // Detect language of last user message and enforce matching response language
    let detectedLang = "";
    if (didSubMode === "cast" && messages.length >= 1) {
      const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
      const lastUserText = lastUserMsg && typeof lastUserMsg.content === "string" ? lastUserMsg.content : "";
      if (lastUserText.length > 0) {
        const hasCyrillic = /[\u0400-\u04FF]/.test(lastUserText);
        const hasNordic = /[æøåÆØÅ]/.test(lastUserText);
        const hasArabic = /[\u0600-\u06FF]/.test(lastUserText);
        const hasChinese = /[\u4e00-\u9fff]/.test(lastUserText);
        
        // More aggressive detection with more keywords
        const looksEnglish = /\b(the|is|are|was|were|have|has|had|my|your|this|that|what|how|why|do|don't|doesn't|I'm|I am|you|hello|hi|please|thank|want|need|feel|think|know|like|can|will|would|should|could|come|go|see|look|tell|say|said|because|but|and|or|not|no|yes|okay|ok|hey|sorry|help|name|where|when|who)\b/i.test(lastUserText);
        const looksGerman = /\b(ich|bin|ist|das|die|der|und|nicht|ein|eine|haben|sein|mir|mich|wie|was|warum|hallo|bitte|danke|gut|schlecht|ja|nein|kann|will|muss|soll|hier|dort|heute|morgen|gehen|kommen|sagen|machen)\b/i.test(lastUserText);
        const looksNorwegian = /\b(jeg|er|det|og|ikke|har|vil|kan|med|fra|hei|takk|hva|hvorfor|fordi|meg|deg|han|hun|den|denne|skal|må|bli|være|gå|komme|si|gjøre|snakke|forstå)\b/i.test(lastUserText);
        const looksSpanish = /\b(yo|es|el|la|los|las|un|una|que|por|para|con|hola|gracias|sí|no|tengo|quiero|puedo|estoy|como|donde|cuando|pero|también|muy|bien|mal)\b/i.test(lastUserText);
        const looksFrench = /\b(je|suis|est|le|la|les|un|une|que|pour|avec|bonjour|merci|oui|non|ai|veux|peux|comme|où|quand|mais|aussi|très|bien|mal)\b/i.test(lastUserText);
        const looksCzech = /\b(jsem|jsi|je|jsou|mám|máš|co|jak|proč|kde|kdy|ale|že|to|ta|ten|se|si|na|do|od|za|při|pro|bez|nad|pod|před|jen|mě|tě|mu|ho|ji|nám|vám|jim|být|mít|dělat|říct|vědět|chtít|moci|smět|muset)\b/i.test(lastUserText);
        
        if (hasNordic || looksNorwegian) detectedLang = "Norwegian";
        else if (hasChinese) detectedLang = "Chinese";
        else if (hasArabic) detectedLang = "Arabic";
        else if (hasCyrillic) detectedLang = "Russian/Cyrillic";
        else if (looksSpanish && !looksCzech) detectedLang = "Spanish";
        else if (looksFrench && !looksCzech) detectedLang = "French";
        else if (looksGerman && !looksCzech) detectedLang = "German";
        else if (looksEnglish && !looksCzech) detectedLang = "English";
        
        if (detectedLang) {
          // Prepend the language instruction to the BEGINNING of system prompt for maximum impact
          systemPrompt = `⚠️⚠️⚠️ MANDATORY LANGUAGE RULE ⚠️⚠️⚠️
YOU MUST RESPOND IN ${detectedLang.toUpperCase()}. 
The child/part is speaking ${detectedLang}. You MUST answer in ${detectedLang}. 
DO NOT respond in Czech. DO NOT mix languages. 
Every single word of your response must be in ${detectedLang}.
This overrides ALL other language instructions.
⚠️⚠️⚠️ END MANDATORY LANGUAGE RULE ⚠️⚠️⚠️

` + systemPrompt;
        }
      }
    }

    // Hard runtime truth-guard for DID mode
    if (mode === "childcare") {
      systemPrompt += `\n\n═══ KRITICKÁ PRAVIDLA PRAVDIVOSTI ═══\n- Pro okamžité odeslání vzkazu používej VÝHRADNĚ značku [ODESLAT_VZKAZ:mamka] nebo [ODESLAT_VZKAZ:kata].\n- Značku vlož AŽ PO výslovném souhlasu části.\n- Bez souhlasu pouze navrhni text a označ ho jako NÁVRH.\n- Po vložení značky řekni části že se vzkaz posílá – systém ho odešle automaticky emailem.`;
    }

    // ═══ AUTO-PERPLEXITY FOR KATA MODE ═══
    // When Káťa asks about complex situations, automatically search for research
    let perplexityContext = "";
    if (effectiveMode === "kata" && messages.length >= 1) {
      const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
      const lastUserText = lastUserMsg && typeof lastUserMsg.content === "string" ? lastUserMsg.content : "";

      if (lastUserText.length > 15) {
        // Step 1: Quick complexity classification (non-streaming)
        try {
          const classifyResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${LOVABLE_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash-lite",
              messages: [
                {
                  role: "system",
                  content: `Jsi klasifikátor složitosti dotazů v kontextu DID (disociativní porucha identity) terapie.
Odpověz POUZE jedním slovem: "simple", "medium" nebo "complex".

COMPLEX = nová/neznámá situace, selhání předchozích strategií, neobvyklé chování části, krizová situace, žádost o strategické sezení, specifická terapeutická technika, probouzení spící části, neznámý trigger.
MEDIUM = konkrétní dotaz na práci s částí, plánování aktivity, žádost o postup.
SIMPLE = obecný dotaz, pozdrav, potvrzení, krátká otázka.`,
                },
                { role: "user", content: lastUserText },
              ],
            }),
          });

          if (classifyResponse.ok) {
            const classifyData = await classifyResponse.json();
            const complexity = (classifyData.choices?.[0]?.message?.content || "").trim().toLowerCase();
            console.log("Kata complexity classification:", complexity, "for:", lastUserText.slice(0, 80));

            // Step 2: If complex or medium, call Perplexity
            if (complexity.includes("complex") || complexity.includes("medium")) {
              const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
              if (PERPLEXITY_API_KEY) {
                try {
                  // Extract part name from context or message
                  const partNameMatch = lastUserText.match(/(?:s|o|pro|na)\s+(\w+(?:em|kem|ou|kou|ím|em)?)/i);
                  const enrichedQuery = `DID terapie dětí: ${lastUserText.slice(0, 200)}. Terapeutické techniky, hry, strategie, desenzibilizace, grounding, attachment.`;

                  const perplexityResponse = await fetch("https://api.perplexity.ai/chat/completions", {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      model: "sonar",
                      messages: [
                        {
                          role: "system",
                          content: `Vyhledej odborné zdroje o DID (disociativní porucha identity) u dětí relevantní k dotazu. Zaměř se na:
- Konkrétní terapeutické techniky a metody (IFS, EMDR, sensomotorická terapie, hrová terapie)
- Praktické aktivity a hry pro práci s částmi/altery
- Stabilizační a grounding techniky přizpůsobené dětem
- Attachment-based intervence
Odpověz v češtině. Buď stručný a praktický. Max 500 slov.`,
                        },
                        { role: "user", content: enrichedQuery },
                      ],
                      search_recency_filter: "year",
                    }),
                  });

                  if (perplexityResponse.ok) {
                    const perplexityData = await perplexityResponse.json();
                    const searchResults = perplexityData.choices?.[0]?.message?.content || "";
                    const citations = perplexityData.citations || [];
                    if (searchResults) {
                      perplexityContext = `\n\n═══ AUTOMATICKÁ REŠERŠE (Perplexity – relevantní výzkumy a metody) ═══\n${searchResults}`;
                      if (citations.length > 0) {
                        perplexityContext += `\n\nZdroje:\n${citations.map((c: string, i: number) => `[${i + 1}] ${c}`).join("\n")}`;
                      }
                      perplexityContext += `\n\n═══ INSTRUKCE: Výše uvedené výsledky rešerše VČLEŇ do své odpovědi Káťě. Cituj pouze zdroje z rešerše. Navrhni konkrétní techniky/hry na základě nalezených metod. ═══`;
                      console.log("Perplexity auto-research added for kata mode, length:", perplexityContext.length);
                    }
                  } else {
                    console.warn("Perplexity call failed:", perplexityResponse.status);
                  }
                } catch (e) {
                  console.warn("Perplexity auto-research error:", e);
                }
              }
            }
          }
        } catch (e) {
          console.warn("Complexity classification error:", e);
        }
      }
    }

    // Append Perplexity context to system prompt if available
    if (perplexityContext) {
      systemPrompt += perplexityContext;
    }

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
          ...messages.map((m: any) => {
            // Pass through multimodal content arrays as-is (OpenAI vision format)
            if (Array.isArray(m.content)) {
              return { role: m.role, content: m.content };
            }
            return m;
          }),
        ],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limits exceeded" }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Payment required" }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const text = await response.text();
      console.error("AI gateway error:", response.status, text);
      return new Response(JSON.stringify({ error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (error) {
    console.error("Karel chat error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
