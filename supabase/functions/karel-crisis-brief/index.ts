import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { imprint } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const signalList = [];
    if (imprint.signals.hopelessness) signalList.push("beznaděj");
    if (imprint.signals.regulationFailure) signalList.push("selhání regulace");
    if (imprint.signals.helpRefusal) signalList.push("odmítnutí krizové pomoci");
    if (imprint.signals.selfHarm) signalList.push("sebepoškozování");
    if (imprint.signals.domesticThreat) signalList.push("ohrožení v domácnosti");
    if (imprint.signals.narrowedFuture) signalList.push("zúžení budoucnosti");

    const systemPrompt = `Jsi supervizní asistent Karla – mentora terapeutky. Tvým úkolem je připravit stručný KRIZOVÝ SUPERVIZNÍ BRIEF.

DŮLEŽITÉ ETICKÉ ZÁSADY:
- NEZNÁŠ identitu klienta. Nemáš žádná osobní data.
- NEřešíš klienta. Připravuješ TERAPEUTKU na možný kontakt.
- Neprovádíš diagnózu. Shrnuješ signály a doporučuješ přípravu.

FORMÁT BRIEFU:
1. PŘEHLED RIZIK – stručné shrnutí situace a detekovaných signálů
2. DOPORUČENÝ ZPŮSOB KONTAKTU – telefon/SMS/email s důvody
3. NÁVRH PRVNÍCH VĚT – 3 konkrétní věty, kterými může terapeutka zahájit kontakt
4. RIZIKOVÉ FORMULACE – na co si dát pozor, jaké výroky mohou zaznít
5. DALŠÍ DOPORUČENÉ KROKY – co připravit, na co myslet

Piš česky, stručně, věcně. Max 300 slov celkem.`;

    const userContent = `KRIZOVÝ OTISK (anonymní, bez identity):
- Scénář: ${imprint.scenario}
- Risk score: ${imprint.riskScore}
- Klíčové signály: ${signalList.length > 0 ? signalList.join(", ") : "žádné specifické"}
- Regulační pokusy: ${imprint.regulationAttempts} (úspěšné: ${imprint.regulationSuccessful ? "ano" : "ne"})
- Časová dynamika: ${imprint.timeDynamics.messageCount} zpráv, vzorec eskalace: ${imprint.timeDynamics.riskEscalationPattern}
- Most k terapeutce: ${imprint.therapistBridgeTriggered ? `aktivován (metoda: ${imprint.therapistBridgeMethod})` : "neaktivován"}
- Poznámka: ${imprint.note}

Připrav supervizní brief pro terapeutku.`;

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
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("AI gateway error:", response.status, text);
      return new Response(JSON.stringify({ error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const briefText = data.choices?.[0]?.message?.content || "";

    // Parse the brief into structured sections
    const sections = parseBrief(briefText);

    return new Response(JSON.stringify({
      riskOverview: sections.riskOverview,
      recommendedContact: sections.recommendedContact,
      suggestedOpeningLines: sections.suggestedOpeningLines,
      riskFormulations: sections.riskFormulations,
      nextSteps: sections.nextSteps,
      rawBrief: briefText,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Crisis brief error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

function parseBrief(text: string) {
  // Simple section parser - extract content between headers
  const result = {
    riskOverview: "",
    recommendedContact: "",
    suggestedOpeningLines: [] as string[],
    riskFormulations: [] as string[],
    nextSteps: [] as string[],
  };

  const lines = text.split("\n");
  let currentSection = "";

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes("přehled rizik") || lower.includes("1.")) {
      currentSection = "risk";
      continue;
    } else if (lower.includes("způsob kontaktu") || lower.includes("2.")) {
      currentSection = "contact";
      continue;
    } else if (lower.includes("prvních vět") || lower.includes("3.")) {
      currentSection = "lines";
      continue;
    } else if (lower.includes("rizikové formulace") || lower.includes("4.")) {
      currentSection = "formulations";
      continue;
    } else if (lower.includes("další") || lower.includes("kroky") || lower.includes("5.")) {
      currentSection = "steps";
      continue;
    }

    const trimmed = line.replace(/^[-*•]\s*/, "").trim();
    if (!trimmed) continue;

    switch (currentSection) {
      case "risk":
        result.riskOverview += (result.riskOverview ? " " : "") + trimmed;
        break;
      case "contact":
        result.recommendedContact += (result.recommendedContact ? " " : "") + trimmed;
        break;
      case "lines":
        if (trimmed.length > 5) result.suggestedOpeningLines.push(trimmed);
        break;
      case "formulations":
        if (trimmed.length > 5) result.riskFormulations.push(trimmed);
        break;
      case "steps":
        if (trimmed.length > 5) result.nextSteps.push(trimmed);
        break;
    }
  }

  // Fallback: if parsing failed, put everything in riskOverview
  if (!result.riskOverview && !result.recommendedContact) {
    result.riskOverview = text;
  }

  return result;
}
