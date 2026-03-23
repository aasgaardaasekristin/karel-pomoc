import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

const MODE_PROMPTS: Record<string, string> = {
  "live-session": `Jsi supervizní mentor Karel. Hani ti posílá audio nahrávku BĚHEM ŽIVÉHO SEZENÍ.
Odpověz STRUČNĚ (max 150 slov), okamžitě použitelně:

1. **Co říct klientovi** — 1-2 věty, TUČNĚ, přesná formulace kterou Hani může použít hned
2. 📡 Postřehy z hlasu — 2-3 krátké body (tón, tempo, napětí, distres)
3. ➡️ **Další krok** — 1 věta, TUČNĚ, co udělat teď

Pravidla:
- Žádné akademické rozbory, žádné dlouhé odstavce
- Vše co je AKČNÍ INSTRUKCE piš **tučně**
- Oslovuj "Hani"
- Česky`,

  debrief: `Jsi supervizní mentor Karel. Terapeut ti posílá audio nahrávku.
Analyzuj z kontextu chatu, co je obsahem nahrávky, a přizpůsob svou analýzu:
- Pokud klient popisuje zážitek, sen nebo prožitek – analyzuj emocionální obsah, distres v hlase, změny rytmu řeči, napětí.
- Pokud terapeut trénuje odpovědi – posuď kvalitu, empatii, otevřenost otázek.
- Pokud dítě popisuje kresbu nebo zážitek – analyzuj emocionální stav, známky distresu, bezpečí v komunikaci.
Odpovídej česky, strukturovaně, s praktickými doporučeními.`,

  supervision: `Jsi supervizní mentor Karel ve režimu supervizní reflexe. Terapeut ti posílá audio nahrávku.
Analyzuj z kontextu chatu, co je obsahem:
- Pokud terapeut simuluje/trénuje odpovědi – posuď faktickou správnost, kvalitu terapeutické komunikace, otevřené otázky, validaci, reflexi.
- Pokud jde o nahrávku ze sezení – analyzuj tón hlasu, empatii, protipřenos, dynamiku vztahu.
- Pokud klient popisuje prožitek – detekuj distres, změny rytmu řeči, emocionální náboj.
Odpovídej česky, strukturovaně, s konkrétním hodnocením a doporučeními.`,

  safety: `Jsi supervizní mentor Karel v režimu Bezpečnost a hranice. Terapeut ti posílá audio nahrávku.
Analyzuj:
1. Dodržování hranic v komunikaci.
2. Potenciální rizikové signály (sebepoškození, suicidalita, agrese, distres v hlase).
3. Míru bezpečí v terapeutickém vztahu.
4. Změny v tónu, rytmu řeči, napětí.
5. Doporučení pro další postup, případně dokumentaci.
Odpovídej česky, věcně a strukturovaně.`,

  childcare: `Jsi supervizní mentor Karel v režimu Péče o dítě s DID. Terapeut/pečovatel ti posílá audio nahrávku.
Analyzuj:
1. Komunikaci s dítětem/alterem – je bezpečná, validující, přiměřená?
2. Emocionální tón – klid, trpělivost, regulace.
3. Známky přepínání, dysregulace, distresu v hlase.
4. Změny rytmu řeči, napětí, známky emočního přetížení.
5. Co funguje dobře a co by pečovatel mohl zkusit jinak.
Odpovídej česky, empaticky, s konkrétními tipy.`,
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { audioBase64, mode, chatContext, didMode, partName, didSubMode, systemContext } = await req.json();

    if (!audioBase64) {
      return new Response(JSON.stringify({ error: "Chybí audio data" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    let systemPrompt = MODE_PROMPTS[mode] || MODE_PROMPTS.debrief;
    
    // Enhance with DID-specific tandem context
    if (didMode && partName) {
      systemPrompt += `\n\n═══ TANDEM REŽIM: AUDIO ANALÝZA SEZENÍ S ČÁSTÍ ═══\nPrávě analyzuješ audio ze sezení mamky s částí "${partName}".
Zaměř se na:
- Jak část komunikuje (tón, tempo, slovní zásoba, přepínání)
- Zda je mamka v kontaktu – validuje, netlačí, respektuje hranice
- Známky dysregulace nebo přepnutí na jinou část
- Konkrétní rady pro mamku: co říct, co NEŘÍKAT, jak pokračovat
- Pokud je to relevantní, navrhni konkrétní aktivitu/hru pro stabilizaci`;
    }
    
    if (systemContext) {
      systemPrompt += `\n\n═══ KONTEXT Z KARTOTÉKY DID ═══\n${systemContext}`;
    }

    const userContent: any[] = [
      {
        type: "input_audio",
        input_audio: {
          data: audioBase64,
          format: "webm",
        },
      },
    ];

    if (chatContext) {
      userContent.push({
        type: "text",
        text: `Kontext z probíhajícího chatu (posledních několik zpráv):\n${chatContext}\n\nNyní analyzuj přiloženou audio nahrávku v kontextu výše.`,
      });
    } else {
      userContent.push({
        type: "text",
        text: "Analyzuj prosím tuto audio nahrávku.",
      });
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
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
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

    const data = await response.json();
    const analysis = data.choices?.[0]?.message?.content || "Nepodařilo se analyzovat audio.";

    return new Response(JSON.stringify({ analysis }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Audio analysis error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
