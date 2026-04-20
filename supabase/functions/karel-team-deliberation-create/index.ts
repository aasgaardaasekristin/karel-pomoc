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
 *
 *     // SLICE 3 — kanonické navázání na briefing item (idempotence):
 *     linked_briefing_id?: string,        // did_daily_briefings.id
 *     linked_briefing_item_id?: string,   // stabilní id decisions[i] / proposed_session
 *
 *     // SLICE 3 — prefill obsahu z briefingu (preferován před AI generací):
 *     prefill?: {
 *       title?: string,
 *       reason?: string,
 *       initial_karel_brief?: string,
 *       karel_proposed_plan?: string,        // typicky first_draft
 *       agenda_outline?: Array<{block:string, minutes?:number, detail?:string}>,
 *       questions_for_hanka?: string[],
 *       questions_for_kata?: string[],
 *     }
 *   }
 *
 * Idempotence: pokud už existuje porada se shodným `linked_briefing_item_id`
 * a status active|awaiting_signoff, vrátí ji (ne-vytváří novou). Tato kontrola
 * je AUTORITATIVNÍ — fuzzy text match na klientu je už jen fallback pro
 * legacy briefingy bez `linked_briefing_item_id`.
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

    // SLICE 3 — briefing item linkage + prefill
    const linkedBriefingId: string | null = body?.linked_briefing_id
      ? String(body.linked_briefing_id) : null;
    const linkedBriefingItemId: string | null = body?.linked_briefing_item_id
      ? String(body.linked_briefing_item_id) : null;
    const prefill = (body?.prefill && typeof body.prefill === "object") ? body.prefill : null;

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // ── IDEMPOTENCE ── kanonický lookup přes (user_id, linked_briefing_item_id).
    // Dvoukroková kaskáda BEZ filtru na den:
    //   1) živá porada (draft|active|awaiting_signoff)  → otevři ji
    //   2) jinak schválená (approved)                   → otevři ji read-only
    //   3) jinak INSERT
    // closed/archived jsou mimo reuse — terapeutka je explicitně uzavřela.
    if (linkedBriefingItemId) {
      const { data: live } = await admin
        .from("did_team_deliberations")
        .select("*")
        .eq("user_id", userId)
        .eq("linked_briefing_item_id", linkedBriefingItemId)
        .in("status", ["draft", "active", "awaiting_signoff"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (live) {
        return new Response(JSON.stringify({ deliberation: live, reused: true }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: approvedRow } = await admin
        .from("did_team_deliberations")
        .select("*")
        .eq("user_id", userId)
        .eq("linked_briefing_item_id", linkedBriefingItemId)
        .eq("status", "approved")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (approvedRow) {
        return new Response(JSON.stringify({ deliberation: approvedRow, reused: true, read_only: true }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ── OBSAH ── pokud je prefill, použij ho (briefing už dodal AI obsah).
    // Jinak fallback: dogenerovat ad-hoc přes AI gateway (legacy path).
    let aiContent: any;
    if (prefill) {
      aiContent = {
        title: prefill.title,
        reason: prefill.reason,
        initial_karel_brief: prefill.initial_karel_brief,
        karel_proposed_plan: prefill.karel_proposed_plan,
        agenda_outline: Array.isArray(prefill.agenda_outline) ? prefill.agenda_outline : [],
        questions_for_hanka: Array.isArray(prefill.questions_for_hanka) ? prefill.questions_for_hanka : [],
        questions_for_kata: Array.isArray(prefill.questions_for_kata) ? prefill.questions_for_kata : [],
      };
    } else {
      const ctx = await gatherContext(admin, userId, subjectParts);
      const prompt = buildPrompt({ type, subjectParts, reason, hint, ctx });
      const ai = await callAI(prompt);
      aiContent = { ...ai, agenda_outline: [] };
    }

    // Schválené parametry sezení (Slice 3 hardening) — uloženy autoritativně,
    // bridge do did_daily_session_plans je čte odsud místo hardcoded "hanka".
    const rawSp = (prefill as any)?.session_params;
    const sessionParams = (rawSp && typeof rawSp === "object")
      ? {
          part_name: rawSp.part_name ? String(rawSp.part_name) : (subjectParts[0] ?? null),
          led_by: rawSp.led_by ? String(rawSp.led_by) : null,            // "Hanička"|"Káťa"|"společně"
          session_format: rawSp.session_format ? String(rawSp.session_format) : null, // "individual"|"joint"
          duration_min: typeof rawSp.duration_min === "number" ? rawSp.duration_min : null,
          why_today: rawSp.why_today ? String(rawSp.why_today) : null,
          kata_involvement: rawSp.kata_involvement ? String(rawSp.kata_involvement) : null,
        }
      : {};

    const insertRow = {
      user_id: userId,
      title: String(aiContent?.title ?? hint ?? "Nová porada").slice(0, 200),
      reason: String(aiContent?.reason ?? reason ?? "").slice(0, 800),
      status: "active",
      priority,
      deliberation_type: type,
      subject_parts: subjectParts,
      participants: ["hanka", "kata", "karel"],
      created_by: "karel",
      initial_karel_brief: String(aiContent?.initial_karel_brief ?? ""),
      karel_proposed_plan: String(aiContent?.karel_proposed_plan ?? ""),
      agenda_outline: (Array.isArray(aiContent?.agenda_outline) ? aiContent.agenda_outline : [])
        .slice(0, 8)
        .map((b: any) => ({
          block: String(b?.block ?? "").slice(0, 120),
          minutes: typeof b?.minutes === "number" ? b.minutes : null,
          detail: b?.detail ? String(b.detail).slice(0, 400) : null,
        }))
        .filter((b: any) => b.block.length > 0),
      questions_for_hanka: (Array.isArray(aiContent?.questions_for_hanka) ? aiContent.questions_for_hanka : [])
        .slice(0, 3)
        .map((q: any) => typeof q === "string"
          ? { question: q, answer: null }
          : { question: String(q?.question ?? q), answer: q?.answer ?? null }),
      questions_for_kata: (Array.isArray(aiContent?.questions_for_kata) ? aiContent.questions_for_kata : [])
        .slice(0, 3)
        .map((q: any) => typeof q === "string"
          ? { question: q, answer: null }
          : { question: String(q?.question ?? q), answer: q?.answer ?? null }),
      discussion_log: [],
      linked_crisis_event_id: body?.linked_crisis_event_id ?? null,
      linked_task_id: body?.linked_task_id ?? null,
      linked_briefing_id: linkedBriefingId,
      linked_briefing_item_id: linkedBriefingItemId,
      session_params: sessionParams,
    };

    const { data: created, error: insErr } = await admin
      .from("did_team_deliberations")
      .insert(insertRow)
      .select("*")
      .single();

    if (insErr) {
      // Race condition na UNIQUE (uniq_did_team_delib_briefing_item):
      // souběžný klik už založil poradu pro stejný briefing item, NEBO
      // existuje approved porada (nový whitelist obsahuje i approved).
      // Vrátíme existující kanonický record, ne 500.
      if ((insErr as any)?.code === "23505" && linkedBriefingItemId) {
        const { data: raced } = await admin
          .from("did_team_deliberations")
          .select("*")
          .eq("user_id", userId)
          .eq("linked_briefing_item_id", linkedBriefingItemId)
          .in("status", ["draft", "active", "awaiting_signoff", "approved"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (raced) {
          const isApproved = raced.status === "approved";
          return new Response(JSON.stringify({
            deliberation: raced,
            reused: true,
            race_recovered: true,
            read_only: isApproved,
          }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      return new Response(JSON.stringify({ error: insErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ deliberation: created, reused: false }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
