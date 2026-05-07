/**
 * P29C.1 — Daily Briefing Truth Gate.
 *
 * The morning Karel briefing must NEVER claim to be "today's ready briefing"
 * unless it is tied to a fully completed P29B daily-cycle whose 14 required
 * phase jobs have all reached terminal states with no failures, no duplicates,
 * and no still-running / still-queued required jobs.
 *
 * This module is fail-closed: anything ambiguous returns ok=false with a
 * precise status code. The single source of truth for "required jobs" is
 * `P29B3_REQUIRED_PHASE_JOB_KINDS` from `dailyCyclePhaseJobs.ts` — never
 * duplicate the list here.
 */

import {
  P29B3_REQUIRED_PHASE_JOB_KINDS,
  type PhaseJobKind,
} from "./dailyCyclePhaseJobs.ts";

export type DailyBriefingTruthGateStatus =
  | "ready"
  | "no_completed_daily_cycle"
  | "cycle_still_running"
  | "required_jobs_missing"
  | "required_jobs_not_terminal"
  | "required_job_failed"
  | "duplicate_required_jobs"
  | "cycle_too_old"
  | "briefing_generated_before_cycle_completion";

export interface DailyBriefingTruthGateResult {
  ok: boolean;
  status: DailyBriefingTruthGateStatus;
  source_cycle_id: string | null;
  cycle_started_at: string | null;
  cycle_completed_at: string | null;
  required_jobs_count: number;
  distinct_required_jobs_count: number;
  missing_required_jobs: string[];
  duplicate_required_jobs: string[];
  queued_jobs: number;
  running_jobs: number;
  failed_retry_jobs: number;
  failed_permanent_jobs: number;
  controlled_skipped_jobs: number;
  completed_jobs: number;
  job_graph_snapshot: Array<{
    job_kind: string;
    status: string;
    has_result: boolean;
    error_message: string | null;
  }>;
  explanation: string;
  checked_at: string;
}

export interface EvaluateDailyBriefingTruthGateInput {
  userId: string;
  /** Prague-local date YYYY-MM-DD this briefing claims to represent. */
  briefingDatePrague: string;
  /** Optional briefing generated_at (ISO) — if provided, must be >= cycle_completed_at. */
  briefingGeneratedAt?: string | null;
  now?: Date;
}

const DAY_MS = 86_400_000;

function emptySnapshot(): DailyBriefingTruthGateResult["job_graph_snapshot"] {
  return [];
}

function baseFail(
  status: DailyBriefingTruthGateStatus,
  explanation: string,
  partial: Partial<DailyBriefingTruthGateResult> = {},
): DailyBriefingTruthGateResult {
  return {
    ok: false,
    status,
    source_cycle_id: null,
    cycle_started_at: null,
    cycle_completed_at: null,
    required_jobs_count: 0,
    distinct_required_jobs_count: 0,
    missing_required_jobs: [],
    duplicate_required_jobs: [],
    queued_jobs: 0,
    running_jobs: 0,
    failed_retry_jobs: 0,
    failed_permanent_jobs: 0,
    controlled_skipped_jobs: 0,
    completed_jobs: 0,
    job_graph_snapshot: emptySnapshot(),
    explanation,
    checked_at: new Date().toISOString(),
    ...partial,
  };
}

/**
 * Evaluate the truth gate against the latest canonical daily-cycle for
 * `briefingDatePrague` and `userId`. This is read-only.
 */
export async function evaluateDailyBriefingTruthGate(
  sb: any,
  input: EvaluateDailyBriefingTruthGateInput,
): Promise<DailyBriefingTruthGateResult> {
  const { userId, briefingDatePrague } = input;
  const now = input.now ?? new Date();

  // Window: full Prague day in UTC. Use a generous +/-1 day window because
  // Prague midnight straddles UTC.
  const startUtc = new Date(`${briefingDatePrague}T00:00:00Z`);
  startUtc.setTime(startUtc.getTime() - DAY_MS / 2);
  const endUtc = new Date(`${briefingDatePrague}T23:59:59Z`);
  endUtc.setTime(endUtc.getTime() + DAY_MS / 2);

  // 1) Latest daily cycle for this user/day.
  const { data: cycleRow, error: cycleErr } = await sb
    .from("did_update_cycles")
    .select("id, status, started_at, completed_at, context_data")
    .eq("cycle_type", "daily")
    .eq("user_id", userId)
    .gte("started_at", startUtc.toISOString())
    .lte("started_at", endUtc.toISOString())
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cycleErr) {
    return baseFail(
      "no_completed_daily_cycle",
      `cycle_lookup_error:${cycleErr.message ?? cycleErr}`,
    );
  }
  if (!cycleRow) {
    return baseFail(
      "no_completed_daily_cycle",
      `no daily cycle found for ${briefingDatePrague}`,
    );
  }

  const cycleId = String(cycleRow.id);
  const status = String(cycleRow.status ?? "");
  const startedAt = cycleRow.started_at ?? null;
  const completedAt = cycleRow.completed_at ?? null;

  if (status === "running") {
    return baseFail("cycle_still_running", `cycle ${cycleId} still running`, {
      source_cycle_id: cycleId,
      cycle_started_at: startedAt,
      cycle_completed_at: completedAt,
    });
  }
  const allowedCompleted = new Set(["completed", "completed_with_warnings"]);
  if (!allowedCompleted.has(status)) {
    return baseFail(
      "no_completed_daily_cycle",
      `cycle ${cycleId} status='${status}' is not completed`,
      {
        source_cycle_id: cycleId,
        cycle_started_at: startedAt,
        cycle_completed_at: completedAt,
      },
    );
  }
  // Orchestrator completion semantics must be true (P29B contract).
  const semantics =
    cycleRow.context_data?.daily_cycle_completion_semantics ?? null;
  if (semantics?.main_orchestrator_completed !== true) {
    return baseFail(
      "no_completed_daily_cycle",
      `cycle ${cycleId} missing main_orchestrator_completed=true`,
      {
        source_cycle_id: cycleId,
        cycle_started_at: startedAt,
        cycle_completed_at: completedAt,
      },
    );
  }

  // Optional age guard: cycle started > 36h ago is too old for this briefing.
  if (startedAt) {
    const ageH =
      (now.getTime() - new Date(startedAt).getTime()) / (3600 * 1000);
    if (ageH > 36) {
      return baseFail(
        "cycle_too_old",
        `cycle ${cycleId} started ${ageH.toFixed(1)}h ago`,
        {
          source_cycle_id: cycleId,
          cycle_started_at: startedAt,
          cycle_completed_at: completedAt,
        },
      );
    }
  }

  // 2) Phase jobs for the cycle.
  const { data: jobRows, error: jobsErr } = await sb
    .from("did_daily_cycle_phase_jobs")
    .select("job_kind, status, result, error_message")
    .eq("cycle_id", cycleId);

  if (jobsErr) {
    return baseFail(
      "required_jobs_missing",
      `phase_jobs_lookup_error:${jobsErr.message ?? jobsErr}`,
      {
        source_cycle_id: cycleId,
        cycle_started_at: startedAt,
        cycle_completed_at: completedAt,
      },
    );
  }

  const rows = (jobRows ?? []) as Array<{
    job_kind: string;
    status: string;
    result: any;
    error_message: string | null;
  }>;

  // Restrict to required kinds for the gate.
  const requiredSet = new Set<string>(P29B3_REQUIRED_PHASE_JOB_KINDS);
  const requiredRows = rows.filter((r) => requiredSet.has(r.job_kind));

  // Duplicates: same required job_kind appearing more than once.
  const counts = new Map<string, number>();
  for (const r of requiredRows) {
    counts.set(r.job_kind, (counts.get(r.job_kind) ?? 0) + 1);
  }
  const duplicates: string[] = [];
  for (const [k, n] of counts.entries()) if (n > 1) duplicates.push(k);

  const distinctKinds = new Set(requiredRows.map((r) => r.job_kind));
  const missing = (P29B3_REQUIRED_PHASE_JOB_KINDS as readonly string[]).filter(
    (k) => !distinctKinds.has(k),
  );

  const queued = requiredRows.filter((r) => r.status === "queued").length;
  const running = requiredRows.filter((r) => r.status === "running").length;
  const failed_retry = requiredRows.filter(
    (r) => r.status === "failed_retry",
  ).length;
  const failed_permanent = requiredRows.filter(
    (r) => r.status === "failed_permanent",
  ).length;
  const completed = requiredRows.filter((r) => r.status === "completed").length;
  const controlled_skipped = requiredRows.filter(
    (r) => r.status === "controlled_skipped",
  ).length;

  const snapshot = requiredRows
    .slice()
    .sort((a, b) => a.job_kind.localeCompare(b.job_kind))
    .map((r) => ({
      job_kind: r.job_kind,
      status: r.status,
      has_result:
        r.result != null &&
        typeof r.result === "object" &&
        Object.keys(r.result).length > 0,
      error_message: r.error_message ?? null,
    }));

  const baseFields = {
    source_cycle_id: cycleId,
    cycle_started_at: startedAt,
    cycle_completed_at: completedAt,
    required_jobs_count: requiredRows.length,
    distinct_required_jobs_count: distinctKinds.size,
    missing_required_jobs: missing,
    duplicate_required_jobs: duplicates,
    queued_jobs: queued,
    running_jobs: running,
    failed_retry_jobs: failed_retry,
    failed_permanent_jobs: failed_permanent,
    controlled_skipped_jobs: controlled_skipped,
    completed_jobs: completed,
    job_graph_snapshot: snapshot,
  };

  if (duplicates.length > 0) {
    return baseFail(
      "duplicate_required_jobs",
      `duplicate required jobs: ${duplicates.join(",")}`,
      baseFields,
    );
  }
  if (missing.length > 0) {
    return baseFail(
      "required_jobs_missing",
      `missing required jobs: ${missing.join(",")}`,
      baseFields,
    );
  }
  if (queued > 0 || running > 0) {
    return baseFail(
      "required_jobs_not_terminal",
      `non-terminal required jobs: queued=${queued} running=${running}`,
      baseFields,
    );
  }
  if (failed_permanent > 0 || failed_retry > 0) {
    return baseFail(
      "required_job_failed",
      `failed required jobs: failed_permanent=${failed_permanent} failed_retry=${failed_retry}`,
      baseFields,
    );
  }
  if (completed + controlled_skipped !== P29B3_REQUIRED_PHASE_JOB_KINDS.length) {
    return baseFail(
      "required_jobs_not_terminal",
      `terminal coverage incomplete: completed=${completed} controlled_skipped=${controlled_skipped} expected=${P29B3_REQUIRED_PHASE_JOB_KINDS.length}`,
      baseFields,
    );
  }

  // controlled_skipped allowed only if either result has data OR error_message
  // contains a reason. Forbid completely empty controlled_skipped rows.
  for (const r of requiredRows) {
    if (r.status !== "controlled_skipped") continue;
    const resultOk =
      r.result &&
      typeof r.result === "object" &&
      Object.keys(r.result).length > 0;
    const reasonOk = !!r.error_message && r.error_message.length > 0;
    if (!resultOk && !reasonOk) {
      return baseFail(
        "required_job_failed",
        `controlled_skipped without result or reason: ${r.job_kind}`,
        baseFields,
      );
    }
  }

  // Briefing-vs-cycle completion ordering check (when caller provides it).
  if (input.briefingGeneratedAt && completedAt) {
    const genMs = new Date(input.briefingGeneratedAt).getTime();
    const compMs = new Date(completedAt).getTime();
    if (Number.isFinite(genMs) && Number.isFinite(compMs) && genMs < compMs) {
      return baseFail(
        "briefing_generated_before_cycle_completion",
        `briefing generated_at ${input.briefingGeneratedAt} < cycle completed_at ${completedAt}`,
        baseFields,
      );
    }
  }

  return {
    ok: true,
    status: "ready",
    explanation: `cycle ${cycleId} completed; all ${P29B3_REQUIRED_PHASE_JOB_KINDS.length} required jobs terminal`,
    checked_at: new Date().toISOString(),
    ...baseFields,
  };
}

/**
 * Re-export the canonical kind list so callers don't need a second import.
 */
export { P29B3_REQUIRED_PHASE_JOB_KINDS };
export type { PhaseJobKind };
