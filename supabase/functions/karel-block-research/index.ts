/**
 * karel-block-research
 * --------------------
 * Pre-session odborná rešerše pro daný bod programu.
 *
 * Cíl: Karel se chová jako klinický psycholog/psychoterapeut/odborník na DID
 * a dohledá pro daný typ aktivity (asociační hra, kresba postavy, kresba stromu,
 * tělová mapa, hra s figurkami, narativní test atd.) přesné odborné parametry,
 * které potřebuje znát profesionál:
 *   - pomůcky (např. tužka HB č.2, A4 nelinkovaný papír)
 *   - přesná instrukce pro klienta
 *   - diagnostická kritéria — co u toho sledovat (např. odkud začíná kreslit,
 *     umístění na papíru, vývojová úroveň, tlak tužky)
 *   - povinné artefakty pro analýzu (foto kresby, audio, atd.)
 *   - follow-up otázky pro terapeutku během i po sezení
 *
 * Strategie:
 *   - Lehká příprava (krátký Perplexity dotaz, sonar model — levný a rychlý)
 *     proběhne při generování programu.
 *   - Hluboká rešerše (větší detail) volitelně při kliknutí „🎯 Spustit bod".
 *
 * Vstup:
 *   {
 *     part_name: string,
 *     part_age?: number,
 *     program_block: { index: number, text: string, detail?: string },
 *     depth?: "light" | "deep",         // default "light"
 *   }
 *
 * Výstup:
 *   {
 *     method_label: string,             // např. "Asociační hra (8 slov, rodina)"
 *     supplies: string[],               // ["tužka HB č.2", "A4 nelinkovaný papír", ...]
 *     setup_instruction: string,        // přesná věta co říct dítěti
 *     observe_criteria: string[],       // ["odkud začíná kreslit", "umístění na papíru", ...]
 *     expected_artifacts: ("image"|"audio"|"text")[],
 *     followup_questions: string[],     // 3-5 otázek pro terapeutku během/po sezení
 *     citations?: string[],
 *     source: "perplexity" | "fallback",
 *   }
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { detectPlaybook, type Playbook } from "../_shared/clinicalPlaybooks.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY") ?? "";
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

type ResearchOutput = {
  method_label: string;
  method_id?: string;            // pevný playbook id, pokud detekováno
  supplies: string[];
  setup_instruction: string;
  observe_criteria: string[];
  expected_artifacts: ("image" | "audio" | "text")[];
  followup_questions: string[];
  planned_steps?: string[];      // pro asoc. experiment: 8 konkrétních slov
  citations?: string[];
  source: "perplexity" | "fallback" | "ai-only" | "playbook";
};

function detectMethodHints(text: string): {
  needsImage: boolean;
  needsAudio: boolean;
  isDrawing: boolean;
  isAssociation: boolean;
  isPlay: boolean;
  isNarrative: boolean;
} {
  const t = text.toLowerCase();
  const isDrawing = /(nakresl|kresb|kresl[íi]|namaluj|portr[ée]t|strom|postav[ay]|tělov[áa] mapa|telova mapa|t[ěe]lov[áa] mapa|mandala)/.test(t);
  const isAssociation = /(asocia[čc]n|asociac|slovn[íi] hr|prvn[íi] n[áa]pad)/.test(t);
  const isPlay = /(figurk|loutk|hra s|hr[áa]me|sandtray|pískoviš|piskov)/.test(t);
  const isNarrative = /(p[řr]íb[ěe]h|narrativ|narativ|příběh|vyprav)/.test(t);
  return {
    needsImage: isDrawing || isPlay,
    needsAudio: isAssociation || isNarrative || isPlay,
    isDrawing,
    isAssociation,
    isPlay,
    isNarrative,
  };
}

function buildFallback(blockText: string, partName: string, partAge?: number): ResearchOutput {
  const hints = detectMethodHints(blockText);
  const supplies: string[] = [];
  const observe: string[] = [];
  const expected: ("image" | "audio" | "text")[] = ["text"];
  const followup: string[] = [];

  if (hints.isDrawing) {
    supplies.push("tužka HB (č.2), bez gumy", "papír A4 nelinkovaný, bílý", "klidné místo bez rušení");
    observe.push(
      "Od které části těla / objektu začíná kreslit (hlava, trup, noha, předmět)",
      "Umístění kresby na papíru (střed, dolní třetina, levý/pravý okraj)",
      "Vývojová úroveň kresby (odpovídá věku?)",
      "Tlak tužky (silný / slabý / kolísavý), škrtání, mazání",
      "Velikost postavy / objektu (nadměrná / drobná / přiměřená)",
      "Detaily (chybějící části těla, oči, ústa, ruce, prsty)",
    );
    expected.push("image");
    followup.push(
      "Sleduj prosím přesně odkud začínal kreslit — od hlavy, od trupu, od něčeho jiného?",
      "Kde na papíru kresbu umístil (střed, dolní okraj, do rohu)?",
      "Pozorovala jsi nějaké škrtání, mazání nebo váhání? U čeho konkrétně?",
      "Jak držel tužku — pevně, lehce, kolísavě?",
    );
  }
  if (hints.isAssociation) {
    supplies.push("klid v místnosti", "papír na zápis Tundrupkových reakcí (nebo audio)");
    observe.push(
      "Latence mezi mým slovem a Tundrupkovou odpovědí (rychlá / dlouhá pauza)",
      "Odpovědi jednoslovné × větné",
      "Emoční zabarvení odpovědi (neutrální, smích, napětí, ticho)",
      "Slova která vyvolala změnu tónu, mlčení, přerušení",
    );
    expected.push("audio");
    followup.push(
      "U kterých slov byla největší pauza nebo se odmlčel?",
      "Některá odpověď tě překvapila? Která?",
      "Změnil se v některém okamžiku jeho tón nebo držení těla?",
    );
  }
  if (hints.isPlay) {
    supplies.push("figurky / loutky / hračky relevantní k tématu", "vymezený herní prostor");
    observe.push(
      "Kterou figurku si vybral první a kam ji umístil",
      "Vzdálenosti mezi figurkami (blízko / odděleně / izolovaně)",
      "Akce mezi figurkami (komunikace, agrese, ochrana, ignorování)",
      "Změny scény (přesunutí, schování, vyřazení figurky)",
    );
    expected.push("image", "audio");
    followup.push(
      "Které figurce dal hlavní roli? Kterou si vybral první?",
      "Vznikl mezi figurkami nějaký konflikt nebo naopak ochrana?",
      "Schoval nebo vyřadil nějakou figurku?",
    );
  }
  if (hints.isNarrative) {
    supplies.push("klid v místnosti");
    observe.push(
      "Hlavní postava příběhu (dítě? dospělý? zvíře?)",
      "Konflikt v příběhu a způsob jeho řešení",
      "Konec příběhu — pozitivní / otevřený / katastrofický",
      "Tempo vyprávění, pauzy, návraty",
    );
    expected.push("audio");
    followup.push(
      "Jak Tundrupek příběh ukončil? Bylo to uzavřené nebo otevřené?",
      "Vystupovala v příběhu pomáhající postava?",
      "Co pro tebe bylo v příběhu nejvýraznější moment?",
    );
  }
  if (supplies.length === 0) {
    supplies.push("klidné prostředí bez rušení", "papír a tužka na zápis pozorování");
  }
  if (observe.length === 0) {
    observe.push(
      "Verbální reakce (přesné formulace, opakování slov)",
      "Neverbální reakce (mimika, držení těla, dech)",
      "Emoční stav během aktivity",
      "Změny v průběhu (otevření / uzavření / regrese)",
    );
    followup.push(
      "Co bylo v tomto bodu nejvýraznější?",
      "Vznikla nějaká emoce, která tě překvapila?",
      "Pozorovala jsi nějaký moment, kdy se něco zlomilo?",
    );
  }

  return {
    method_label: blockText.slice(0, 120),
    supplies,
    setup_instruction:
      hints.isDrawing
        ? `Posaď ${partName} ke stolu, polož před něj papír A4 (na šířku) a tužku HB. Řekni přesně: „${
            blockText.includes("postav")
              ? "Nakresli mi prosím postavu — kohokoliv, kdo tě napadne. Nemusí to být umělecké. Jak chceš."
              : blockText.includes("strom")
              ? "Nakresli mi strom. Jakýkoliv strom, který se ti vybaví."
              : "Nakresli mi něco, co ti dnes přijde na mysl."
          }" Pak ho nech v klidu kreslit, nezasahuj.`
        : hints.isAssociation
        ? `Sedni si naproti ${partName}, klidným hlasem mu řekni: „${partName}, řeknu ti slovo a ty mi řekneš to první, co ti k tomu vyskočí. Nemusíš přemýšlet. Začínáme." Karel ti pak bude napovídat slova jedno po druhém — vždy počkej na jeho reakci a zapiš ji.`
        : `Naveď ${partName} do aktivity klidně, bez tlaku. Sleduj reakci a postupně si zapisuj.`,
    observe_criteria: observe,
    expected_artifacts: Array.from(new Set(expected)),
    followup_questions: followup,
    source: "fallback",
  };
}

async function callPerplexity(prompt: string): Promise<{ content: string; citations: string[] } | null> {
  if (!PERPLEXITY_API_KEY) return null;
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
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
            content:
              "Jsi klinický psycholog se specializací na dětskou psychodiagnostiku a DID. Odpovídej VÝHRADNĚ česky, stručně, s odkazy na odbornou literaturu (Machover, Koch, Buck, Goodenough-Harris, projektivní techniky atd.).",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 1200,
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      console.warn("[block-research] Perplexity HTTP", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const content = String(data?.choices?.[0]?.message?.content ?? "").trim();
    const citations: string[] = Array.isArray(data?.citations) ? data.citations.slice(0, 8) : [];
    if (!content) return null;
    return { content, citations };
  } catch (e) {
    console.warn("[block-research] Perplexity error:", e);
    return null;
  }
}

async function structureWithAI(
  blockText: string,
  partName: string,
  partAge: number | undefined,
  perplexityRaw: string | null,
): Promise<ResearchOutput | null> {
  // Použijeme Lovable AI gateway pro strukturaci do JSON pomocí tool calling.
  try {
    const tools = [
      {
        type: "function",
        function: {
          name: "emit_block_research",
          description: "Vrátí odbornou rešerši k diagnostické aktivitě.",
          parameters: {
            type: "object",
            properties: {
              method_label: { type: "string", description: "Krátký název metody (např. 'Kresba postavy podle Machover')" },
              supplies: {
                type: "array",
                items: { type: "string" },
                description: "Konkrétní pomůcky (typ tužky, papíru, pomůcek).",
              },
              setup_instruction: {
                type: "string",
                description: "Přesná věta, kterou má terapeutka říct dítěti, plus jak rozmístit pomůcky.",
              },
              observe_criteria: {
                type: "array",
                items: { type: "string" },
                description: "Co přesně sledovat během aktivity (5-8 položek).",
              },
              expected_artifacts: {
                type: "array",
                items: { type: "string", enum: ["image", "audio", "text"] },
                description: "Jaké artefakty Karel pro analýzu potřebuje.",
              },
              followup_questions: {
                type: "array",
                items: { type: "string" },
                description: "3-5 otázek pro terapeutku během / po aktivitě (česky, krátce).",
              },
              planned_steps: {
                type: "array",
                items: { type: "string" },
                description: "JEN PRO ASOCIAČNÍ EXPERIMENT: přesně 8 konkrétních stimulačních slov vázaných k tématu bodu programu (mix neutrálních a afektivních, na míru části a věku). Pro ostatní metody nech prázdné.",
              },
            },
            required: [
              "method_label",
              "supplies",
              "setup_instruction",
              "observe_criteria",
              "expected_artifacts",
              "followup_questions",
            ],
            additionalProperties: false,
          },
        },
      },
    ];

    const userPrompt = `BOD PROGRAMU SEZENÍ S DID ČÁSTÍ "${partName}"${partAge ? ` (věk ${partAge})` : ""}:
"${blockText}"

${perplexityRaw ? `ODBORNÁ REŠERŠE Z PERPLEXITY:\n${perplexityRaw}\n` : ""}

Tvůj úkol: Vrať mi přesné odborné parametry pro tuto diagnostickou aktivitu tak, jak je potřebuje znát klinický psycholog/psychoterapeut/odborník na DID. Konkrétně:
1. method_label — odborný název metody
2. supplies — KONKRÉTNÍ pomůcky (typ tužky, formát papíru, hračky atd.)
3. setup_instruction — PŘESNÁ věta, kterou má terapeutka říct dítěti, + jak rozmístit pomůcky
4. observe_criteria — 5-8 KONKRÉTNÍCH diagnostických bodů, co u toho sledovat (odkud začíná kreslit, umístění, tlak tužky, latence odpovědí, neverbální signály...)
5. expected_artifacts — co bude Karel potřebovat ke kvalitní analýze (image / audio / text)
6. followup_questions — 3-5 otázek pro terapeutku během/po aktivitě, ať Karel získá přesně to, co potřebuje k validní analýze

Žádné obecné fráze. Je-li to kresebný test, uveď přesné parametry (HB tužka, A4 nelinkovaný apod.).
Je-li to asociační hra, uveď co sledovat v reakcích.`;

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content:
              "Jsi klinický psycholog. Strukturuj odborná data do požadovaného JSON přes tool call emit_block_research.",
          },
          { role: "user", content: userPrompt },
        ],
        tools,
        tool_choice: { type: "function", function: { name: "emit_block_research" } },
        temperature: 0.3,
      }),
    });
    if (!aiRes.ok) {
      console.warn("[block-research] AI HTTP", aiRes.status, await aiRes.text());
      return null;
    }
    const aiData = await aiRes.json();
    const toolCall = aiData?.choices?.[0]?.message?.tool_calls?.[0];
    const argsStr = toolCall?.function?.arguments;
    if (!argsStr) return null;
    const args = JSON.parse(argsStr);
    return {
      method_label: String(args.method_label ?? blockText.slice(0, 120)),
      supplies: Array.isArray(args.supplies) ? args.supplies.map(String) : [],
      setup_instruction: String(args.setup_instruction ?? ""),
      observe_criteria: Array.isArray(args.observe_criteria) ? args.observe_criteria.map(String) : [],
      expected_artifacts: Array.isArray(args.expected_artifacts)
        ? args.expected_artifacts.filter((x: string) => ["image", "audio", "text"].includes(x))
        : ["text"],
      followup_questions: Array.isArray(args.followup_questions) ? args.followup_questions.map(String) : [],
      source: perplexityRaw ? "perplexity" : "ai-only",
    };
  } catch (e) {
    console.warn("[block-research] structureWithAI error:", e);
    return null;
  }
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
    const partAge = typeof body?.part_age === "number" ? body.part_age : undefined;
    const block = body?.program_block ?? null;
    const depth = body?.depth === "deep" ? "deep" : "light";

    if (!partName || !block?.text) {
      return new Response(
        JSON.stringify({ error: "bad input — need part_name + program_block.text" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const blockText = String(block.text + (block.detail ? ` — ${block.detail}` : "")).slice(0, 600);

    // 1) Perplexity rešerše (jen u depth=deep nebo když je to evidentně diagnostický test)
    let perplexity: { content: string; citations: string[] } | null = null;
    const hints = detectMethodHints(blockText);
    const isDiagnostic = hints.isDrawing || hints.isAssociation || hints.isPlay || hints.isNarrative;
    if (depth === "deep" || isDiagnostic) {
      const ppPrompt = `Jaké jsou přesné odborné parametry pro tuto diagnostickou aktivitu s dítětem (${partAge ? `věk ${partAge}` : "věk nezveřejněn"})?

"${blockText}"

Odpověz česky a stručně:
1) Konkrétní pomůcky (typ tužky, papíru, hraček).
2) Přesná instrukce, kterou má terapeut říct dítěti.
3) Diagnostická kritéria — co sledovat během aktivity (např. odkud začíná kreslit, umístění na papíru, tlak tužky, vývojová úroveň, latence odpovědí, neverbální signály).
4) Jaké artefakty pro validní klinickou analýzu (foto kresby, audio, video, zápis odpovědí).

Cituj odbornou literaturu, kde je to relevantní (Machover, Koch, Buck, projektivní techniky, ICD-11, odborné články).`;

      perplexity = await callPerplexity(ppPrompt);
    }

    // 2) Strukturace přes Lovable AI (vždy)
    const structured = await structureWithAI(blockText, partName, partAge, perplexity?.content ?? null);

    let result: ResearchOutput;
    if (structured) {
      result = {
        ...structured,
        citations: perplexity?.citations,
      };
    } else {
      result = buildFallback(blockText, partName, partAge);
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[block-research] fatal:", e);
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
