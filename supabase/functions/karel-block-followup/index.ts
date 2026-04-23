/**
 * karel-block-followup
 * --------------------
 * Turn-by-turn diagnostický chat pod jedním bodem programu.
 *
 * Hana zapsala další reakci (např. "Tundrupek na slovo MÁMA řekl: tma")
 * a Karel rozhoduje:
 *   - co říct dál (další slovo / další otázka / další instrukce)
 *   - co ještě potřebuje pozorovat
 *   - jestli má bod dost dat pro analýzu (done: true) a chybějící artefakty
 *
 * Vstup:
 *   {
 *     part_name: string,
 *     therapist_name: string,
 *     program_block: { index, text, detail? },
 *     research?: ResearchOutput,           // z karel-block-research (pomůcky, kritéria, artefakty)
 *     turns: { from: "karel" | "hana", text: string, ts?: string }[],
 *     trigger?: "auto_next" | "ask_karel" | "user_input",
 *   }
 *
 * Výstup:
 *   {
 *     karel_text: string,                  // Karlův příští input (slovo / otázka / instrukce)
 *     done: boolean,                       // má Karel dost dat?
 *     missing_artifacts?: ("image"|"audio")[],
 *     suggested_close_message?: string,    // závěrečné shrnutí pro Hanu
 *   }
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "missing auth" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const partName = String(body?.part_name ?? "").trim();
    const therapistName = String(body?.therapist_name ?? "Hanka").trim();
    const block = body?.program_block ?? null;
    const research = body?.research ?? null;
    const turns: { from: string; text: string; ts?: string }[] = Array.isArray(body?.turns) ? body.turns : [];
    const trigger = String(body?.trigger ?? "user_input");

    if (!partName || !block?.text) {
      return new Response(JSON.stringify({ error: "bad input" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const therapistAddr = therapistName === "Káťa" ? "Káťo" : "Hani";
    const blockNum = typeof block.index === "number" ? block.index + 1 : "?";

    const turnsText = turns.length
      ? turns
          .slice(-30)
          .map((t, i) => `${i + 1}. [${t.from === "karel" ? "KAREL" : "HANA"}]: ${String(t.text).slice(0, 400)}`)
          .join("\n")
      : "(zatím žádné turny)";

    const researchBlock = research
      ? `═══ ODBORNÁ REŠERŠE PRO TENTO BOD ═══
METODA: ${research.method_label ?? "—"}
POMŮCKY: ${(research.supplies ?? []).join(", ") || "—"}
INSTRUKCE PRO DÍTĚ: ${research.setup_instruction ?? "—"}
CO SLEDOVAT (DIAG. KRITÉRIA):
${(research.observe_criteria ?? []).map((c: string, i: number) => `  ${i + 1}. ${c}`).join("\n")}
POŽADOVANÉ ARTEFAKTY: ${(research.expected_artifacts ?? []).join(", ") || "text"}
DOPORUČENÉ FOLLOW-UP OTÁZKY:
${(research.followup_questions ?? []).map((q: string, i: number) => `  ${i + 1}. ${q}`).join("\n")}
`
      : "";

    const tools = [
      {
        type: "function",
        function: {
          name: "emit_followup",
          description: "Vrátí Karlovu příští reakci ve struktuře.",
          parameters: {
            type: "object",
            properties: {
              karel_text: {
                type: "string",
                description:
                  "Co Karel teď říká Haně. Buď další slovo (asociace), další otázka (co u toho sleduj), instrukce, NEBO závěrečná věta když je hotovo. Krátce, použitelně hned.",
              },
              done: {
                type: "boolean",
                description: "True jen když má Karel dost dat z tohoto bodu pro klinickou analýzu.",
              },
              missing_artifacts: {
                type: "array",
                items: { type: "string", enum: ["image", "audio"] },
                description: "Pokud done=true, ale chybí artefakty (foto kresby, audio nahrávka), uveď je.",
              },
              suggested_close_message: {
                type: "string",
                description: "Pokud done=true, krátké uzavírací shrnutí pro Hanu (1-2 věty).",
              },
            },
            required: ["karel_text", "done"],
            additionalProperties: false,
          },
        },
      },
    ];

    const sysPrompt = `Jsi Karel — klinický psycholog/psychoterapeut a partner ${therapistName === "Káťa" ? "Káti" : "Hany"} v živém DID sezení. Vedeš ji bod-po-bodu programem. Tvoje role v tomto turn-by-turn dialogu:

1. Po každé Hanině reakci (zápis Tundrupkovy odpovědi / pozorování) okamžitě reaguješ DALŠÍM krokem — dalším slovem v asociaci, další diagnostickou otázkou („Hani všímej si, jestli tlak tužky teď zesílil"), další instrukcí.
2. Tvoje otázky musí být PŘESNĚ TY, které potřebuje znát klinický psycholog/psychiatr/psychoterapeut/odborník na DID pro validní analýzu této metody (viz Odborná rešerše níže).
3. Hana ti zapisuje co Tundrupek říká/dělá — ty z toho čteš diagnosticky a kladeš další otázky.
4. Pokud máš dost dat (proběhla celá metoda + Hana zaznamenala odpovědi na klíčová kritéria), nastav done=true a doporuč ukončení bodu. V missing_artifacts uveď, co ještě potřebuješ uploadnout (kresbu, audio).
5. Buď KONKRÉTNÍ a STRUČNÝ. Žádné meta-rady, žádné „tiše drž prostor". Tohle je živé sezení, Hana potřebuje od tebe použitelné výstupy.

Česky, vřele, profesionálně.`;

    const userPrompt = `BOD #${blockNum} PROGRAMU: "${block.text}${block.detail ? ` — ${block.detail}` : ""}"
ČÁST: ${partName}

${researchBlock}
═══ DOSAVADNÍ TURN-BY-TURN PRŮBĚH BODU ═══
${turnsText}

═══ TRIGGER ═══
${
  trigger === "auto_next"
    ? `Hana zaznamenala další reakci. Vyrob DALŠÍ krok (další slovo / otázka / instrukce). Pokud byla zaznamenána všechna potřebná data k metodě, nastav done=true.`
    : trigger === "ask_karel"
    ? `Hana se tě explicitně ptá: "Karle, na co se mám teď zeptat / co mám teď dělat?". Vyrob konkrétní další krok.`
    : `Hana ti poslala input. Reaguj — buď další otázkou nebo dalším diagnostickým krokem.`
}

${turns.length === 0 ? "TOHLE JE PRVNÍ TURN — vyrob úplně první otázku/slovo/instrukci pro Hanu." : ""}`;

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: userPrompt },
        ],
        tools,
        tool_choice: { type: "function", function: { name: "emit_followup" } },
        temperature: 0.6,
      }),
    });

    if (!aiRes.ok) {
      const t = await aiRes.text();
      console.error("[block-followup] AI error", aiRes.status, t);
      if (aiRes.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiRes.status === 402) {
        return new Response(JSON.stringify({ error: "Lovable AI kredit vyčerpán." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: `ai gateway ${aiRes.status}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiRes.json();
    const toolCall = aiData?.choices?.[0]?.message?.tool_calls?.[0];
    const argsStr = toolCall?.function?.arguments;
    let parsed: any = {};
    try {
      if (argsStr) parsed = JSON.parse(argsStr);
    } catch {
      parsed = {};
    }

    const out = {
      karel_text: String(parsed?.karel_text ?? "Pokračuj — ${therapistAddr}, zapiš mi prosím Tundrupkovu reakci.").trim(),
      done: !!parsed?.done,
      missing_artifacts: Array.isArray(parsed?.missing_artifacts)
        ? parsed.missing_artifacts.filter((x: string) => ["image", "audio"].includes(x))
        : [],
      suggested_close_message:
        typeof parsed?.suggested_close_message === "string" && parsed.suggested_close_message.trim()
          ? String(parsed.suggested_close_message).trim()
          : undefined,
    };

    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[block-followup] fatal:", e);
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
