/**
 * karel-method-library
 * --------------------
 * Centrální brána ke knihovně terapeutických manuálů a per-part historii.
 *
 * Operace (action):
 *   - "list"              → seznam metod (volitelně filtr category, tag)
 *   - "get"               → manuál podle method_key
 *   - "get_or_research"   → cache-first: vrátí z DB nebo spustí rešerši + uloží
 *   - "record_usage"      → inkrementuje usage_count + last_used_at
 *   - "log_history"       → zapíše záznam do did_part_method_history
 *   - "part_history"      → vrátí historii metod pro konkrétní část
 *   - "anti_repetition_check" → vrátí, jaké metody/varianty u části nelze opakovat
 *   - "save_proposed"     → zapíše nový kandidátní manuál (z weekly discovery)
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
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");

// 14denní okno pro tvrdý anti-repetition guard
const ANTI_REPETITION_DAYS = 14;

function db() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

async function listMethods(filters: {
  category?: string;
  tag?: string;
  status?: string;
}) {
  const supabase = db();
  let q = supabase
    .from("karel_method_library")
    .select(
      "id, method_key, title, category, age_range, tags, status, usage_count, last_used_at, created_by",
    )
    .order("category", { ascending: true })
    .order("title", { ascending: true });

  if (filters.category) q = q.eq("category", filters.category);
  if (filters.status) q = q.eq("status", filters.status);
  else q = q.in("status", ["seed", "active", "proposed"]);
  if (filters.tag) q = q.contains("tags", [filters.tag]);

  const { data, error } = await q;
  if (error) throw error;
  return data;
}

async function getMethod(method_key: string) {
  const supabase = db();
  const { data, error } = await supabase
    .from("karel_method_library")
    .select("*")
    .eq("method_key", method_key)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function recordUsage(method_key: string) {
  const supabase = db();
  const { data: existing } = await supabase
    .from("karel_method_library")
    .select("usage_count")
    .eq("method_key", method_key)
    .maybeSingle();
  if (!existing) return null;
  const { error } = await supabase
    .from("karel_method_library")
    .update({
      usage_count: (existing.usage_count ?? 0) + 1,
      last_used_at: new Date().toISOString(),
    })
    .eq("method_key", method_key);
  if (error) throw error;
  return true;
}

async function logHistory(payload: {
  part_id: string;
  part_name?: string;
  method_key: string;
  variant_used?: string;
  session_id?: string;
  clinical_yield?: number;
  tolerance?: number;
  trauma_marker?: boolean;
  notes_md?: string;
  next_step_hint?: string;
}) {
  const supabase = db();
  const { data: lib } = await supabase
    .from("karel_method_library")
    .select("id")
    .eq("method_key", payload.method_key)
    .maybeSingle();

  const { data, error } = await supabase
    .from("did_part_method_history")
    .insert({
      part_id: payload.part_id,
      part_name: payload.part_name ?? null,
      method_key: payload.method_key,
      method_library_id: lib?.id ?? null,
      variant_used: payload.variant_used ?? null,
      session_id: payload.session_id ?? null,
      clinical_yield: payload.clinical_yield ?? null,
      tolerance: payload.tolerance ?? null,
      trauma_marker: payload.trauma_marker ?? false,
      notes_md: payload.notes_md ?? null,
      next_step_hint: payload.next_step_hint ?? null,
    })
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function partHistory(part_id: string, limit = 50) {
  const supabase = db();
  const { data, error } = await supabase
    .from("did_part_method_history")
    .select("*")
    .eq("part_id", part_id)
    .order("session_date", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

/**
 * Anti-repetition guard:
 * Vrátí pole {method_key, variant_used, session_date} pro záznamy
 * mladší než ANTI_REPETITION_DAYS — Karel se musí těmto kombinacím vyhnout
 * (nebo navrhnout NOVOU variantu, pokud volí stejnou metodu).
 */
async function antiRepetitionCheck(part_id: string) {
  const supabase = db();
  const cutoff = new Date(
    Date.now() - ANTI_REPETITION_DAYS * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);

  const { data, error } = await supabase
    .from("did_part_method_history")
    .select(
      "method_key, variant_used, session_date, clinical_yield, tolerance, trauma_marker, notes_md, next_step_hint",
    )
    .eq("part_id", part_id)
    .gte("session_date", cutoff)
    .order("session_date", { ascending: false });
  if (error) throw error;

  const banned_combinations = (data ?? []).map((r: any) => ({
    method_key: r.method_key,
    variant_used: r.variant_used ?? "(žádná konkrétní varianta)",
    session_date: r.session_date,
  }));

  // tolerance < 2 nebo trauma_marker → metoda je v "kulhající" zóně
  const struggling_methods = (data ?? [])
    .filter((r: any) => (r.tolerance ?? 5) < 2 || r.trauma_marker)
    .map((r: any) => r.method_key);

  // clinical_yield >= 4 → "fungující" — preferovat varianty
  const promising_methods = (data ?? [])
    .filter((r: any) => (r.clinical_yield ?? 0) >= 4)
    .map((r: any) => ({
      method_key: r.method_key,
      hint: r.next_step_hint,
    }));

  return {
    window_days: ANTI_REPETITION_DAYS,
    banned_combinations,
    struggling_methods: Array.from(new Set(struggling_methods)),
    promising_methods,
    raw_history: data,
  };
}

async function saveProposed(payload: {
  method_key: string;
  title: string;
  category: string;
  age_range?: string;
  manual_md: string;
  sources?: string[];
  tags?: string[];
  contraindications?: string;
  created_by?: string;
}) {
  const supabase = db();

  // Upsert: pokud existuje, neaktualizujeme manuál, jen vrátíme existující
  const { data: existing } = await supabase
    .from("karel_method_library")
    .select("*")
    .eq("method_key", payload.method_key)
    .maybeSingle();

  if (existing) return { created: false, method: existing };

  const { data, error } = await supabase
    .from("karel_method_library")
    .insert({
      method_key: payload.method_key,
      title: payload.title,
      category: payload.category,
      age_range: payload.age_range ?? null,
      manual_md: payload.manual_md,
      sources: payload.sources ?? [],
      tags: payload.tags ?? [],
      contraindications: payload.contraindications ?? null,
      created_by: payload.created_by ?? "karel",
      status: "proposed",
    })
    .select()
    .maybeSingle();
  if (error) throw error;
  return { created: true, method: data };
}

/**
 * Cache-first získání manuálu.
 * 1) Pokud je v DB → vrať
 * 2) Pokud není → spusť Perplexity rešerši, ulož jako 'active' a vrať
 */
async function getOrResearch(payload: {
  method_key: string;
  title: string;
  category: string;
  age_range?: string;
  research_query?: string;
}) {
  const cached = await getMethod(payload.method_key);
  if (cached) return { from_cache: true, method: cached };

  if (!PERPLEXITY_API_KEY || !LOVABLE_API_KEY) {
    throw new Error(
      "PERPLEXITY_API_KEY nebo LOVABLE_API_KEY není nakonfigurován pro rešerši nové metody.",
    );
  }

  const query =
    payload.research_query ??
    `Profesionální manuál pro metodu "${payload.title}" (kategorie: ${payload.category}) pro psychoterapeutickou práci s dítětem s DID${payload.age_range ? `, věk ${payload.age_range}` : ""}. Uveď: setup, kroky, co sledovat, vyhodnocení, kontraindikace. ⚠️ Vyhni se dechovým cvičením (epilepsie pacienta).`;

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
            "Jsi výzkumný asistent pro klinické psychoterapeutické metody. Vracej strukturované manuály s konkrétními kroky. Citování zdrojů povinné.",
        },
        { role: "user", content: query },
      ],
      search_recency_filter: "year",
    }),
  });
  if (!pplx.ok) {
    const t = await pplx.text();
    throw new Error(`Perplexity error ${pplx.status}: ${t}`);
  }
  const pplxData = await pplx.json();
  const rawContent: string = pplxData.choices?.[0]?.message?.content ?? "";
  const citations: string[] = pplxData.citations ?? [];

  // Strukturuj do markdown manuálu
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
              "Strukturuj nalezené informace do klinického manuálu pro metodu. Sekce: ## Setup ## Kroky ## Co sledovat ## Vyhodnocení ## Kontraindikace ## Trauma protokol. ⚠️ NIKDY nedoporučuj dechová cvičení (epilepsie). Pokud zdroj doporučuje dech, nahraď ho smyslovým ukotvením.",
          },
          {
            role: "user",
            content: `Metoda: ${payload.title}\nKategorie: ${payload.category}\nVěk: ${payload.age_range ?? "dítě/adolescent"}\n\nNalezené info:\n${rawContent}`,
          },
        ],
      }),
    },
  );
  if (!synth.ok) {
    const t = await synth.text();
    throw new Error(`AI gateway error ${synth.status}: ${t}`);
  }
  const synthData = await synth.json();
  const manual_md: string =
    synthData.choices?.[0]?.message?.content ?? rawContent;

  const supabase = db();
  const { data: created, error } = await supabase
    .from("karel_method_library")
    .insert({
      method_key: payload.method_key,
      title: payload.title,
      category: payload.category,
      age_range: payload.age_range ?? null,
      manual_md,
      sources: citations,
      tags: [],
      created_by: "karel",
      status: "active",
    })
    .select()
    .maybeSingle();
  if (error) throw error;
  return { from_cache: false, method: created };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const action = body.action as string;

    let result: unknown;
    switch (action) {
      case "list":
        result = await listMethods({
          category: body.category,
          tag: body.tag,
          status: body.status,
        });
        break;
      case "get":
        result = await getMethod(body.method_key);
        break;
      case "get_or_research":
        result = await getOrResearch(body);
        break;
      case "record_usage":
        result = await recordUsage(body.method_key);
        break;
      case "log_history":
        result = await logHistory(body);
        break;
      case "part_history":
        result = await partHistory(body.part_id, body.limit ?? 50);
        break;
      case "anti_repetition_check":
        result = await antiRepetitionCheck(body.part_id);
        break;
      case "save_proposed":
        result = await saveProposed(body);
        break;
      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}` }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
    }

    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("karel-method-library error:", e);
    return new Response(
      JSON.stringify({
        ok: false,
        error: e instanceof Error ? e.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
