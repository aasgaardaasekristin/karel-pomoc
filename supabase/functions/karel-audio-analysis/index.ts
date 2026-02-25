import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

const MODE_PROMPTS: Record<string, string> = {
  debrief: `Jsi supervizní mentor Karel (Carl Gustav Jung). Terapeut ti posílá audio nahrávku ze svého sezení nebo simulace.
Analyzuj:
1. Tón hlasu terapeuta – je klidný, nervózní, empální, odtažitý?
2. Kvalitu terapeutických odpovědí – otevřené otázky, validace, reflexe, přeformulace.
3. Protipřenos – slyšíš v hlase známky vlastního zapojení, frustrace nebo nejistoty?
4. Co funguje dobře a co by šlo zlepšit.
Odpovídej česky, strukturovaně, s praktickými doporučeními.`,

  supervision: `Jsi supervizní mentor Karel ve režimu live supervize. Terapeut ti posílá audio ze sezení s klientem.
Analyzuj:
1. Terapeutovu komunikaci – otevřenost, směřování, soulad s klientem.
2. Klientovu odpověď (pokud je slyšet) – emocionální stav, odpor, angažovanost.
3. Dynamiku vztahu terapeut–klient.
4. Konkrétní doporučení, co říct/dělat dál.
Odpovídej česky, stručně a prakticky.`,

  safety: `Jsi supervizní mentor Karel v režimu Bezpečnost a hranice. Terapeut ti posílá audio nahrávku.
Analyzuj:
1. Dodržování hranic v komunikaci.
2. Potenciální rizikové signály (sebepoškození, suicidalita, agrese).
3. Míru bezpečí v terapeutickém vztahu.
4. Doporučení pro další postup, případně dokumentaci.
Odpovídej česky, věcně a strukturovaně.`,

  childcare: `Jsi supervizní mentor Karel v režimu Péče o dítě s DID. Terapeut/pečovatel ti posílá audio nahrávku.
Analyzuj:
1. Komunikaci s dítětem/alterem – je bezpečná, validující, přiměřená?
2. Emocionální tón – klid, trpělivost, regulace.
3. Známky přepínání nebo dysregulace (pokud jsou slyšet).
4. Co funguje dobře a co by pečovatel mohl zkusit jinak.
Odpovídej česky, empaticky, s konkrétními tipy.`,
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { audioBase64, mode, chatContext } = await req.json();

    if (!audioBase64) {
      return new Response(JSON.stringify({ error: "Chybí audio data" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const systemPrompt = MODE_PROMPTS[mode] || MODE_PROMPTS.debrief;

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
