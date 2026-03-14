import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { chatMessages, formData, clientName, voiceAnalyses } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const formSnapshot = [
      formData.contactFullName && `Kontakt: ${formData.contactFullName}`,
      formData.contactEmail && `Email: ${formData.contactEmail}`,
      formData.contactPhone && `Tel: ${formData.contactPhone}`,
      formData.isMinor ? `Nezletilý klient` : null,
      formData.isMinor && formData.childFullName && `Dítě: ${formData.childFullName}`,
      formData.clientAge && `Věk: ${formData.clientAge}`,
      formData.isMinor && formData.guardianFullName && `Zákonný zástupce: ${formData.guardianFullName}`,
      formData.context && `Kontext: ${formData.context}`,
      formData.keyTheme && `Klíčové téma: ${formData.keyTheme}`,
      formData.therapistEmotions?.length > 0 && `Emoce terapeuta: ${formData.therapistEmotions.join(", ")}`,
      formData.therapistEmotionsOther && `Další emoce: ${formData.therapistEmotionsOther}`,
      formData.transference && `Přenos/protipřenos: ${formData.transference}`,
      formData.risks?.length > 0 && `Rizika: ${formData.risks.join(", ")}`,
      formData.risksOther && `Další rizika: ${formData.risksOther}`,
      formData.missingData && `Co ověřit: ${formData.missingData}`,
      formData.interventionsTried && `Vyzkoušené intervence: ${formData.interventionsTried}`,
      formData.nextSessionGoal && `Cíl dalšího sezení: ${formData.nextSessionGoal}`,
    ].filter(Boolean).join("\n");

    const chatTranscript = (chatMessages || [])
      .map((m: { role: string; content: string }) => `${m.role === "user" ? "TERAPEUT" : "KAREL"}: ${m.content}`)
      .join("\n\n");

    const systemPrompt = `Jsi Karel, zkušený klinický supervizor. Na základě přiloženého přepisu supervizního chatu a dat z formuláře vytvoř KOMPLEXNÍ KLINICKÝ REPORT ze sezení.

Report musí obsahovat tyto sekce (piš česky, odborně ale srozumitelně):

## 1. Shrnutí sezení
Stručný přehled co se dělo, kdo byl přítomen, hlavní téma.

## 2. Klinická analýza
Podrobný rozbor situace – co se odehrávalo, dynamika, pozorování.

## 3. Diagnostické úvahy
Možné diagnózy (MKN-10/DSM-5), diferenciální diagnostika, na co myslet.

## 4. Rizikové faktory
Identifikovaná rizika, jejich závažnost, ochranné faktory.

## 5. Přenos a protipřenos
Analýza přenosových a protipřenosových jevů v terapeutickém vztahu.

## 6. Použité intervence a jejich účinnost
Co bylo vyzkoušeno, jak to fungovalo.

## 7. Doporučené metody a techniky
Konkrétní terapeutické metody vhodné pro tento případ (CBT, EMDR, arteterapie, atd.).

## 8. Supervizní doporučení
Co by měl terapeut příště udělat jinak, na co si dát pozor.

## 9. Plán na příští sezení
Konkrétní kroky, cíle, aktivity pro další setkání.

## 10. Poznámky supervizora
Další postřehy, hypotézy, otevřené otázky.

Piš odborně ale prakticky. Používej konkrétní data z formuláře a chatu. NIKDY nevymýšlej údaje, které nejsou v podkladech.`;

    const userContent = `═══ DATA Z FORMULÁŘE ═══
${formSnapshot || "(prázdný formulář)"}

═══ PŘEPIS SUPERVIZNÍHO CHATU ═══
${chatTranscript || "(žádný chat)"}

Klient: ${clientName}
Datum: ${new Date().toLocaleDateString("cs-CZ")}

Vytvoř komplexní klinický report.`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        stream: false,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("AI error:", response.status, text);
      return new Response(JSON.stringify({ error: "AI error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const report = data.choices?.[0]?.message?.content || "";

    return new Response(JSON.stringify({ report }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Session report error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
