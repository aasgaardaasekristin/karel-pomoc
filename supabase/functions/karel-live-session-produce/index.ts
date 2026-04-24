/**
 * karel-live-session-produce
 * --------------------------
 * THERAPIST-LED LIVE PASS (2026-04-23) — content-producing endpoint.
 *
 * Na rozdíl od `karel-live-session-feedback` (která vrací tichou meta-radu)
 * tato funkce vyrobí KONKRÉTNÍ OBSAH pro daný bod programu:
 *   - asociační slova ("rodinné ozvěny — 8 slov")
 *   - barvy / otázky ("kdyby únava měla barvu...")
 *   - instrukce pro kresbu ("nakresli strážce spánku...")
 *   - free-form direktivu pro Hanku
 *
 * Vstup:
 *   {
 *     part_name: string,
 *     therapist_name: "Hanka" | "Káťa",
 *     program_block: { index: number, text: string, detail?: string },
 *     plan_context?: string,        // celý plán pro kontext (zkráceno na 2000 chars)
 *     observation_so_far?: string,  // co Hanka už zaznamenala u tohoto bodu
 *     user_request?: string,        // přímá výzva ("napiš mi ty slova")
 *   }
 *
 * Výstup:
 *   {
 *     karel_content: string,       // formátovaný text pro Hanku
 *     kind: "words_list"|"questions"|"instruction"|"free",
 *     items?: string[],             // pro words_list / questions: rozparsovaný seznam
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

function classifyKind(blockText: string, userRequest: string): "words_list" | "questions" | "instruction" | "free" {
  const t = `${blockText} ${userRequest}`.toLowerCase();
  // explicit numeric hint: "8 slov", "5 slov"
  if (/\b\d+\s*slov/i.test(t) || /asocia[čc]n/.test(t) || /asociac/.test(t)) return "words_list";
  if (/\botázk|\botazk|zeptej|zeptat|polož|polo[zž]/.test(t)) return "questions";
  if (/nakresl|kresb|nama luj|namaluj|kresl[íi]me|nakresl[íi]me/.test(t)) return "instruction";
  if (/barv|mapa|tělo|sk[áa]la|skal/.test(t)) return "questions";
  return "free";
}

function parseList(text: string): string[] {
  // rozparsuje očíslovaný / odrážkový seznam na položky
  const lines = text.split(/\r?\n/);
  const items: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const m = /^(?:\d+[.)]|[-*•])\s+(.+)$/.exec(line);
    if (m) {
      const cleaned = m[1].replace(/[*_`]/g, "").trim();
      if (cleaned.length > 0) items.push(cleaned);
    }
  }
  return items;
}

function fallbackContent(kind: ReturnType<typeof classifyKind>, blockNum: string, partName: string, therapistName: string) {
  const addr = therapistName === "Káťa" ? "Káťo" : "Hani";
  if (kind === "words_list") {
    return `🎯 Nouzová sada pro bod #${blockNum} — použij klidně, jedno po druhém:\n1. hrad\n2. motor\n3. vítr\n4. klíč\n5. brnění\n6. cíl\n\n${addr}, sleduj hlavně latenci, doslovnou první asociaci, opravy odpovědi a slova, která ${partName} vynechá nebo odmítne.`;
  }
  if (kind === "questions") {
    return `🎯 Otázky pro ${partName}:\n1. „Co se ti u toho vybavilo jako první?“\n2. „Bylo u něčeho divně v těle?“\n3. „Je něco, co k tomu nechceš říct nahlas?“\n\n${addr}, drž tempo pomalu a neuzavírej výklad během sezení.`;
  }
  if (kind === "instruction") {
    return `🎯 Co řekni ${partName}:\n„Zkus nakreslit nebo ukázat jen to, co je teď nejdůležitější — nemusí to být hezké ani celé.“\n\n👀 Sleduj pořadí detailů, tlak, vynechaná místa a spontánní komentáře.`;
  }
  return `${addr}, AI je teď přetížená, takže použij bezpečný postup: polož jednu konkrétní otázku, zapisuj doslovné formulace a latenci, a interpretaci nech až po sezení.`;
}

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
    const programBlock = body?.program_block ?? null;
    const planContext = String(body?.plan_context ?? "").slice(0, 2000);
    const observationSoFar = String(body?.observation_so_far ?? "").slice(0, 800);
    const userRequest = String(body?.user_request ?? "").slice(0, 400);

    if (!partName || !programBlock?.text) {
      return new Response(JSON.stringify({ error: "bad input — need part_name + program_block.text" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const kind = classifyKind(programBlock.text, userRequest);
    const blockNum = typeof programBlock.index === "number" ? programBlock.index + 1 : "?";
    const blockText = String(programBlock.text).slice(0, 600);
    const blockDetail = programBlock.detail ? String(programBlock.detail).slice(0, 600) : "";

    const therapistAddr = therapistName === "Káťa" ? "Káťo" : "Hani";

    const kindInstructions: Record<typeof kind, string> = {
      words_list: `Vyrob KONKRÉTNÍ ASOCIAČNÍ SLOVA, která má ${therapistAddr} tiše říkat ${partName}. Pokud bod říká "8 slov", dej PŘESNĚ 8 slov. Formát:
🎯 Slova k použití (řekni je ${partName} jedno po druhém, nech ho vždy odpovědět prvním nápadem):
1. <slovo>
2. <slovo>
…
Pak 1 věta jak je předávat (tempo, tón, co sledovat).`,

      questions: `Vyrob 3-5 KONKRÉTNÍCH OTÁZEK pro tento bod, formulovaných tak, aby ${therapistAddr} mohla rovnou číst nahlas. Formát:
🎯 Otázky pro ${partName}:
1. „<otázka>"
2. „<otázka>"
…
Pak 1 věta co u odpovědí sledovat.`,

      instruction: `Vyrob KONKRÉTNÍ instrukci k aktivitě (kresba / pohyb / hra). Formát:
🎯 Co řekni ${partName} (přesná věta):
„<instrukce>"

🛠️ Pomůcky / setup (pokud jsou potřeba): <stručně>

👀 Co u toho pozoruj: <2-3 věci>`,

      free: `Vyrob ${therapistAddr} přesný plán PROVEDENÍ tohoto bodu — co konkrétně řekne, udělá, čemu věnuje pozornost. Žádné meta-rady, žádné „tiše drž prostor". 4-6 řádků, direktivně.`,
    };

    const prompt = `Jsi Karel — terapeutický kolega ${therapistName === "Káťa" ? "Káti" : "Hany"}. Sedíš vedle ní u živého sezení s DID částí "${partName}" a teď spouští BOD #${blockNum} programu.

═══ AKTUÁLNÍ BOD ═══
${blockText}${blockDetail ? `\nDetail: ${blockDetail}` : ""}

${planContext ? `═══ CELÝ PLÁN (kontext) ═══\n${planContext}\n` : ""}${observationSoFar ? `═══ CO ${therapistAddr.toUpperCase()} UŽ ZAZNAMENALA U TOHOTO BODU ═══\n${observationSoFar}\n` : ""}${userRequest ? `═══ PŘÍMÁ VÝZVA OD ${therapistAddr.toUpperCase()} ═══\n"${userRequest}"\n` : ""}
═══ TVOJE ÚLOHA ═══
${kindInstructions[kind]}

PRAVIDLA:
- Buď konkrétní, použitelný HNED. Ne abstrakce, ne meta-poznámky.
- Žádné "Bez zásahu" ani "tiše drž prostor" — Hana tě teď VOLÁ jako partnera, který má vyrobit obsah.
- Respektuj věk a vývojovou úroveň části "${partName}".
- Česky. Lehce, vřele, profesionálně.`;

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content:
              "Jsi Karel — content-producing terapeutický partner. Když dostaneš bod programu, vyrobíš PŘESNÝ OBSAH (slova / otázky / instrukci), ne meta-radu. Žádné tiché pozorování, žádné odmítnutí.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.75,
        max_tokens: 700,
      }),
    });

    if (!aiRes.ok) {
      const t = await aiRes.text();
      console.error("[live-produce] AI error", aiRes.status, t);
      if (aiRes.status === 429 || aiRes.status === 402 || aiRes.status >= 500) {
        const content = fallbackContent(kind, String(blockNum), partName, therapistName);
        return new Response(JSON.stringify({
          karel_content: content,
          kind,
          items: (kind === "words_list" || kind === "questions") ? parseList(content) : undefined,
          fallback: true,
          reason: aiRes.status === 429 ? "AI_RATE_LIMITED" : aiRes.status === 402 ? "AI_CREDITS_REQUIRED" : "AI_SERVICE_UNAVAILABLE",
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: `ai gateway ${aiRes.status}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiRes.json();
    const content = String(aiData?.choices?.[0]?.message?.content ?? "").trim();
    const items = (kind === "words_list" || kind === "questions") ? parseList(content) : undefined;

    return new Response(
      JSON.stringify({
        karel_content: content || `(Karel teď nemá co vyrobit pro bod #${blockNum} — zkus to prosím znovu.)`,
        kind,
        items,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e: any) {
    console.error("[live-produce] fatal:", e);
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
