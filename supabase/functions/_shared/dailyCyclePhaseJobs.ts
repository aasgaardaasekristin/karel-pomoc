/**
 * P29B: shared helper for did_daily_cycle_phase_jobs.
 *
 * Main daily-cycle uses this to enqueue detached work (profiling,
 * card autoupdate, therapist intel, session eval safety net,
 * pantry flush, drive queue flush). The phase worker picks them up.
 *
 * Idempotency key = `${cycle_id}:${job_kind}` — re-enqueues are no-ops.
 */

export type PhaseJobKind =
  | "phase4_card_profiling"
  | "phase4_card_update_tail"
  | "phase4_centrum_tail"
  | "phase5_revize_05ab"
  | "phase55_crisis_bridge"
  | "phase6_card_autoupdate"
  | "phase65_memory_cleanup"
  | "phase7_operative_plan"
  | "phase75_escalation_emails"
  | "phase76_feedback_retry"
  | "phase76b_auto_feedback_ai"
  | "phase8_therapist_intel"
  | "phase8a5_session_eval_safety_net"
  | "phase8b_pantry_flush"
  | "phase9_drive_queue_flush";

/**
 * P29B.3-S0: list of phase jobs the main daily-cycle MUST enqueue
 * immediately after `update_cards_enqueued`. Used by the orchestrator
 * helper, the completion-semantics writer and the test suite.
 */
export const P29B3_REQUIRED_PHASE_JOB_KINDS: readonly PhaseJobKind[] = [
  "phase4_centrum_tail",
  "phase4_card_profiling",
  "phase5_revize_05ab",
  "phase55_crisis_bridge",
  "phase6_card_autoupdate",
  "phase65_memory_cleanup",
  "phase7_operative_plan",
  "phase75_escalation_emails",
  "phase76_feedback_retry",
  "phase76b_auto_feedback_ai",
  "phase8_therapist_intel",
  "phase8a5_session_eval_safety_net",
  "phase8b_pantry_flush",
  "phase9_drive_queue_flush",
] as const;

/**
 * P29B.3-S0: helper kinds that have NOT yet been implemented as detached
 * workers. The phase worker MUST mark them as `controlled_skipped` with
 * the reason below — they must never stay queued/running and must never
 * cause a 500.
 */
export const P29B3_S0_UNIMPLEMENTED_HELPER_KINDS: readonly PhaseJobKind[] = [
  // P29B.3-H5: phase5_revize_05ab now implemented in phase worker.
  // P29B.3-H6: phase65_memory_cleanup now implemented in phase worker.
  // P29B.3-H1: phase7_operative_plan now implemented in phase worker.
  // P29B.3-H2: phase75_escalation_emails now implemented in phase worker.
  // P29B.3-H3: phase76_feedback_retry now implemented in phase worker.
  // P29B.3-H4: phase76b_auto_feedback_ai now implemented in phase worker.
] as const;

export const P29B3_S0_HELPER_NOT_IMPLEMENTED_REASON =
  "helper_not_implemented_yet_p29b3_staged_refactor";

export interface EnqueuePhaseJobInput {
  cycle_id: string;
  user_id: string;
  phase_name: string;
  job_kind: PhaseJobKind;
  input?: Record<string, unknown>;
  priority?: "low" | "normal" | "high";
  max_attempts?: number;
  /** Optional discriminator for multi-job phases (e.g. per plan_id). */
  idempotency_suffix?: string;
}

export interface EnqueuePhaseJobResult {
  ok: boolean;
  inserted: boolean;
  job_id?: string;
  idempotency_key: string;
  reason?: string;
}

/**
 * P29B.3-H8.3: Required job kinds MUST NOT use idempotency_suffix.
 * Allowing a suffix on a required kind would create duplicate rows for the
 * same job_kind in a cycle (idempotency keys differ but the canonical
 * required-job loop also inserts one row), violating the job-graph invariant.
 */
const REQUIRED_KIND_SET = new Set<string>(P29B3_REQUIRED_PHASE_JOB_KINDS as readonly string[]);

export async function enqueuePhaseJob(
  admin: any,
  i: EnqueuePhaseJobInput,
): Promise<EnqueuePhaseJobResult> {
  const rawSuffix = typeof i.idempotency_suffix === "string" ? i.idempotency_suffix.trim() : "";
  if (rawSuffix && REQUIRED_KIND_SET.has(i.job_kind)) {
    return {
      ok: false,
      inserted: false,
      idempotency_key: `${i.cycle_id}:${i.job_kind}`,
      reason: "idempotency_suffix_for_required_job_forbidden",
    };
  }
  const idempotency_key = rawSuffix
    ? `${i.cycle_id}:${i.job_kind}:${rawSuffix}`
    : `${i.cycle_id}:${i.job_kind}`;
  try {
    const { data, error } = await admin
      .from("did_daily_cycle_phase_jobs")
      .insert({
        cycle_id: i.cycle_id,
        user_id: i.user_id,
        phase_name: i.phase_name,
        job_kind: i.job_kind,
        idempotency_key,
        priority: i.priority ?? "normal",
        max_attempts: i.max_attempts ?? 3,
        input: i.input ?? {},
        status: "queued",
        next_retry_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error) {
      // Unique violation = job already queued for this cycle+kind. That's fine.
      const msg = String(error.message || "");
      if (/duplicate key|unique constraint/i.test(msg)) {
        return { ok: true, inserted: false, idempotency_key, reason: "already_queued" };
      }
      return { ok: false, inserted: false, idempotency_key, reason: msg };
    }
    return { ok: true, inserted: true, job_id: data?.id, idempotency_key };
  } catch (e: any) {
    return { ok: false, inserted: false, idempotency_key, reason: e?.message ?? String(e) };
  }
}

/**
 * Quick summary used by completion semantics in the main orchestrator.
 */
export async function summarizePhaseJobsForCycle(admin: any, cycle_id: string) {
  const { data } = await admin
    .from("did_daily_cycle_phase_jobs")
    .select("job_kind,status,attempt_count,error_message")
    .eq("cycle_id", cycle_id);
  const rows = (data ?? []) as Array<{ job_kind: string; status: string; attempt_count: number; error_message: string | null }>;
  const summary = {
    total: rows.length,
    queued: rows.filter(r => r.status === "queued").length,
    running: rows.filter(r => r.status === "running").length,
    completed: rows.filter(r => r.status === "completed").length,
    failed_retry: rows.filter(r => r.status === "failed_retry").length,
    failed_permanent: rows.filter(r => r.status === "failed_permanent").length,
    controlled_skipped: rows.filter(r => r.status === "controlled_skipped").length,
    by_kind: rows.reduce<Record<string, string>>((acc, r) => {
      acc[r.job_kind] = r.status;
      return acc;
    }, {}),
  };
  return summary;
}
