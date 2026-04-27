/**
 * karel-part-session-prepare — v1 (2026-04-22)
 *
 * První funkční verze "Karel + část room" (herna).
 *
 * NEZAKLÁDÁ NOVÝ DATOVÝ MODEL. Sedí přímo na did_threads:
 *   sub_mode       = "karel_part_session"
 *   workspace_type = "session"
 *   workspace_id   = plan_id                      ← idempotence per denní plán
 *
 * Vstup:
 *   { part_name: string, plan_id?: string, first_question?: string,
 *     session_actor?: string, session_mode?: string, readiness_today?: string,
 *     briefing_proposed_session?: object }
 *
 * Výstup (idempotentní):
 *   { thread_id: string, created: boolean }
 *
 * Při prvním otevření Karel vygeneruje strukturovaný program 60-min sezení
 * (cíl, bezpečný rámec, 4-5 herních bloků, pomůcky, časování) jako úvodní
 * assistant zprávu. Druhý klik vrací existující thread bez AI volání.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

function pragueTodayISO(): string {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Prague" }));
  return d.toISOString().slice(0, 10);
}

/**
 * C0 SESSION-TYPE TRUTH SEPARATION (2026-04-22):
 *
 * Tato funkce produkuje POUZE child-facing opener. Interní program
 * (cíle, pomůcky, časování, bloky) se do `messages` NEUKLÁDÁ —
 * ten patří do hidden contextu, který Karel dostane přes `karel-chat`
 * z `did_daily_session_plans.plan_markdown` (už existuje).
 *
 * Důvod: dítě (část) v herně NESMÍ vidět interní terapeutický plán.
 * Herna je remote-native child-facing místnost vedená Karlem přes
 * obrazovku — žádné fyzické pomůcky (papír, pastelky, balónky), žádný
 * scénář z perspektivy terapeuta v jedné místnosti.
 */
function hasApprovedPlayroomContract(contract: Record<string, unknown>): boolean {
  const playroomPlan = contract.playroom_plan as any;
  const approval = (playroomPlan?.therapist_review ?? playroomPlan?.approval ?? contract.approval ?? {}) as Record<string, unknown>;
  return contract.session_actor === "karel_direct" &&
    contract.ui_surface === "did_kids_playroom" &&
    contract.lead_entity === "karel" &&
    !!playroomPlan &&
    typeof playroomPlan === "object" &&
    Array.isArray(playroomPlan.therapeutic_program) &&
    playroomPlan.therapeutic_program.length > 0 &&
    (contract.approved_for_child_session === true || approval.approved_for_child_session === true);
}

function buildSafePlayroomHint(playroomPlan: any) {
  return {
    first_question: playroomPlan?.first_question,
    readiness_today: playroomPlan?.readiness_today,
    session_mode: playroomPlan?.session_mode,
    duration_min: playroomPlan?.duration_min,
    safe_opening_options: Array.isArray(playroomPlan?.therapeutic_program)
      ? playroomPlan.therapeutic_program.slice(0, 2).map((step: any) => ({ title: step.title, expected_signal: step.expected_signal }))
      : [],
  };
}

async function generateChildOpener(partName: string, briefingHint: any): Promise<string> {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) {
    return safeFallbackChildOpener(partName, briefingHint);
  }

  const firstQuestion = String(briefingHint?.first_question ?? "").trim();
  const treatmentPhase = String(briefingHint?.treatment_phase ?? "").trim();
  const readiness = String(briefingHint?.readiness_today ?? "").trim();

  // C1 SESSION-LEAD TRUTH PASS (2026-04-22):
  //   `first_draft` (therapist-led plán) NESMÍ vstoupit do hint payloadu —
  //   child-facing opener nesmí leakovat therapist-facing program ani
  //   implicitně přes hint. Posíláme JEN povolené child-facing vstupy.
  const hintLines = briefingHint
    ? [
        `Povolený child-facing vstup:`,
        `- part_name: ${partName}`,
        firstQuestion ? `- first_question: ${firstQuestion}` : `- first_question: Jak ti dnes je, když jsme spolu tady přes obrazovku?`,
        briefingHint?.duration_min ? `- rámcová délka: ${briefingHint.duration_min} minut` : null,
        Array.isArray(briefingHint?.safe_opening_options) && briefingHint.safe_opening_options.length
          ? `- bezpečné úvodní možnosti: ${briefingHint.safe_opening_options.map((x: any) => x.title).join("; ")}`
          : null,
        treatmentPhase ? `- jemný tón podle fáze: ${treatmentPhase}` : null,
        readiness ? `- jemný tón podle readiness: ${readiness}` : null,
      ]
        .filter(Boolean) as string[]
    : [`Žádný briefing — udělej krátké uvítací oslovení a 1–2 jemné hravé nabídky.`];

  const hintText = hintLines.join("\n");

  try {
    const res = await fetch(AI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `Jsi Karel — esence C. G. Junga, traumaterapeut. Otevíráš dnešní remote-native hernu s částí "${partName}". Pracuješ přes obrazovku (chat, nahrávky, fotky, kresby do screenu, asociace, škály 1–10), nikdy fyzicky.

PRAVIDLA OPENERU (TVRDÁ):
- Maximálně 4–6 vět celkem.
- Oslovení části jménem, krátké přivítání, ujištění o bezpečí.
- 1–2 hravé NABÍDKY na začátek (např. "můžeme si dát pár otázek o tom, jak dnes ráno bylo", "můžeš mi nahrát hlas, jak se cítíš", "můžeš nakreslit jednu čáru, jakou má dnes barvu"), VŽDY remote (audio, foto, kresba do appky, slovní asociace, škály), NIKDY fyzické pomůcky.
- Nech volbu otevřenou ("nic není povinné").

ZAKÁZÁNO V OPENERU:
- žádné cíle, časy, bloky, fáze, pomůcky typu "papír, pastelky, balónky, mapa"
- žádný klinický žargon ani interní terapeutické formulace
- žádné "připravil jsem program / strukturu / 5 bloků"
- žádné předpoklady, že sedíme spolu fyzicky v místnosti

Vrať POUZE krátký prostý text (žádný JSON, žádný code-fence, žádné nadpisy).`,
          },
          { role: "user", content: hintText },
        ],
      }),
    });

    if (!res.ok) {
      console.warn("[part-session-prepare] AI status", res.status);
      return defaultChildOpener(partName);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content?.trim();
    return validateChildOpener(content) ? content : safeFallbackChildOpener(partName, briefingHint);
  } catch (e) {
    console.warn("[part-session-prepare] AI error:", e);
    return safeFallbackChildOpener(partName, briefingHint);
  }
}

const FORBIDDEN_CHILD_OPENER_PATTERNS = [
  /risk_gate/i,
  /contraindication/i,
  /contraindikace/i,
  /stop\s*rule/i,
  /stop_rules/i,
  /diagnostick[ýy]\s+z[áa]m[ěe]r/i,
  /terapeutick[ýy]\s+pl[áa]n/i,
  /Hani[čc]ka\s+m[áa]/i,
  /K[áa][ťt]a\s+m[áa]/i,
  /supervize/i,
  /program_draft/i,
  /plan_markdown/i,
  /readiness\s+red/i,
  /klinick[áa]\s+hypot[ée]za/i,
  /\bevidence\b/i,
  /intern[íi]\s+pozn[áa]mky\s+pro\s+terapeutky/i,
];

function validateChildOpener(content: unknown): content is string {
  const text = String(content ?? "").trim();
  if (!text) return false;
  return !FORBIDDEN_CHILD_OPENER_PATTERNS.some((rx) => rx.test(text));
}

function safeFallbackChildOpener(partName: string, briefingHint: any): string {
  const firstQuestion = String(briefingHint?.first_question ?? "Jak ti je právě teď, když jsme spolu přes obrazovku?").trim();
  return `Ahoj, ${partName}. Dnes na tebe netlačím.
Chci jen krátce zjistit, jestli je teď bezpečné být spolu pár minut.

Stačí mi říct jedno z těchto:
„jde to“, „nejde to“, nebo „nevím“.

První otázka:
${firstQuestion}`;
}

function defaultChildOpener(partName: string): string {
  return `Ahoj ${partName}, jsem rád, že jsi tady. Jsme spolu jen přes obrazovku — žádný spěch, nic nemusíš.

Můžeš mi pro začátek zkusit jednu věc — buď mi napsat (nebo nahrát hlas), jak ti dnes je, anebo mi sem nakreslit jednu čáru, jakou má dnes barvu. Co tě láká víc?`;
}

function isUuid(value: unknown): value is string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? ""));
}

async function createFollowUpQuestion(sb: any, args: { userId: string | null; planId: string | null; partName: string; reason: string }) {
  const question = `Haničko, ${args.partName} dnes v Karlově přímém kontaktu nebyl dostupný. Viděla jsi dnes známky stažení, únavy nebo přítomnosti jiné části?`;
  const { data: existing } = await sb
    .from("did_pending_questions")
    .select("id")
    .eq("status", "open")
    .eq("subject_type", "karel_direct_session")
    .eq("subject_id", args.planId ?? `${args.partName}:${pragueTodayISO()}`)
    .limit(1);
  if (existing?.length) return;
  await sb.from("did_pending_questions").insert({
    question,
    context: `MVP-SESSION-2 follow-up: ${args.reason}`,
    subject_type: "karel_direct_session",
    subject_id: args.planId ?? `${args.partName}:${pragueTodayISO()}`,
    directed_to: "both",
    blocking: "clinical_clarification",
    status: "open",
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(supabaseUrl, srvKey);

  try {
    const body = await req.json();
    const partName: string = (body.part_name || "").trim();
    if (!partName) return jsonRes({ error: "part_name required" }, 400);

    const planId = isUuid(body?.plan_id) ? String(body.plan_id) : null;
    let planContract: Record<string, unknown> = {};
    if (planId) {
      const { data: plan, error: planErr } = await sb
        .from("did_daily_session_plans")
        .select("urgency_breakdown")
        .eq("id", planId)
        .maybeSingle();
      if (planErr) return jsonRes({ ok: false, error: planErr.message }, 500);
      planContract = plan?.urgency_breakdown && typeof plan.urgency_breakdown === "object" ? plan.urgency_breakdown : {};
      if (planContract.approved_for_child_session !== true) {
        return jsonRes({
          ok: false,
          error: "human_review_required",
          message: "Karlova herna se může otevřít až po schválení terapeutkami.",
        }, 403);
      }
    }

    const sessionActor = String(planContract.session_actor ?? body?.session_actor ?? body?.briefing_proposed_session?.session_actor ?? "").trim();
    const sessionMode = String(planContract.session_mode ?? body?.session_mode ?? body?.briefing_proposed_session?.session_mode ?? "").trim();
    const readinessToday = String(planContract.readiness_today ?? body?.readiness_today ?? body?.briefing_proposed_session?.readiness_today ?? "").trim();
    const briefingHint = {
      first_question: planContract.first_question ?? body?.first_question ?? body?.briefing_proposed_session?.first_question,
      session_actor: sessionActor || undefined,
      session_mode: sessionMode || undefined,
      readiness_today: readinessToday || undefined,
    };

    const today = pragueTodayISO();
    const dayStart = `${today}T00:00:00.000Z`;
    const dayEnd = `${today}T23:59:59.999Z`;

    // 1) Idempotent lookup — primary truth is workspace_type=session + workspace_id=plan_id.
    let existingQuery = sb.from("did_threads").select("id, started_at").eq("sub_mode", "karel_part_session");
    if (planId) {
      existingQuery = existingQuery.eq("workspace_type", "session").eq("workspace_id", planId);
    } else {
      existingQuery = existingQuery.ilike("part_name", partName).gte("started_at", dayStart).lte("started_at", dayEnd);
    }
    const existing = await existingQuery.order("started_at", { ascending: false }).limit(1).maybeSingle();

    if (existing.data?.id) {
      return jsonRes({ thread_id: existing.data.id, created: false });
    }

    // 2) Resolve user_id (single-tenant fallback)
    const { data: anyThread } = await sb
      .from("did_threads")
      .select("user_id")
      .not("user_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const userId = anyThread?.user_id ?? null;

    if (sessionActor === "karel_direct" && sessionMode === "deferred") {
      if (planId) {
        const { data: plan } = await sb.from("did_daily_session_plans").select("urgency_breakdown").eq("id", planId).maybeSingle();
        await sb.from("did_daily_session_plans").update({
          urgency_breakdown: { ...(plan?.urgency_breakdown ?? {}), result_status: "deferred" },
          updated_at: new Date().toISOString(),
        }).eq("id", planId);
      }
      await createFollowUpQuestion(sb, { userId, planId, partName, reason: "deferred_without_child_session" });
      return jsonRes({ deferred: true, created: false, reason: "session_mode_deferred" });
    }

    // 3) Generate child-facing opener (AI or fallback).
    //    C0 SESSION-TYPE TRUTH SEPARATION (2026-04-22):
    //    Žádný interní program, pomůcky ani časování v messages —
    //    to patří do hidden contextu, který Karel čerpá z plan_markdown.
    const childOpener = await generateChildOpener(partName, briefingHint);

    const dateLabel = new Date().toLocaleDateString("cs-CZ", { day: "numeric", month: "long" });
    const threadLabel = `Herna ${partName} · ${dateLabel}`;

    const opener = childOpener;

    // 4) Insert thread (workspace_type/_id nepoužíváme — UUID by neumělo
    //    deterministický string. Idempotenci hlídáme přes lookup výše.)
    const insertPayload: any = {
      part_name: partName,
      sub_mode: "karel_part_session",
      part_language: "cs",
      messages: [{ role: "assistant", content: opener }],
      last_activity_at: new Date().toISOString(),
      is_processed: false,
      thread_label: threadLabel,
      thread_emoji: "🎲",
    };
    if (planId) {
      insertPayload.workspace_type = "session";
      insertPayload.workspace_id = planId;
    }
    if (userId) insertPayload.user_id = userId;

    const { data: created, error: insErr } = await sb
      .from("did_threads")
      .insert(insertPayload)
      .select("id")
      .single();

    if (insErr) {
      console.error("[part-session-prepare] insert error:", insErr);
      return jsonRes({ error: insErr.message }, 500);
    }

    console.log(`[part-session-prepare] created room ${created.id} for ${partName} (date=${today})`);
    return jsonRes({ thread_id: created.id, created: true });
  } catch (e) {
    console.error("[part-session-prepare] fatal:", e);
    return jsonRes({ error: String(e) }, 500);
  }
});

function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
