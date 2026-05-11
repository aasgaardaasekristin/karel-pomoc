/**
 * P29B.3-S0/H8: orchestrator helper that enqueues all required phase jobs
 * immediately after `update_cards_enqueued` in the main daily-cycle.
 *
 * P33.5F: result type extended with `attempted`, `missing_after_enqueue`,
 * `already_existing`, `duplicate_existing`. Helper now verifies DB state
 * after the insert loop so the main daily-cycle can fail fast when any of
 * the 14 required jobs are missing.
 *
 * Idempotent: every enqueuePhaseJob call uses cycle_id+job_kind as the
 * idempotency key. Iterates strictly over P29B3_REQUIRED_PHASE_JOB_KINDS so
 * coverage is loop-driven, not literal-string driven.
 */
import {
  enqueuePhaseJob,
  P29B3_REQUIRED_PHASE_JOB_KINDS,
  type PhaseJobKind,
} from "./dailyCyclePhaseJobs.ts";

export interface CentrumTailPayloadRef {
  payload_id: string;
  payload_hash: string;
  /** P29B.3-H8: optional discriminators for explicit ref shape. */
  payload_table?: string;
  job_kind?: PhaseJobKind;
}

export interface EarlyEnqueueInput {
  sb: any;
  cycleId: string;
  userId: string;
  /** Optional payload ref for phase4_centrum_tail. */
  centrumTailPayloadRef?: CentrumTailPayloadRef | null;
  /** Optional pending drive write count for phase9 dispatch metadata. */
  pendingDriveWritesCount?: number;
  source: string;
}

export interface EarlyEnqueueResult {
  enqueued: PhaseJobKind[];
  skipped: Array<{ kind: PhaseJobKind; reason: string }>;
  errors: Array<{ kind: PhaseJobKind; reason: string }>;
  /** P33.5F: every required kind we attempted to enqueue. Length must be 14. */
  attempted: PhaseJobKind[];
  /** P33.5F: required kinds that have NO row in did_daily_cycle_phase_jobs
   *  for this cycle after the loop completes. Must be empty (or only
   *  phase4_centrum_tail when no payload ref was supplied). */
  missing_after_enqueue: PhaseJobKind[];
  /** P33.5F: required kinds that already had a row before our insert. */
  already_existing: PhaseJobKind[];
  /** P33.5F: required kinds with more than one row in this cycle (should be 0). */
  duplicate_existing: PhaseJobKind[];
  /** P33.5F: did we run the post-insert DB verification successfully. */
  verified: boolean;
}

export async function enqueueRequiredPostPhase4Jobs(
  i: EarlyEnqueueInput,
): Promise<EarlyEnqueueResult> {
  const attempted: PhaseJobKind[] = [];
  const out: EarlyEnqueueResult = {
    enqueued: [],
    skipped: [],
    errors: [],
    attempted,
    missing_after_enqueue: [],
    already_existing: [],
    duplicate_existing: [],
    verified: false,
  };
  for (const kind of P29B3_REQUIRED_PHASE_JOB_KINDS) {
    attempted.push(kind);
    const input: Record<string, unknown> = {
      source: i.source,
      p29b3_required_job: true,
    };
    if (kind === "phase4_centrum_tail") {
      if (!i.centrumTailPayloadRef) {
        // Only this job legitimately requires a payload ref. All other
        // required jobs MUST be enqueued unconditionally.
        out.skipped.push({ kind, reason: "missing_centrum_payload_ref" });
        continue;
      }
      input.payload_ref = i.centrumTailPayloadRef;
    }
    if (kind === "phase9_drive_queue_flush" && typeof i.pendingDriveWritesCount === "number") {
      input.pending_writes_count = i.pendingDriveWritesCount;
    }
    try {
      const enq = await enqueuePhaseJob(i.sb, {
        cycle_id: i.cycleId,
        user_id: i.userId,
        phase_name: kind,
        job_kind: kind,
        input,
        priority: kind === "phase9_drive_queue_flush" ? "high" : "normal",
      });
      if (enq.ok) {
        out.enqueued.push(kind);
        if (!enq.inserted) out.already_existing.push(kind);
      } else {
        out.errors.push({ kind, reason: enq.reason ?? "enqueue_failed" });
      }
    } catch (e: any) {
      out.errors.push({ kind, reason: e?.message ?? String(e) });
    }
  }

  // P33.5F: verify DB state cycle-scoped. Required kinds must exist with
  // exactly one row each (or zero only for phase4_centrum_tail when payload
  // ref was missing).
  try {
    const { data, error } = await i.sb
      .from("did_daily_cycle_phase_jobs")
      .select("job_kind")
      .eq("cycle_id", i.cycleId)
      .in("job_kind", P29B3_REQUIRED_PHASE_JOB_KINDS as readonly string[]);
    if (error) {
      console.warn("[P33.5F] post-enqueue verify query failed:", error.message);
    } else {
      const counts: Record<string, number> = {};
      for (const r of (data ?? []) as Array<{ job_kind: string }>) {
        counts[r.job_kind] = (counts[r.job_kind] ?? 0) + 1;
      }
      out.duplicate_existing = (P29B3_REQUIRED_PHASE_JOB_KINDS as readonly PhaseJobKind[])
        .filter((k) => (counts[k] ?? 0) > 1);
      // A kind is "missing" if no row exists AND we didn't legitimately skip it.
      const skippedKinds = new Set(out.skipped.map((s) => s.kind));
      out.missing_after_enqueue = (P29B3_REQUIRED_PHASE_JOB_KINDS as readonly PhaseJobKind[])
        .filter((k) => !(counts[k] > 0) && !skippedKinds.has(k));
      out.verified = true;
    }
  } catch (verifyErr: any) {
    console.warn("[P33.5F] post-enqueue verify exception:", verifyErr?.message ?? verifyErr);
  }

  return out;
}

/** Default-ON kill switch for inline phase 5–7.x blocks. */
// deno-lint-ignore no-explicit-any
declare const Deno: any;
export function isInlinePhase5To7Disabled(): boolean {
  const v = (typeof Deno !== "undefined" ? Deno.env.get("P29B_DISABLE_INLINE_PHASE_5_7") : undefined) ?? "true";
  return String(v).toLowerCase() !== "false";
}

/**
 * P33.5F: optional diagnostic helper for repairing a known-broken cycle.
 * Inserts ONLY missing required jobs cycle-scoped, marking them with
 * `input.p33_5f_repair = true`. Acceptance must always be proven on a
 * fresh forced cycle, never on a repaired cycle.
 */
export async function repairMissingRequiredPhaseJobsForCycle(
  i: EarlyEnqueueInput & { reason?: string },
): Promise<EarlyEnqueueResult> {
  const result = await enqueueRequiredPostPhase4Jobs({
    ...i,
    source: `p33_5f_repair:${i.source}`,
  });
  // Tag inserted rows for diagnostic provenance — best effort only.
  try {
    await i.sb
      .from("did_daily_cycle_phase_jobs")
      .update({ input: { p33_5f_repair: true, repair_reason: i.reason ?? "manual" } as any })
      .eq("cycle_id", i.cycleId)
      .in("job_kind", result.enqueued as string[])
      .is("started_at", null)
      .eq("status", "queued");
  } catch (_) { /* non-fatal */ }
  return result;
}
