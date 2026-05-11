/**
 * P33.5C — fast completion barrier for the main daily-cycle.
 *
 * After the orchestrator has enqueued every required phase job, the main
 * cycle marker MUST be flipped to `completed` quickly. Long downstream
 * work belongs to the detached phase worker; the main cycle must NOT keep
 * running while phase jobs are detached, otherwise heartbeat goes stale
 * and the whole cycle is incorrectly judged as `failed_stale`.
 */
import {
  P29B3_REQUIRED_PHASE_JOB_KINDS,
  summarizePhaseJobsForCycle,
  type PhaseJobKind,
} from "./dailyCyclePhaseJobs.ts";

export interface FastCompletionInput {
  sb: any;
  cycleId: string;
  userId: string;
  enqueueResult: { enqueued: string[]; skipped: any[]; errors: any[] };
  source: string;
  forceFullPath?: boolean;
  quietDayBranchTaken?: boolean;
}

export interface FastCompletionOutput {
  ok: boolean;
  detached_jobs_required: PhaseJobKind[];
  detached_jobs_enqueued: string[];
  detached_jobs_missing: string[];
  detached_jobs_pending_at_main_completion: string[];
  reason?: string;
}

export async function completeMainOrchestratorAfterPhaseJobDetach(
  i: FastCompletionInput,
): Promise<FastCompletionOutput> {
  const required: PhaseJobKind[] = [...P29B3_REQUIRED_PHASE_JOB_KINDS];

  let summary: Awaited<ReturnType<typeof summarizePhaseJobsForCycle>> | null = null;
  try {
    summary = await summarizePhaseJobsForCycle(i.sb, i.cycleId);
  } catch (e) {
    console.warn("[P33.5C] summarize phase jobs failed (non-fatal):", (e as any)?.message ?? e);
  }

  const byKind = (summary?.by_kind ?? {}) as Record<string, string>;
  const enqueuedKinds = Object.keys(byKind);
  const missing = required.filter((k) => !enqueuedKinds.includes(k));
  const pending = enqueuedKinds.filter((k) =>
    ["queued", "running", "failed_retry"].includes(byKind[k]),
  );

  const completionSemantics = {
    main_orchestrator_completed: true,
    main_phases_completed: true,
    detached_jobs_required: required,
    detached_jobs_enqueued: enqueuedKinds,
    detached_jobs_missing: missing,
    detached_jobs_pending_at_main_completion: pending,
    detached_jobs_summary: summary,
    quiet_day_branch_taken: !!i.quietDayBranchTaken,
    force_full_path_used: !!i.forceFullPath,
    architecture: "p29b_full_detached_long_work",
    p33_5c_fast_completion_barrier: true,
    barrier_source: i.source,
    barrier_completed_at: new Date().toISOString(),
  };

  // Read existing context first to merge (never overwrite phase4 audit etc.).
  let existing: Record<string, unknown> = {};
  try {
    const { data } = await i.sb
      .from("did_update_cycles")
      .select("context_data")
      .eq("id", i.cycleId)
      .maybeSingle();
    if (data?.context_data && typeof data.context_data === "object") {
      existing = data.context_data as Record<string, unknown>;
    }
  } catch (_) { /* non-fatal */ }

  const merged = {
    ...existing,
    phase_jobs: summary,
    daily_cycle_completion_semantics: {
      ...(existing.daily_cycle_completion_semantics as object | undefined ?? {}),
      ...completionSemantics,
    },
  };

  const nowIso = new Date().toISOString();
  try {
    await i.sb
      .from("did_update_cycles")
      .update({
        status: "completed",
        phase: "phase_10_cleanup",
        phase_step: "main_orchestrator_completed_after_phase_job_detach",
        completed_at: nowIso,
        heartbeat_at: nowIso,
        last_heartbeat_at: nowIso,
        last_error: null,
        context_data: merged,
      })
      .eq("id", i.cycleId);
  } catch (e: any) {
    return {
      ok: false,
      detached_jobs_required: required,
      detached_jobs_enqueued: enqueuedKinds,
      detached_jobs_missing: missing,
      detached_jobs_pending_at_main_completion: pending,
      reason: e?.message ?? String(e),
    };
  }

  return {
    ok: true,
    detached_jobs_required: required,
    detached_jobs_enqueued: enqueuedKinds,
    detached_jobs_missing: missing,
    detached_jobs_pending_at_main_completion: pending,
  };
}
