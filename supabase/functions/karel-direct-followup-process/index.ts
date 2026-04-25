import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type FollowUpAction =
  | "retry_same_part_later"
  | "switch_to_different_part"
  | "defer_until_more_context"
  | "therapist_led_check_first"
  | "close_as_not_available_today";

type Confidence = "low" | "moderate" | "high";

type ClassifiedAnswer = {
  action: FollowUpAction;
  confidence: Confidence;
  reason: string;
  nextPart: string;
  sessionMode: string;
  allowedDepth: string;
  firstQuestion: string;
  rawCandidatePart?: string | null;
  entityGuard?: Record<string, unknown> | null;
};

type DbClient = any;

const FORBIDDEN = [
  "trauma_memory_work",
  "deep_regression",
  "unapproved_therapeutic_intervention",
];

const NON_PART_CANDIDATES = new Set([
  "dnes", "spis", "spise", "stazeny", "stazena", "stazene", "unaveny", "unavena", "unavene",
  "mimo", "potichu", "smutny", "smutna", "smutne", "nekdo", "jiny", "jina", "cast", "pritomny",
  "asi", "pravdepodobne", "nevim", "nevi", "později", "pozdeji",
]);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function includesAny(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}

function normalizeIdentity(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "")
    .trim();
}

function cleanCandidate(value: string | undefined): string | null {
  const candidate = String(value ?? "").replace(/[.,;:!?"'„“”()\[\]]/g, "").trim();
  if (!candidate) return null;
  const normalized = normalizeIdentity(candidate);
  if (!normalized || NON_PART_CANDIDATES.has(normalized)) return null;
  return candidate;
}

function hasNegatedDanger(text: string): boolean {
  return includesAny(text, [
    "bez známek nebezpečí",
    "bez znamek nebezpeci",
    "neviděla jsem známky nebezpečí",
    "nevidela jsem znamky nebezpeci",
    "neviděl jsem známky nebezpečí",
    "nevidel jsem znamky nebezpeci",
    "ani známky nebezpečí",
    "ani znamky nebezpeci",
  ]);
}

function isActiveCandidate(row: Record<string, unknown>, expectedPart: string): boolean {
  const status = normalizeText(row.status).toLowerCase();
  const lifecycle = normalizeText(row.lifecycle_status).toLowerCase();
  const breakdown = (row.urgency_breakdown ?? {}) as Record<string, unknown>;
  const selectedPart = normalizeText(row.selected_part);
  if (status === "cancelled" || lifecycle === "cancelled") return false;
  if (breakdown.invalidated_reason || breakdown.result_status === "invalidated") return false;
  if (!selectedPart || NON_PART_CANDIDATES.has(normalizeIdentity(selectedPart))) return false;
  if (expectedPart && normalizeIdentity(selectedPart) !== normalizeIdentity(expectedPart)) return false;
  return true;
}

async function resolveVerifiedPart(sb: DbClient, candidate: string, userId: string): Promise<{ selectedPart: string; guard: Record<string, unknown> } | null> {
  const candidateNorm = normalizeIdentity(candidate);
  const { data: parts, error } = await sb
    .from("did_part_registry")
    .select("part_name, display_name, status, index_confirmed_at")
    .eq("user_id", userId)
    .limit(500);
  if (error) throw error;

  const matched = ((parts ?? []) as Record<string, unknown>[]).find((part: Record<string, unknown>) => {
    return [part.part_name, part.display_name].some((value) => normalizeIdentity(String(value ?? "")) === candidateNorm);
  });

  if (!matched) return null;
  const selectedPart = normalizeText(matched.display_name) || normalizeText(matched.part_name);
  if (!selectedPart) return null;
  return {
    selectedPart,
    guard: {
      raw_candidate: candidate,
      resolution: "registry_part",
      selected_part: selectedPart,
      index_confirmed: Boolean(matched.index_confirmed_at),
      status: matched.status ?? null,
    },
  };
}

function extractDifferentPart(answer: string, plannedPart: string): string | null {
  const name = "([\\p{L}][\\p{L}0-9_-]{1,40})";
  const patterns: { pattern: RegExp; index: number }[] = [
    { pattern: new RegExp(`\\bnebyl[ao]?\\s+to\\s+${name}\\s*[,;:.!?-]+\\s*(?:ale\\s+|spíš\\s+|spise\\s+)?(?:byl[ao]?\\s+to|to\\s+byl[ao]?)\\s+${name}`, "iu"), index: 2 },
    { pattern: new RegExp(`\\b(?:myslím|myslim)\\s*,?\\s*že\\s+to\\s+byl[ao]?\\s+${name}`, "iu"), index: 1 },
    { pattern: new RegExp(`\\bbyl[ao]?\\s+to\\s+${name}`, "iu"), index: 1 },
    { pattern: new RegExp(`\\bto\\s+byl[ao]?\\s+${name}`, "iu"), index: 1 },
    { pattern: new RegExp(`\\bozval[ao]?\\s+se\\s+${name}(?:\\s*,?\\s*ne\\s+${name})?`, "iu"), index: 1 },
    { pattern: new RegExp(`\\bmluvil[ao]?\\s+(?:jiná|jina)\\s+(?:část|cast)\\s*[,;:-]?\\s*(?:asi\\s+|pravděpodobně\\s+|pravdepodobne\\s+)?${name}`, "iu"), index: 1 },
    { pattern: new RegExp(`\\b(?:přítomn[ýá]|pritomn[ya])\\s+byl[ao]?\\s+${name}`, "iu"), index: 1 },
  ];
  const plannedNorm = normalizeIdentity(plannedPart);
  for (const { pattern, index } of patterns) {
    const match = answer.match(pattern);
    const candidate = cleanCandidate(match?.[index]);
    if (candidate && normalizeIdentity(candidate) !== plannedNorm) return candidate;
  }
  return null;
}

async function classifyAnswer(sb: DbClient, answer: string, plannedPart: string, userId: string): Promise<ClassifiedAnswer> {
  const lower = answer.toLowerCase();
  const differentPart = extractDifferentPart(answer, plannedPart);

  if (differentPart) {
    const verified = await resolveVerifiedPart(sb, differentPart, userId);
    if (!verified) {
      return {
        action: "defer_until_more_context",
        confidence: "low",
        reason: "Odpověď obsahuje možnou identitní formulaci, ale kandidát části není ověřený v registru/alias guardu.",
        nextPart: plannedPart,
        sessionMode: "deferred",
        allowedDepth: "check_in_only",
        firstQuestion: "Počkat na jasnější kontext od terapeutek; nepokračovat automaticky.",
        rawCandidatePart: differentPart,
        entityGuard: { raw_candidate: differentPart, resolution: "uncertain", selected_part: null },
      };
    }
    return {
      action: "switch_to_different_part",
      confidence: includesAny(lower, ["určitě", "jasně", "potvrzuji", "jsem si jist"]) ? "high" : "moderate",
      reason: "Odpověď explicitně naznačuje přítomnost jiné části.",
      nextPart: verified.selectedPart,
      sessionMode: "state_mapping",
      allowedDepth: "state_mapping",
      firstQuestion: "Můžu se jen krátce zeptat, kdo je teď nejblíž, bez tlaku na hluboké věci?",
      rawCandidatePart: differentPart,
      entityGuard: verified.guard,
    };
  }

  if (includesAny(lower, ["riziko", "nebezpe", "sebepo", "suicid", "ublížit", "ublizit", "nejist", "nevím", "nevim", "ověřit", "overit", "nejdřív hanka", "nejdriv hanka", "nejdřív káťa", "nejdriv kata"]) && !hasNegatedDanger(lower)) {
    return {
      action: "therapist_led_check_first",
      confidence: includesAny(lower, ["riziko", "nebezpe", "sebepo", "suicid", "ublížit", "ublizit"]) ? "moderate" : "low",
      reason: "Odpověď naznačuje nejistotu nebo potřebu lidského ověření před dalším kontaktem.",
      nextPart: plannedPart,
      sessionMode: "deferred",
      allowedDepth: "check_in_only",
      firstQuestion: "Nejdřív prosím ověřit stav terapeutkou; Karel zatím nespouští přímý kontakt.",
    };
  }

  if (includesAny(lower, ["není dostup", "neni dostup", "nemá smysl", "nema smysl", "dnes ne", "nezkoušet", "nezkouset", "zavřít", "zavrit"])) {
    return {
      action: "close_as_not_available_today",
      confidence: includesAny(lower, ["jasně", "určitě", "potvrzuji", "nemá smysl", "nema smysl"]) ? "high" : "moderate",
      reason: "Terapeutická odpověď jasně uzavírá dnešní dostupnost části.",
      nextPart: plannedPart,
      sessionMode: "deferred",
      allowedDepth: "check_in_only",
      firstQuestion: "Dnes kontakt nezkoušet; počkat na další bezpečný kontext.",
    };
  }

  if (includesAny(lower, ["unaven", "stažen", "stazen", "nepřipraven", "nepripraven", "přetížen", "pretizen", "potřebuje čas", "potrebuje cas", "později", "pozdeji", "zkusit znovu"])) {
    return {
      action: "retry_same_part_later",
      confidence: "moderate",
      reason: "Odpověď naznačuje dočasnou únavu, stažení nebo nepřipravenost bez důvodu měnit část.",
      nextPart: plannedPart,
      sessionMode: "check_in",
      allowedDepth: "check_in_only",
      firstQuestion: "Můžu se jen krátce zeptat, jestli je teď o trochu víc prostoru než minule?",
    };
  }

  return {
    action: "defer_until_more_context",
    confidence: "low",
    reason: "Odpověď není dostatečně určitá pro bezpečný další Karel-direct krok.",
    nextPart: plannedPart,
    sessionMode: "deferred",
    allowedDepth: "check_in_only",
    firstQuestion: "Počkat na jasnější kontext od terapeutek; nepokračovat automaticky.",
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const questionId = normalizeText(body.question_id);
    if (!questionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(questionId)) {
      return jsonResponse({ error: "Invalid question_id" }, 400);
    }

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: question, error: qErr } = await sb
      .from("did_pending_questions")
      .select("*")
      .eq("id", questionId)
      .maybeSingle();
    if (qErr) throw qErr;
    if (!question) return jsonResponse({ error: "Question not found" }, 404);
    if (question.subject_type !== "karel_direct_session") return jsonResponse({ error: "Unsupported subject_type" }, 400);
    if (question.status !== "answered") return jsonResponse({ error: "Question is not answered" }, 400);
    const answer = normalizeText(question.answer);
    if (!answer) return jsonResponse({ error: "Answer is empty" }, 400);
    const sourcePlanId = normalizeText(question.subject_id);
    if (!sourcePlanId) return jsonResponse({ error: "Missing source plan id" }, 400);

    const { data: sourcePlan, error: planErr } = await sb
      .from("did_daily_session_plans")
      .select("*")
      .eq("id", sourcePlanId)
      .maybeSingle();
    if (planErr) throw planErr;
    if (!sourcePlan) return jsonResponse({ error: "Source plan not found" }, 404);

    const { data: review } = await sb
      .from("did_session_reviews")
      .select("id")
      .eq("plan_id", sourcePlanId)
      .eq("is_current", true)
      .maybeSingle();

    const classified = await classifyAnswer(sb, answer, sourcePlan.selected_part || "", sourcePlan.user_id);
    const now = new Date().toISOString();
    const nextCandidate = {
      session_actor: "karel_direct",
      session_mode: classified.sessionMode,
      selected_part: classified.nextPart,
      first_question: classified.firstQuestion,
      allowed_depth: classified.allowedDepth,
      forbidden: FORBIDDEN,
    };

    const followUpResult = {
      schema: "karel_direct_followup_result.v1",
      follow_up_action: classified.action,
      human_review_required: true,
      action_reason: classified.reason,
      action_confidence: classified.confidence,
      linked_plan_id: sourcePlanId,
      linked_review_id: review?.id ?? null,
      next_candidate: nextCandidate,
      raw_candidate_part: classified.rawCandidatePart ?? null,
      entity_guard: classified.entityGuard ?? null,
      processed_at: now,
    };

    let candidatePlanId: string | null = null;
    let candidateCreated = false;

    if (classified.action !== "close_as_not_available_today") {
      const { data: byQuestion } = await sb
        .from("did_daily_session_plans")
        .select("id, selected_part, status, lifecycle_status, urgency_breakdown")
        .contains("urgency_breakdown", { source_question_id: questionId })
        .limit(20);
      const { data: bySourcePlan } = await sb
        .from("did_daily_session_plans")
        .select("id, selected_part, status, lifecycle_status, urgency_breakdown")
        .contains("urgency_breakdown", { kind: "karel_direct_followup_candidate", source_plan_id: sourcePlanId })
        .limit(20);

      const existingByQuestion = (byQuestion ?? []).find((row: Record<string, unknown>) => isActiveCandidate(row, classified.nextPart));
      const existingBySourcePlan = (bySourcePlan ?? []).find((row: Record<string, unknown>) => isActiveCandidate(row, classified.nextPart));
      const existingId = existingByQuestion?.id ?? existingBySourcePlan?.id ?? null;
      if (existingId) {
        candidatePlanId = existingId;
      } else {
        const urgencyBreakdown = {
          kind: "karel_direct_followup_candidate",
          session_actor: "karel_direct",
          source_question_id: questionId,
          source_plan_id: sourcePlanId,
          source_review_id: review?.id ?? null,
          follow_up_action: classified.action,
          human_review_required: true,
          session_mode: classified.sessionMode,
          allowed_depth: classified.allowedDepth,
          forbidden: FORBIDDEN,
          first_question: classified.firstQuestion,
          result_status: null,
        };
        const markdown = [
          `## Karel-direct follow-up candidate: ${classified.nextPart}`,
          "",
          `Akce: ${classified.action}`,
          `Režim: ${classified.sessionMode}`,
          `První bezpečná věta: ${classified.firstQuestion}`,
          "",
          "Pouze draft/candidate; vyžaduje lidské potvrzení.",
        ].join("\n");
        const { data: inserted, error: insertErr } = await sb
          .from("did_daily_session_plans")
          .insert({
            user_id: sourcePlan.user_id,
            plan_date: sourcePlan.plan_date,
            selected_part: classified.nextPart || sourcePlan.selected_part,
            urgency_score: Math.max(0, Number(sourcePlan.urgency_score ?? 0) - 5),
            urgency_breakdown: urgencyBreakdown,
            plan_markdown: markdown,
            plan_html: markdown.replace(/\n/g, "<br>"),
            therapist: "karel",
            status: "generated",
            generated_by: "karel_direct_followup_process",
            part_tier: sourcePlan.part_tier || "active",
            session_lead: "karel",
            session_format: "direct_contact",
            crisis_event_id: sourcePlan.crisis_event_id ?? null,
            lifecycle_status: "planned",
          })
          .select("id")
          .single();
        if (insertErr) throw insertErr;
        candidatePlanId = inserted?.id ?? null;
        candidateCreated = true;
      }
    }

    await sb
      .from("did_pending_questions")
      .update({
        follow_up_result: { ...followUpResult, candidate_plan_id: candidatePlanId, candidate_created: candidateCreated },
        processed_by_reactive: true,
      })
      .eq("id", questionId);

    return jsonResponse({ success: true, follow_up_result: followUpResult, candidate_plan_id: candidatePlanId, candidate_created: candidateCreated });
  } catch (error) {
    console.error("[karel-direct-followup-process] error", error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
