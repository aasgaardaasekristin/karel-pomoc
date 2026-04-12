import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ═══════════════════════════════════════════════════════════════
// KAREL THERAPIST CRISIS REVIEW — v1
//
// Systematicky profiluje terapeutky podle krizového chování.
// Vytváří / aktualizuje:
//   - therapist_crisis_case_reviews (per-krize hodnocení)
//   - therapist_crisis_profile (agregovaný profil)
//
// Volá se:
//   - z analyst-loop po zpracování krizí
//   - nebo samostatně (cron / manuálně)
//
// Data zdroje:
//   - did_therapist_tasks (splněné/nesplněné, timing)
//   - crisis_daily_assessments (kdo co zapsal)
//   - did_pending_questions (odpovědi, timing)
//   - did_meetings (účast, pozice, závěry)
//   - crisis_events (ownership, days, closure)
//   - did_daily_session_plans (plnění sezení)
//   - crisis_session_questions (odpovědi po sezení)
// ═══════════════════════════════════════════════════════════════

const THERAPISTS = ["hanka", "kata"] as const;
type TherapistName = typeof THERAPISTS[number];

interface CaseScores {
  response_speed_score: number | null;
  task_reliability_score: number | null;
  observation_quality_score: number | null;
  initiative_score: number | null;
  meeting_participation_score: number | null;
  closure_alignment_score: number | null;
  supervision_trust_score: number | null;
  crisis_judgment_score: number | null;
  escalation_sensitivity_score: number | null;
  consistency_score: number | null;
  strengths_observed: string[];
  risks_observed: string[];
  recommended_karel_mode: string;
  supervision_notes: string;
}

// ── Score helpers ──────────────────────────────────────────────

function clamp(v: number, min = 0, max = 10): number {
  return Math.round(Math.min(max, Math.max(min, v)) * 10) / 10;
}

function avgOrNull(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v !== null && !isNaN(v));
  if (valid.length === 0) return null;
  return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10;
}

// ── Task reliability ──────────────────────────────────────────
// Looks at tasks assigned to therapist during the crisis period.
// Score = ratio of completed tasks, penalized for overdue.
function computeTaskReliability(tasks: any[], therapist: TherapistName): { score: number | null; strengths: string[]; risks: string[] } {
  const mine = tasks.filter(t => (t.assigned_to || "").toLowerCase() === therapist || t.assigned_to === "both");
  if (mine.length === 0) return { score: null, strengths: [], risks: [] };

  const done = mine.filter(t => t.status === "done" || t.status === "completed");
  const overdue = mine.filter(t => {
    if (!t.due_date || t.status === "done" || t.status === "completed") return false;
    return new Date(t.due_date) < new Date();
  });

  const ratio = done.length / mine.length;
  const overdueRatio = overdue.length / mine.length;
  const score = clamp(ratio * 10 - overdueRatio * 3);

  const strengths: string[] = [];
  const risks: string[] = [];
  if (ratio >= 0.8) strengths.push("vysoká spolehlivost v plnění úkolů");
  if (overdueRatio > 0.3) risks.push(`${overdue.length}/${mine.length} úkolů po termínu`);

  return { score, strengths, risks };
}

// ── Response speed ────────────────────────────────────────────
// Measures how quickly therapist responds to pending questions.
function computeResponseSpeed(questions: any[], therapist: TherapistName): { score: number | null; strengths: string[]; risks: string[] } {
  const mine = questions.filter(q => {
    const directedTo = (q.directed_to || "").toLowerCase();
    return directedTo === therapist || directedTo === "both";
  });

  const answered = mine.filter(q => q.status === "answered" && q.answered_at && q.created_at);
  if (answered.length === 0 && mine.length === 0) return { score: null, strengths: [], risks: [] };
  if (answered.length === 0) return { score: 3, strengths: [], risks: ["žádná odpověď na otázky"] };

  const hours = answered.map(q => {
    const diff = new Date(q.answered_at).getTime() - new Date(q.created_at).getTime();
    return diff / 3_600_000;
  });
  const avgHours = hours.reduce((a, b) => a + b, 0) / hours.length;

  // < 4h = 10, 12h = 7, 24h = 5, 48h = 3, > 72h = 1
  let score: number;
  if (avgHours <= 4) score = 10;
  else if (avgHours <= 12) score = 7 + (12 - avgHours) / 8 * 3;
  else if (avgHours <= 24) score = 5 + (24 - avgHours) / 12 * 2;
  else if (avgHours <= 48) score = 3 + (48 - avgHours) / 24 * 2;
  else score = Math.max(1, 3 - (avgHours - 48) / 24);

  const strengths: string[] = [];
  const risks: string[] = [];
  if (avgHours < 6) strengths.push("rychlé odpovědi na krizové otázky");
  if (avgHours > 24) risks.push(`průměrná odezva ${Math.round(avgHours)}h`);

  return { score: clamp(score), strengths, risks };
}

// ── Observation quality ───────────────────────────────────────
// Based on assessment contributions and session question answers.
function computeObservationQuality(
  assessments: any[],
  sessionQuestions: any[],
  therapist: TherapistName,
): { score: number | null; strengths: string[]; risks: string[] } {
  const field = therapist === "hanka" ? "therapist_hana_observation" : "therapist_kata_observation";
  const ratingField = therapist === "hanka" ? "therapist_hana_risk_rating" : "therapist_kata_risk_rating";

  const withObs = assessments.filter(a => a[field] && a[field].trim().length > 20);
  const withRating = assessments.filter(a => a[ratingField] !== null);

  const answeredSQ = sessionQuestions.filter(sq =>
    sq.therapist_name === therapist && sq.answer_text && sq.answer_text.trim().length > 10
  );
  const qualityScores = answeredSQ
    .filter(sq => sq.answer_quality_score !== null)
    .map(sq => sq.answer_quality_score);

  const signals: number[] = [];
  if (assessments.length > 0) {
    signals.push(clamp((withObs.length / assessments.length) * 10));
    if (withRating.length > 0) signals.push(clamp((withRating.length / assessments.length) * 10));
  }
  if (qualityScores.length > 0) {
    signals.push(avgOrNull(qualityScores) || 5);
  }
  if (answeredSQ.length > 0 && sessionQuestions.filter(sq => sq.therapist_name === therapist).length > 0) {
    const answerRatio = answeredSQ.length / sessionQuestions.filter(sq => sq.therapist_name === therapist).length;
    signals.push(clamp(answerRatio * 10));
  }

  const score = avgOrNull(signals);
  const strengths: string[] = [];
  const risks: string[] = [];
  if (withObs.length > 0) strengths.push("pravidelná pozorování v krizových hodnoceních");
  if (assessments.length > 0 && withObs.length === 0) risks.push("chybí pozorování v krizových hodnoceních");

  return { score, strengths, risks };
}

// ── Meeting participation ─────────────────────────────────────
function computeMeetingParticipation(meetings: any[], therapist: TherapistName): { score: number | null; strengths: string[]; risks: string[] } {
  if (meetings.length === 0) return { score: null, strengths: [], risks: [] };

  const positionField = therapist === "hanka" ? "hanka_position" : "kata_position";
  const withPosition = meetings.filter(m => m[positionField] && m[positionField].trim().length > 5);

  const withMessages = meetings.filter(m => {
    const msgs = Array.isArray(m.messages) ? m.messages : [];
    return msgs.some((msg: any) => {
      const author = ((msg as any)?.author || "").toLowerCase();
      return author.includes(therapist === "hanka" ? "han" : "kat");
    });
  });

  const participationRate = Math.max(
    withPosition.length / meetings.length,
    withMessages.length / meetings.length,
  );

  const score = clamp(participationRate * 10);
  const strengths: string[] = [];
  const risks: string[] = [];
  if (participationRate >= 0.7) strengths.push("aktivní účast v krizových poradách");
  if (participationRate < 0.3) risks.push("nízká účast v krizových poradách");

  return { score, strengths, risks };
}

// ── Initiative ────────────────────────────────────────────────
// Did the therapist create tasks proactively, propose ideas in meetings?
function computeInitiative(tasks: any[], meetings: any[], therapist: TherapistName): { score: number | null; strengths: string[]; risks: string[] } {
  const proactiveTasks = tasks.filter(t =>
    (t.source === "therapist_manual") &&
    ((t.assigned_to || "").toLowerCase() === therapist || (t.therapist || "").toLowerCase().includes(therapist.slice(0, 3)))
  );

  const conclusionsWithInput = meetings.filter(m => {
    const conclusions = m.meeting_conclusions;
    if (!conclusions) return false;
    const str = typeof conclusions === "string" ? conclusions : JSON.stringify(conclusions);
    return str.toLowerCase().includes(therapist === "hanka" ? "han" : "kat");
  });

  const signals: number[] = [];
  if (tasks.length > 0) {
    signals.push(clamp(Math.min(proactiveTasks.length * 3, 10)));
  }
  if (meetings.length > 0) {
    signals.push(clamp((conclusionsWithInput.length / meetings.length) * 10));
  }

  const score = avgOrNull(signals);
  const strengths: string[] = [];
  const risks: string[] = [];
  if (proactiveTasks.length >= 2) strengths.push("proaktivní tvorba úkolů");
  if (proactiveTasks.length === 0 && tasks.length > 3) risks.push("žádná vlastní iniciativa v úkolech");

  return { score, strengths, risks };
}

// ── Closure alignment ─────────────────────────────────────────
function computeClosureAlignment(crisis: any, closureChecklist: any, therapist: TherapistName): { score: number | null; strengths: string[]; risks: string[] } {
  if (!closureChecklist) return { score: null, strengths: [], risks: [] };

  const agrees = therapist === "hanka" ? closureChecklist.hanka_agrees : closureChecklist.kata_agrees;
  const karelRecommends = closureChecklist.karel_recommends_closure;

  const strengths: string[] = [];
  const risks: string[] = [];

  if (agrees === null) {
    return { score: null, strengths: [], risks: ["stanovisko k uzavření chybí"] };
  }

  // Alignment = therapist agrees with Karel's recommendation
  let score = 5; // neutral baseline
  if (karelRecommends !== null) {
    if (agrees === karelRecommends) {
      score = 8;
      strengths.push("soulad s Karlovým doporučením k uzavření");
    } else {
      score = 4;
      risks.push("nesoulad s Karlovým doporučením k uzavření");
    }
  } else {
    if (agrees !== null) {
      score = 6; // at least they gave a position
      strengths.push("včasné stanovisko k uzavření");
    }
  }

  return { score: clamp(score), strengths, risks };
}

// ── Determine recommended Karel mode ──────────────────────────
function determineKarelMode(scores: CaseScores): string {
  const reliability = scores.task_reliability_score;
  const speed = scores.response_speed_score;
  const observation = scores.observation_quality_score;
  const initiative = scores.initiative_score;

  // Priority rules
  if (reliability !== null && reliability < 4) return "tight_followup";
  if (speed !== null && speed < 4) return "tight_followup";
  if (observation !== null && observation >= 7 && reliability !== null && reliability >= 7) return "diagnostic_partner";
  if (initiative !== null && initiative < 3) return "explicit_structure";
  if (scores.risks_observed.length >= 3) return "needs_supervision";
  if (reliability !== null && reliability >= 8 && speed !== null && speed >= 7) return "high_autonomy";
  if (observation !== null && observation >= 7) return "stabilization_lead";

  return "explicit_structure"; // safe default
}

// ── Build case review for one therapist + one crisis ──────────
async function buildCaseReview(
  sb: SupabaseClient,
  crisis: any,
  therapist: TherapistName,
): Promise<CaseScores> {
  const crisisId = crisis.id;
  const crisisStart = crisis.opened_at || crisis.created_at;
  const crisisEnd = crisis.closed_at || new Date().toISOString();

  // Fetch data scoped to this crisis
  const [
    { data: tasks },
    { data: questions },
    { data: assessments },
    { data: meetings },
    { data: closureChecklists },
    { data: sessionQuestions },
  ] = await Promise.all([
    sb.from("did_therapist_tasks")
      .select("*")
      .gte("created_at", crisisStart)
      .lte("created_at", crisisEnd),
    sb.from("did_pending_questions")
      .select("*")
      .or(`crisis_event_id.eq.${crisisId},created_at.gte.${crisisStart}`)
      .lte("created_at", crisisEnd),
    sb.from("crisis_daily_assessments")
      .select("*")
      .eq("crisis_event_id", crisisId),
    sb.from("did_meetings")
      .select("*")
      .eq("crisis_event_id", crisisId),
    sb.from("crisis_closure_checklist")
      .select("*")
      .eq("crisis_event_id", crisisId)
      .limit(1),
    sb.from("crisis_session_questions")
      .select("*")
      .eq("crisis_event_id", crisisId),
  ]);

  const checklist = closureChecklists?.[0] || null;

  const taskResult = computeTaskReliability(tasks || [], therapist);
  const speedResult = computeResponseSpeed(questions || [], therapist);
  const obsResult = computeObservationQuality(assessments || [], sessionQuestions || [], therapist);
  const meetingResult = computeMeetingParticipation(meetings || [], therapist);
  const initiativeResult = computeInitiative(tasks || [], meetings || [], therapist);
  const closureResult = computeClosureAlignment(crisis, checklist, therapist);

  const allStrengths = [
    ...taskResult.strengths, ...speedResult.strengths, ...obsResult.strengths,
    ...meetingResult.strengths, ...initiativeResult.strengths, ...closureResult.strengths,
  ];
  const allRisks = [
    ...taskResult.risks, ...speedResult.risks, ...obsResult.risks,
    ...meetingResult.risks, ...initiativeResult.risks, ...closureResult.risks,
  ];

  // Consistency = standard deviation of non-null scores (lower = more consistent = higher score)
  const allScores = [
    taskResult.score, speedResult.score, obsResult.score,
    meetingResult.score, initiativeResult.score, closureResult.score,
  ].filter((s): s is number => s !== null);

  let consistencyScore: number | null = null;
  if (allScores.length >= 3) {
    const mean = allScores.reduce((a, b) => a + b, 0) / allScores.length;
    const variance = allScores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / allScores.length;
    const stddev = Math.sqrt(variance);
    // Low stddev = consistent = high score. stddev 0 = 10, stddev 3+ = 4
    consistencyScore = clamp(10 - stddev * 2);
  }

  // Supervision trust = composite of reliability + observation + consistency
  const supervisionTrust = avgOrNull([taskResult.score, obsResult.score, consistencyScore]);

  // Crisis judgment = composite of closure alignment + escalation sensitivity (simplified)
  const crisisJudgment = avgOrNull([closureResult.score, speedResult.score, obsResult.score]);

  // Escalation sensitivity = did therapist flag concerns early? Approximated from speed + initiative
  const escalationSensitivity = avgOrNull([speedResult.score, initiativeResult.score]);

  const scores: CaseScores = {
    response_speed_score: speedResult.score,
    task_reliability_score: taskResult.score,
    observation_quality_score: obsResult.score,
    initiative_score: initiativeResult.score,
    meeting_participation_score: meetingResult.score,
    closure_alignment_score: closureResult.score,
    supervision_trust_score: supervisionTrust,
    crisis_judgment_score: crisisJudgment,
    escalation_sensitivity_score: escalationSensitivity,
    consistency_score: consistencyScore,
    strengths_observed: allStrengths,
    risks_observed: allRisks,
    recommended_karel_mode: "",
    supervision_notes: "",
  };

  scores.recommended_karel_mode = determineKarelMode(scores);

  // Build supervision notes
  const noteLines: string[] = [];
  if (allStrengths.length > 0) noteLines.push(`Silné stránky: ${allStrengths.join(", ")}`);
  if (allRisks.length > 0) noteLines.push(`Rizika: ${allRisks.join(", ")}`);
  noteLines.push(`Doporučený režim: ${scores.recommended_karel_mode}`);
  const nullCount = [
    scores.response_speed_score, scores.task_reliability_score, scores.observation_quality_score,
    scores.initiative_score, scores.meeting_participation_score, scores.closure_alignment_score,
  ].filter(s => s === null).length;
  if (nullCount > 2) noteLines.push(`⚠️ ${nullCount}/6 základních skóre nelze spočítat — nedostatek dat`);
  scores.supervision_notes = noteLines.join("\n");

  return scores;
}

// ── Aggregate profile from all case reviews ───────────────────
async function updateAggregateProfile(sb: SupabaseClient, therapist: TherapistName): Promise<void> {
  const { data: reviews } = await sb
    .from("therapist_crisis_case_reviews")
    .select("*")
    .eq("therapist_name", therapist)
    .order("created_at", { ascending: false });

  if (!reviews || reviews.length === 0) return;

  const avg = (field: string) => avgOrNull(reviews.map(r => r[field]));

  const profile = {
    therapist_name: therapist,
    aggregate_response_speed_score: avg("response_speed_score"),
    aggregate_task_reliability_score: avg("task_reliability_score"),
    aggregate_observation_quality_score: avg("observation_quality_score"),
    aggregate_initiative_score: avg("initiative_score"),
    aggregate_meeting_participation_score: avg("meeting_participation_score"),
    aggregate_closure_alignment_score: avg("closure_alignment_score"),
    aggregate_supervision_trust_score: avg("supervision_trust_score"),
    aggregate_crisis_judgment_score: avg("crisis_judgment_score"),
    aggregate_escalation_sensitivity_score: avg("escalation_sensitivity_score"),
    aggregate_consistency_score: avg("consistency_score"),
    total_crisis_cases: reviews.length,
    updated_at: new Date().toISOString(),
  };

  // Upsert by therapist_name
  const { error } = await sb
    .from("therapist_crisis_profile")
    .upsert(profile, { onConflict: "therapist_name" });

  if (error) {
    console.error(`[THERAPIST-REVIEW] Aggregate profile upsert error (${therapist}):`, error.message);
  } else {
    console.log(`[THERAPIST-REVIEW] Aggregate profile updated: ${therapist} (${reviews.length} cases)`);
  }
}

// ── Main ──────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const body = await req.json().catch(() => ({}));
    const targetCrisisId = body.crisis_event_id || null;
    const mode = body.mode || "auto"; // "auto" = process unreviewed crises, "specific" = one crisis

    console.log(`[THERAPIST-REVIEW] Starting, mode=${mode}, target=${targetCrisisId}`);

    // Find crises to review
    let crisesToReview: any[] = [];

    if (mode === "specific" && targetCrisisId) {
      const { data } = await sb
        .from("crisis_events")
        .select("*")
        .eq("id", targetCrisisId);
      crisesToReview = data || [];
    } else {
      // Auto: review crises that are closed/stabilizing but don't have reviews yet
      const { data: closedCrises } = await sb
        .from("crisis_events")
        .select("*")
        .in("phase", ["resolved", "closed", "monitoring_post", "stabilizing", "ready_to_close"]);

      for (const crisis of closedCrises || []) {
        // Check if reviews already exist for this crisis
        const { data: existing } = await sb
          .from("therapist_crisis_case_reviews")
          .select("id")
          .eq("crisis_event_id", crisis.id)
          .limit(1);

        if (!existing || existing.length === 0) {
          crisesToReview.push(crisis);
        }
      }

      // Also review active crises older than 3 days (interim review)
      const { data: activeCrises } = await sb
        .from("crisis_events")
        .select("*")
        .in("phase", ["active", "intervened"])
        .lt("created_at", new Date(Date.now() - 3 * 86_400_000).toISOString());

      for (const crisis of activeCrises || []) {
        const { data: existing } = await sb
          .from("therapist_crisis_case_reviews")
          .select("id, created_at")
          .eq("crisis_event_id", crisis.id)
          .order("created_at", { ascending: false })
          .limit(1);

        // Re-review if last review is > 3 days old
        const lastReview = existing?.[0];
        if (!lastReview || (Date.now() - new Date(lastReview.created_at).getTime()) > 3 * 86_400_000) {
          crisesToReview.push(crisis);
        }
      }
    }

    console.log(`[THERAPIST-REVIEW] Found ${crisesToReview.length} crises to review`);

    let reviewsCreated = 0;
    const therapistsUpdated = new Set<TherapistName>();

    for (const crisis of crisesToReview.slice(0, 10)) { // max 10 per run
      for (const therapist of THERAPISTS) {
        try {
          const scores = await buildCaseReview(sb, crisis, therapist);

          const { error } = await sb.from("therapist_crisis_case_reviews").insert({
            crisis_event_id: crisis.id,
            therapist_name: therapist,
            ...scores,
          });

          if (error) {
            console.warn(`[THERAPIST-REVIEW] Insert error (${therapist}, ${crisis.part_name}):`, error.message);
          } else {
            reviewsCreated++;
            therapistsUpdated.add(therapist);
            console.log(`[THERAPIST-REVIEW] Case review created: ${therapist} / ${crisis.part_name} → mode=${scores.recommended_karel_mode}`);
          }
        } catch (err) {
          console.warn(`[THERAPIST-REVIEW] Error reviewing ${therapist} for ${crisis.part_name}:`, err);
        }
      }
    }

    // Update aggregate profiles
    for (const therapist of therapistsUpdated) {
      await updateAggregateProfile(sb, therapist);
    }

    // Log
    await sb.from("system_health_log").insert({
      event_type: "therapist_crisis_review",
      severity: "info",
      message: `Reviews: ${reviewsCreated} created for ${crisesToReview.length} crises. Profiles updated: ${[...therapistsUpdated].join(", ")}`,
    });

    console.log(`[THERAPIST-REVIEW] Done: ${reviewsCreated} reviews, ${therapistsUpdated.size} profiles updated`);

    return new Response(JSON.stringify({
      success: true,
      reviews_created: reviewsCreated,
      crises_reviewed: crisesToReview.length,
      profiles_updated: [...therapistsUpdated],
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[THERAPIST-REVIEW] FATAL:", msg);
    await sb.from("system_health_log").insert({
      event_type: "therapist_crisis_review_error",
      severity: "error",
      message: msg.slice(0, 500),
    }).catch(() => {});
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
