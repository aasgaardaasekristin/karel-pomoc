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
  | "phase6_card_autoupdate"
  | "phase8_therapist_intel"
  | "phase8a5_session_eval_safety_net"
  | "phase8b_pantry_flush"
  | "phase9_drive_queue_flush";

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

export async function enqueuePhaseJob(
  admin: any,
  i: EnqueuePhaseJobInput,
): Promise<EnqueuePhaseJobResult> {
  const idempotency_key = `${i.cycle_id}:${i.job_kind}${i.idempotency_suffix ? `:${i.idempotency_suffix}` : ""}`;
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
