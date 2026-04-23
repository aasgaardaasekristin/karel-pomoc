/**
 * karel-method-discovery
 * ----------------------
 * Weekly proaktivní rozšiřování knihovny metod.
 * Spouští se z weekly cyklu (pg_cron 1× týdně).
 *
 * Cíl: rozšířit Karlův obzor o nové techniky/aktivity/testy z odborných zdrojů
 * (Perplexity), které ještě v knihovně nejsou.
 *
 * Postup:
 *  1. Načti existující method_keys (aby Karel nehledal duplicity)
 *  2. Pošli Perplexity dotaz na nové techniky pro DID u dětí (různé kategorie)
 *  3. Strukturuj 2-5 nových manuálů přes Lovable AI
 *  4. Ulož jako status='proposed' (čekají na první nasazení)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

const DISCOVERY_TOPICS = [
  {
    category: "diagnostika",
    query:
      "Méně známé projektivní a narativní diagnostické techniky pro DID u dětí 7-15 let — kromě HTP, KFD, Sandtray, Jung asociace. Co aktuálně doporučuje ISSTD/ESTD? Jména technik + krátký protokol + zdroje.",
  },
  {
    category: "stabilizace",
    query:
      "Stabilizační techniky pro děti s DID a komplexním traumatem BEZ dechových cvičení (epilepsie). Smyslové ukotvení, polyvagal, somatic, imaginace, attachment. 3 konkrétní techniky které nejsou triviální 5-4-3-2-1.",
  },
  {
    category: "trauma",
    query:
      "Trauma-informed techniky pro práci s flashbacky a traumatickou pamětí u dětí s DID. Aktuální klinická doporučení (ESTD, NCTSN). 2-3 strukturované postupy.",
  },
  {
    category: "vztahy",
    query:
      "Techniky pro vnitřní komunikaci mezi částmi (alters) u dětského DID systému — IFS-inspired, dyad work, puppet dialogues, internal family conferences. Konkrétní postupy.",
  },
  {
    category: "hra",
    query:
      "Strukturované hrové intervence pro děti s DID 5-12 let zaměřené na integraci, kooperaci částí a reparativní zkušenost. Inovativní postupy mimo standardní play therapy.",
  },
];

async function fetchExistingKeys(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from("karel_method_library")
    .select("method_key, title");
  if (error) throw error;
  return data ?? [];
}

async function discoverForCategory(
  category: string,
  query: string,
  existing: Array<{ method_key: string; title: string }>,
): Promise<
  Array<{
    method_key: string;
    title: string;
    category: string;
    manual_md: string;
    sources: string[];
    tags: string[];
  }>
> {
  if (!PERPLEXITY_API_KEY || !LOVABLE_API_KEY) return [];

  const existingList = existing
    .map((e) => `- ${e.title} (${e.method_key})`)
    .join("\n");

  const enriched =
    query +
    `\n\nVYHNI SE těmto metodám které už mám:\n${existingList}\n\nVrať pouze NOVÉ techniky.`;

  const pplx = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar-pro",
      messages: [
        {
          role: "system",
          content:
            "Jsi výzkumný asistent pro klinické techniky. Hledej v aktuálních odborných zdrojích (ISSTD, ESTD, NCTSN, peer-reviewed). Vracej konkrétní pojmenované techniky s krátkým postupem a zdroji.",
        },
        { role: "user", content: enriched },
      ],
      search_recency_filter: "year",
    }),
  });
  if (!pplx.ok) {
    console.error(`Perplexity error pro ${category}:`, await pplx.text());
    return [];
  }
  const pplxData = await pplx.json();
  const content: string = pplxData.choices?.[0]?.message?.content ?? "";
  const citations: string[] = pplxData.citations ?? [];

  // Strukturuj přes Lovable AI s tool calling
  const synth = await fetch(
    "https://ai.gateway.lovable.dev/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-pro",
        messages: [
          {
            role: "system",
            content:
              "Z popisu nalezených technik vyber 2-4 KONKRÉTNÍ pojmenované metody. Pro každou vytvoř strukturovaný manuál (Setup / Kroky / Co sledovat / Vyhodnocení / Kontraindikace). ⚠️ NIKDY dechová cvičení — pacient má epilepsii.",
          },
          { role: "user", content },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "save_methods",
              description:
                "Vrať pole nalezených technik jako kandidáty do knihovny.",
              parameters: {
                type: "object",
                properties: {
                  methods: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        method_key: {
                          type: "string",
                          description:
                            "snake_case slug, např. 'window_of_tolerance_mapping'",
                        },
                        title: { type: "string" },
                        manual_md: {
                          type: "string",
                          description: "Plný markdown manuál se sekcemi",
                        },
                        tags: {
                          type: "array",
                          items: { type: "string" },
                        },
                      },
                      required: ["method_key", "title", "manual_md"],
                    },
                  },
                },
                required: ["methods"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "save_methods" } },
      }),
    },
  );

  if (!synth.ok) {
    console.error(`AI gateway error pro ${category}:`, await synth.text());
    return [];
  }
  const synthData = await synth.json();
  const toolCall = synthData.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) return [];

  let parsed: { methods?: any[] } = {};
  try {
    parsed = JSON.parse(toolCall.function.arguments);
  } catch (e) {
    console.error("JSON parse error:", e);
    return [];
  }

  return (parsed.methods ?? []).map((m) => ({
    method_key: m.method_key,
    title: m.title,
    category,
    manual_md: m.manual_md,
    sources: citations,
    tags: m.tags ?? [],
  }));
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Možnost selectivně omezit jen na 1 kategorii (pro testování)
    let body: any = {};
    try {
      body = await req.json();
    } catch {}
    const onlyCategory: string | undefined = body?.category;

    const existing = await fetchExistingKeys(supabase);
    const topics = onlyCategory
      ? DISCOVERY_TOPICS.filter((t) => t.category === onlyCategory)
      : DISCOVERY_TOPICS;

    const allDiscovered: any[] = [];
    for (const topic of topics) {
      const discovered = await discoverForCategory(
        topic.category,
        topic.query,
        existing,
      );
      allDiscovered.push(...discovered);
    }

    // Ulož jako 'proposed', přeskoč duplicity
    const saved: any[] = [];
    const skipped: any[] = [];
    const savedManuals: any[] = [];
    for (const m of allDiscovered) {
      const { data: dup } = await supabase
        .from("karel_method_library")
        .select("id")
        .eq("method_key", m.method_key)
        .maybeSingle();
      if (dup) {
        skipped.push(m.method_key);
        continue;
      }
      const { error } = await supabase.from("karel_method_library").insert({
        method_key: m.method_key,
        title: m.title,
        category: m.category,
        manual_md: m.manual_md,
        sources: m.sources,
        tags: m.tags,
        created_by: "karel_discovery",
        status: "proposed",
        contraindications:
          "Před první aplikací zkontrolovat. ⚠️ EPILEPSIE — žádná dechová cvičení.",
      });
      if (!error) {
        saved.push(m.method_key);
        savedManuals.push(m);
      }
    }

    // ═══ DRIVE EXPORT: zapiš nové metody do Spižírny → flush je propíše ═══
    // Cesta: KARTOTEKA_DID/00_CENTRUM/07_Knihovna/NOVE_METODY_<YYYY-MM-DD>
    let driveExported = false;
    if (savedManuals.length > 0) {
      try {
        // Najdi user_id (DID systém má jednoho hlavního ownera)
        const { data: owner } = await supabase
          .from("did_part_registry")
          .select("user_id")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        const ownerId = owner?.user_id;
        if (ownerId) {
          const dateStr = new Date().toISOString().slice(0, 10);
          const driveTarget = `KARTOTEKA_DID/00_CENTRUM/07_Knihovna/NOVE_METODY_${dateStr}`;
          const headerLines = [
            `# 📚 Nové metody objevené ${dateStr}`,
            ``,
            `Karel tento týden rozšířil knihovnu o **${savedManuals.length}** nových metod/technik.`,
            `Metody jsou ve stavu *proposed* — než je nasadím v sezení, projděte si manuál.`,
            ``,
            `---`,
            ``,
          ];
          const sections = savedManuals.map((m, i) => {
            const sourcesText = (m.sources && m.sources.length)
              ? `\n**Zdroje:** ${m.sources.join("; ")}`
              : "";
            const tagsText = (m.tags && m.tags.length)
              ? `\n**Tagy:** ${m.tags.join(", ")}`
              : "";
            return [
              `## ${i + 1}. ${m.title}`,
              `**Kategorie:** ${m.category}  `,
              `**method_key:** \`${m.method_key}\`${sourcesText}${tagsText}`,
              ``,
              m.manual_md,
              ``,
              `---`,
              ``,
            ].join("\n");
          });
          const fullContent = headerLines.join("\n") + sections.join("\n");

          const { error: pantryErr } = await supabase
            .from("did_pantry_packages")
            .insert({
              user_id: ownerId,
              package_type: "method_discovery_weekly",
              content_md: fullContent,
              drive_target_path: driveTarget,
              status: "pending_drive",
              metadata: {
                discovered_count: savedManuals.length,
                method_keys: saved,
                week_of: dateStr,
              },
            });
          if (!pantryErr) driveExported = true;
          else console.error("[discovery] pantry insert failed:", pantryErr);
        }
      } catch (e) {
        console.error("[discovery] drive export failed:", e);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        summary: {
          discovered: allDiscovered.length,
          saved: saved.length,
          skipped: skipped.length,
          drive_exported: driveExported,
        },
        saved,
        skipped,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("discovery error:", e);
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "Unknown" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
