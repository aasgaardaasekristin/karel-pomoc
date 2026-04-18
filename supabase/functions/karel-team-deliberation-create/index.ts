/**
 * karel-team-deliberation-create
 *
 * Vytvoří novou TeamDeliberation s předvyplněným Karlovým briefem,
 * navrženým plánem a oddělenými otázkami pro Haničku a Káťu.
 *
 * Vstup:
 *   {
 *     deliberation_type: "team_task" | "session_plan" | "crisis"
 *                        | "followup_review" | "supervision",
 *     subject_parts?: string[],
 *     reason?: string,            // krátký důvod svolání (kontext)
 *     priority?: "low"|"normal"|"high"|"urgent"|"crisis",
 *     linked_crisis_event_id?: string,
 *     linked_task_id?: string,
 *     hint?: string,              // volný hint pro AI ("dnešní sezení s Tundrupkem")
 *   }
 */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const ALLOWED_TYPES = [
  "team_task",
  "session_plan",
  "crisis",
  "followup_review",
  "supervision",
];

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

interface ContextBlob {
  recentPlan: string;
  recentThreads: string;
  partRegistry: string;
  openCrises: string;
  recentTherapistMessages: string;
}

async function gatherContext(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  subjectParts: string[],
): Promise<ContextBlob> {
  const since3d = new Date(Date.now() - 3 * 86400000).toISOString();
  const today = new Date().toISOString().slice(0, 10);

  const [planRes, threadsRes, registryRes, crisesRes] = await Promise.all([
    supabase
      .from("did_daily_session_plans")
      .select("plan_date, selected_part, therapist, status, plan_markdown")
      .eq("user_id", userId)
      .gte("plan_date", since3d.slice(0, 10))
      .order("plan_date", { ascending: false })
      .limit(8),
    supabase
      .from("did_threads")
      .select("part_name, thread_label, last_activity_at, messages, sub_mode")
      .eq("user_id", userId)
      .gte("last_activity_at", since3d)
      .order("last_activity_at", { ascending: false })
      .limit(15),
    supabase
      .from("did_part_registry")
      .select("part_name, last_seen_at, is_communicating, current_state")
      .eq("user_id", userId)
      .limit(40),
    supabase
      .from("crisis_events")
      .select("part_name, severity, phase, trigger_description, days_active, opened_at")
      .eq("user_id", userId)
      .neq("phase", "closed")
      .order("opened_at", { ascending: false })
      .limit(5),
  ]);

  const recentPlan = (planRes.data ?? [])
    .map(
      (p: any) =>
        `${p.plan_date} [${p.therapist}/${p.selected_part}] ${p.status}\n${(p.plan_markdown ?? "").slice(0, 600)}`,
    )
    .join("\n---\n") || "(žádný recentní plán)";

  const filterParts = subjectParts.length > 0
    ? new Set(subjectParts.map((s) => s.toLowerCase()))
    : null;

  const recentThreads = (threadsRes.data ?? [])
    .filter((t: any) =>
      filterParts ? filterParts.has((t.part_name ?? "").toLowerCase()) : true,
    )
    .map((t: any) => {
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      const last = msgs.slice(-3).map((m: any) =>
        `  ${m.role}: ${(m.content ?? "").slice(0, 180)}`
      ).join("\n");
      return `[${t.part_name}/${t.sub_mode}] ${t.thread_label ?? ""} — ${t.last_activity_at}\n${last}`;
    })
    .join("\n---\n") || "(žádná recentní vlákna)";

  const partRegistry = (registryRes.data ?? [])
    .map((p: any) =>
      `${p.part_name}: stav=${p.current_state ?? "?"}, komunikuje=${p.is_communicating ?? "?"}, naposledy=${p.last_seen_at ?? "?"}`)
    .join("\n") || "(prázdný registr)";

  const openCrises = (crisesRes.data ?? [])
    .map((c: any) =>
      `${c.part_name} [${c.severity}, fáze=${c.phase}, ${c.days_active}d]: ${c.trigger_description}`)
    .join("\n") || "(žádné aktivní krize)";

  return {
    recentPlan,
    recentThreads,
    partRegistry,
    openCrises,
    recentTherapistMessages: today,
  };
}

function buildPrompt(args: {
  type: string;
  subjectParts: string[];
  reason: string;
  hint: string;
  ctx: ContextBlob;
}): string {
  const { type, subjectParts, reason, hint, ctx } = args;
  return `Jsi **Karel** — vedoucí terapeutického týmu (Hanička + Káťa).
Připravuješ novou týmovou poradu typu **${type}**.

PRAVIDLO HLASU:
- mluv k týmu (team_lead voice), nikoliv „o nich“ ve 3. osobě
- žádné systémové prefixy, žádné raw labely, žádné timestampy
- konkrétně, profesionálně, krátce

Téma: ${reason || hint || "(neuvedeno)"}
Dotčené části: ${subjectParts.join(", ") || "(neuvedeno)"}

POSLEDNÍ 3 DNY — denní plán:
${ctx.recentPlan}

POSLEDNÍ AKTIVNÍ VLÁKNA:
${ctx.recentThreads}

REGISTR ČÁSTÍ (komunikující / stavy):
${ctx.partRegistry}

OTEVŘENÉ KRIZE:
${ctx.openCrises}

ÚKOL:
Vrať VÝHRADNĚ JSON v tomto tvaru (žádný markdown, žádné komentáře):
{
  "title": "krátký, výstižný název porady (max 80 znaků)",
  "reason": "1-2 věty, proč to teď řešíme",
  "initial_karel_brief": "3-5 vět: pozdrav týmu, proč svoláváš poradu, co se změnilo za poslední 3 dny, co ti zůstává významné z dřívějška, co potřebuješ rozhodnout",
  "karel_proposed_plan": "konkrétní pracovní návrh:\\n- pokud je typ session_plan: koho přizvat, kdo vede, zda se připojí Káťa, navržená metoda, pomůcky, úvodní věty, co sledovat, fallbacky\\n- jinak: konkrétní kroky / rozhodovací body",
  "questions_for_hanka": [
    "konkrétní otázka, kterou se ptáš JEN Haničky (její perspektiva: matka, primární terapeutka)"
  ],
  "questions_for_kata": [
    "konkrétní otázka, kterou se ptáš JEN Káti (její perspektiva: druhá terapeutka, supervize, externí pohled)"
  ]
}

PRAVIDLA OTÁZEK:
- max 3 otázky pro každou
- nesmí být stejné u obou — Hanička a Káťa mají různé role a perspektivy
- musí být konkrétní (ne „co si myslíš?“)
- otevřené, ne ano/ne (ledaže je to skutečně binární rozhodnutí)`;
}

async function callAI(prompt: string): Promise<any> {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: "Vrať VÝHRADNĚ čistý JSON. Bez markdownu, bez fences, bez komentářů." },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`AI gateway ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  // strip fences if any
  const clean = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  return JSON.parse(clean);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "missing auth" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const type = String(body?.deliberation_type ?? "team_task");
    if (!ALLOWED_TYPES.includes(type)) {
      return new Response(JSON.stringify({ error: `disallowed type: ${type}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const subjectParts: string[] = Array.isArray(body?.subject_parts) ? body.subject_parts : [];
    const reason: string = String(body?.reason ?? "");
    const hint: string = String(body?.hint ?? "");
    const priority: string = String(body?.priority ?? (type === "crisis" ? "crisis" : "normal"));

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const ctx = await gatherContext(admin, userId, subjectParts);
    const prompt = buildPrompt({ type, subjectParts, reason, hint, ctx });
    const ai = await callAI(prompt);

    const insertRow = {
      user_id: userId,
      title: String(ai?.title ?? hint ?? "Nová porada").slice(0, 200),
      reason: String(ai?.reason ?? reason ?? "").slice(0, 800),
      status: "active",
      priority,
      deliberation_type: type,
      subject_parts: subjectParts,
      participants: ["hanka", "kata", "karel"],
      created_by: "karel",
      initial_karel_brief: String(ai?.initial_karel_brief ?? ""),
      karel_proposed_plan: String(ai?.karel_proposed_plan ?? ""),
      questions_for_hanka: (Array.isArray(ai?.questions_for_hanka) ? ai.questions_for_hanka : [])
        .slice(0, 3).map((q: any) => ({ question: String(q), answer: null })),
      questions_for_kata: (Array.isArray(ai?.questions_for_kata) ? ai.questions_for_kata : [])
        .slice(0, 3).map((q: any) => ({ question: String(q), answer: null })),
      discussion_log: [],
      linked_crisis_event_id: body?.linked_crisis_event_id ?? null,
      linked_task_id: body?.linked_task_id ?? null,
    };

    const { data: created, error: insErr } = await admin
      .from("did_team_deliberations")
      .insert(insertRow)
      .select("*")
      .single();

    if (insErr) {
      return new Response(JSON.stringify({ error: insErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ deliberation: created }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
