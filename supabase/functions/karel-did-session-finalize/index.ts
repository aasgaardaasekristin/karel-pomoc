import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.50.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type FinalizeSource = "manual_end" | "save_transcript" | "exit_session" | "auto_safety_net" | "completed" | "partial";
type JobStatus = "queued" | "running" | "completed" | "failed" | "already_done";

const json = (payload: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const isUniqueViolation = (error: any) => String(error?.code || "") === "23505";

function hasNonEmptyTurns(turnsByBlock: Record<string, any> = {}) {
  return Object.values(turnsByBlock || {}).some((value: any) => Array.isArray(value) && value.length > 0);
}

function hasNonEmptyObservations(items: any[] = []) {
  return items.some((item: any) => String(item?.observation ?? "").trim().length > 0);
}

function hasThreadUserResponse(threads: any[] = []) {
  return threads.some((thread: any) => {
    const messages = Array.isArray(thread?.messages) ? thread.messages : [];
    return messages.slice(1).some((m: any) => String(m?.role ?? "").toLowerCase() === "user" && String(m?.content ?? "").trim().length > 0);
  });
}

async function persistPlannedNotStarted(sb: any, plan: any, jobBase: Record<string, unknown>, jobId: string, reason: string) {
  const now = new Date().toISOString();
  const text = "Sezení bylo naplánováno, ale v evidenci není záznam, že začalo. Nelze z toho odvozovat stav části. Je potřeba ověřit u terapeutky, zda se pokus skutečně odehrál.";
  const analysisJson = {
    outcome: "planned_not_started",
    post_session_result: { status: "planned_not_started", contactOccurred: false },
    evidence_basis: "planned_only",
    confirmed_facts: {
      plan_id: plan.id,
      part_name: plan.selected_part,
      plan_existed: true,
      no_live_progress: true,
      no_matching_thread: true,
      no_user_response: true,
    },
    unknowns: ["zda se pokus o sezení vůbec odehrál"],
    reason,
  };
  const reviewPayload = {
    user_id: plan.user_id,
    plan_id: plan.id,
    part_name: plan.selected_part,
    session_date: plan.plan_date,
    status: "evidence_limited",
    review_kind: "calendar_day_safety_net",
    analysis_version: "did-session-review-v1-planned-not-started",
    source_data_summary: "planned_only:no_session_started_evidence",
    evidence_items: [
      { kind: "session_plan", available: true, source_table: "did_daily_session_plans", source_id: plan.id, date: plan.plan_date },
      { kind: "session_started_evidence", available: false },
    ],
    completed_checklist_items: [],
    missing_checklist_items: [],
    transcript_available: false,
    live_progress_available: false,
    clinical_summary: text,
    therapeutic_implications: "Ověřit u terapeutky, zda se pokus o sezení skutečně odehrál.",
    team_implications: null,
    next_session_recommendation: "Neodvozovat klinické závěry z plánu; nejprve ověřit realitu sezení.",
    evidence_limitations: "Existuje plán, ale chybí evidence zahájení: žádné completed blocks, turn-by-turn data, observations, artifacts ani odpověď části v threadu navázaném na tento plan_id.",
    analysis_json: analysisJson,
    projection_status: "skipped",
    error_message: null,
    is_current: true,
    updated_at: now,
  };
  const { data: existingReview } = await sb.from("did_session_reviews").select("id").eq("plan_id", plan.id).eq("is_current", true).maybeSingle();
  let reviewId = existingReview?.id ?? null;
  if (reviewId) await sb.from("did_session_reviews").update(reviewPayload).eq("id", reviewId);
  else {
    const { data: inserted } = await sb.from("did_session_reviews").insert(reviewPayload).select("id").single();
    reviewId = inserted?.id ?? null;
  }
  await sb.from("did_daily_session_plans").update({
    lifecycle_status: "evidence_limited",
    urgency_breakdown: { ...(plan.urgency_breakdown ?? {}), result_status: "planned_not_started", session_started_evidence: false },
    finalized_at: now,
    finalization_source: "auto_safety_net",
    finalization_reason: reason,
    updated_at: now,
  }).eq("id", plan.id);
  const resultPayload = { plan_id: plan.id, review_id: reviewId, review_status: "evidence_limited", outcome: "planned_not_started" };
  await sb.from("karel_action_jobs").update({
    status: "completed",
    completed_at: now,
    result_summary: "Session planned but not started",
    result_payload: resultPayload,
    error_message: null,
  }).eq("id", jobId);
  return resultPayload;
}

async function upsertTerminalJob(sb: any, base: Record<string, unknown>, status: JobStatus, payload: Record<string, unknown>) {
  const now = new Date().toISOString();
  const row = {
    ...base,
    status,
    result_summary: status === "already_done" ? "Session review already exists" : "Session finalization completed",
    result_payload: payload,
    error_message: null,
    started_at: now,
    completed_at: now,
  };

  const { data, error } = await sb
    .from("karel_action_jobs")
    .upsert(row, { onConflict: "dedupe_key" })
    .select("id, status, dedupe_key, result_payload")
    .single();
  if (error) throw error;
  return data;
}

async function findJob(sb: any, dedupeKey: string) {
  const { data, error } = await sb
    .from("karel_action_jobs")
    .select("*")
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();
  if (error) throw error;
  return data;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const planId = String(body?.planId || "").trim();
    const source = String(body?.source || "manual_end") as FinalizeSource;
    const reason = String(body?.reason || source);
    const force = body?.force === true;

    if (!planId) return json({ ok: false, error: "planId je povinné" }, 400);

    const { data: plan, error: planErr } = await sb
      .from("did_daily_session_plans")
      .select("id, user_id, plan_date, selected_part, lifecycle_status, urgency_breakdown")
      .eq("id", planId)
      .maybeSingle();
    if (planErr) throw planErr;
    if (!plan) return json({ ok: false, error: "Plán sezení nenalezen" }, 404);

    const dedupeKey = `finalize_session:${planId}`;
    const jobBase = {
      user_id: plan.user_id,
      job_type: "finalize_session",
      dedupe_key: dedupeKey,
      target_type: "did_session_plan",
      target_id: planId,
      source_function: "karel-did-session-finalize",
    };

    const { data: existingReview } = await sb
      .from("did_session_reviews")
      .select("id, status, clinical_summary")
      .eq("plan_id", planId)
      .eq("is_current", true)
      .maybeSingle();

    if (existingReview && !force) {
      const resultPayload = { plan_id: planId, review_id: existingReview.id, review_status: existingReview.status };
      const job = await upsertTerminalJob(sb, jobBase, "already_done", resultPayload);
      return json({
        ok: true,
        reused: true,
        job_id: job.id,
        job_status: "already_done",
        dedupe_key: dedupeKey,
        review_id: existingReview.id,
        review: existingReview,
        result_payload: resultPayload,
      });
    }

    const existingJob = await findJob(sb, dedupeKey);
    if (existingJob && !force) {
      if (["queued", "running", "completed", "already_done"].includes(existingJob.status)) {
        return json({
          ok: true,
          job_id: existingJob.id,
          job_status: existingJob.status,
          dedupe_key: dedupeKey,
          review_id: existingJob.result_payload?.review_id ?? null,
          result_payload: existingJob.result_payload ?? {},
        });
      }
      if (existingJob.status === "failed") {
        return json({
          ok: false,
          job_id: existingJob.id,
          job_status: "failed",
          dedupe_key: dedupeKey,
          error: existingJob.error_message || "Předchozí finalizace selhala; automatický retry není v C1 povolen.",
        }, 409);
      }
    }

    const now = new Date().toISOString();
    const { data: insertedJob, error: insertJobErr } = await sb
      .from("karel_action_jobs")
      .insert({ ...jobBase, status: "running", started_at: now })
      .select("id, status, dedupe_key")
      .single();

    if (insertJobErr) {
      if (isUniqueViolation(insertJobErr)) {
        const job = await findJob(sb, dedupeKey);
        return json({
          ok: job?.status !== "failed",
          job_id: job?.id ?? null,
          job_status: job?.status ?? "running",
          dedupe_key: dedupeKey,
          result_payload: job?.result_payload ?? {},
          error: job?.status === "failed" ? job?.error_message : undefined,
        }, job?.status === "failed" ? 409 : 200);
      }
      throw insertJobErr;
    }

    const jobId = insertedJob.id;

    try {
      const { data: liveProgress } = await sb
        .from("did_live_session_progress")
        .select("items, turns_by_block, artifacts_by_block, completed_blocks, total_blocks")
        .eq("plan_id", planId)
        .maybeSingle();

      const { data: matchingThreads } = await sb
        .from("did_threads")
        .select("id, messages, workspace_type, workspace_id")
        .eq("workspace_type", "session")
        .eq("workspace_id", planId)
        .limit(3);

      const items = Array.isArray(liveProgress?.items) ? liveProgress.items : [];
      const observationsByBlock = Object.fromEntries(
        items
          .map((it: any, idx: number) => [String(idx), String(it?.observation ?? "")])
          .filter((entry: string[]) => String(entry[1] ?? "").trim().length > 0),
      );
      const artifactCount = Object.values(liveProgress?.artifacts_by_block ?? {}).reduce((sum: number, value: any) => sum + (Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.keys(value).length : 0), 0);
      const sessionStarted = (liveProgress?.completed_blocks ?? 0) > 0 || hasNonEmptyTurns(liveProgress?.turns_by_block ?? {}) || hasNonEmptyObservations(items) || artifactCount > 0 || hasThreadUserResponse(matchingThreads ?? []);
      const sessionActor = plan.urgency_breakdown && typeof plan.urgency_breakdown === "object" ? plan.urgency_breakdown.session_actor : null;
      if (source === "auto_safety_net" && !sessionStarted && sessionActor !== "karel_direct") {
        const resultPayload = await persistPlannedNotStarted(sb, plan, jobBase, jobId, reason);
        return json({ ok: true, job_id: jobId, job_status: "completed", dedupe_key: dedupeKey, ...resultPayload });
      }

      await sb.from("did_daily_session_plans").update({
        lifecycle_status: "awaiting_analysis",
        finalized_at: now,
        finalization_source: source,
        finalization_reason: reason,
        updated_at: now,
      }).eq("id", planId);

      const evalRes = await fetch(`${supabaseUrl}/functions/v1/karel-did-session-evaluate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          planId,
          endedReason: source === "auto_safety_net" ? "auto_safety_net" : reason === "completed" ? "completed" : "partial",
          completedBlocks: liveProgress?.completed_blocks,
          totalBlocks: liveProgress?.total_blocks,
          turnsByBlock: liveProgress?.turns_by_block ?? {},
          observationsByBlock,
          force,
        }),
      });

      const evalPayload = await evalRes.json().catch(() => ({}));
      if (!evalRes.ok || evalPayload?.ok === false) {
        const message = evalPayload?.error || `Evaluator HTTP ${evalRes.status}`;
        await sb.from("did_daily_session_plans").update({
          lifecycle_status: "failed_analysis",
          analysis_error: message,
          updated_at: new Date().toISOString(),
        }).eq("id", planId);

        const failureReview = {
          user_id: plan.user_id,
          plan_id: planId,
          part_name: plan.selected_part,
          session_date: plan.plan_date,
          status: "failed_analysis",
          review_kind: source === "auto_safety_net" ? "calendar_day_safety_net" : "scheduled_session",
          evidence_items: [{ kind: "failure", available: true, error: message }],
          source_data_summary: "analysis failed",
          projection_status: "skipped",
          error_message: message,
          updated_at: new Date().toISOString(),
        };

        const { data: existingFailureReview } = await sb
          .from("did_session_reviews")
          .select("id")
          .eq("plan_id", planId)
          .eq("is_current", true)
          .maybeSingle();
        if (existingFailureReview?.id) {
          await sb.from("did_session_reviews").update(failureReview).eq("id", existingFailureReview.id);
        } else {
          await sb.from("did_session_reviews").insert(failureReview);
        }

        await sb.from("karel_action_jobs").update({
          status: "failed",
          error_message: message,
          completed_at: new Date().toISOString(),
          result_summary: "Session finalization failed",
        }).eq("id", jobId);

        return json({ ok: false, job_id: jobId, job_status: "failed", dedupe_key: dedupeKey, error: message }, 500);
      }

      const resultPayload = {
        plan_id: planId,
        review_id: evalPayload?.review_id ?? null,
        review_status: evalPayload?.review_status ?? null,
      };
      await sb.from("karel_action_jobs").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        result_summary: "Session finalization completed",
        result_payload: resultPayload,
        error_message: null,
      }).eq("id", jobId);

      return json({
        ok: true,
        job_id: jobId,
        job_status: "completed",
        dedupe_key: dedupeKey,
        review_id: resultPayload.review_id,
        result_payload: resultPayload,
        ...evalPayload,
      });
    } catch (workErr: any) {
      const message = workErr?.message ?? String(workErr);
      await sb.from("karel_action_jobs").update({
        status: "failed",
        error_message: message,
        completed_at: new Date().toISOString(),
        result_summary: "Session finalization failed",
      }).eq("id", jobId);
      throw workErr;
    }
  } catch (e: any) {
    console.error("[karel-did-session-finalize] fatal:", e);
    return json({ ok: false, error: e?.message ?? String(e) }, 500);
  }
});