/**
 * P29B.3-S0: orchestrator helper that enqueues all required phase jobs
 * immediately after `update_cards_enqueued` in the main daily-cycle.
 *
 * This MUST be called as early as possible after Phase 4 enqueue. It is
 * idempotent (every enqueuePhaseJob call uses cycle_id+job_kind as the
 * idempotency key).
 */
import {
  enqueuePhaseJob,
  P29B3_REQUIRED_PHASE_JOB_KINDS,
  type PhaseJobKind,
} from "./dailyCyclePhaseJobs.ts";

export interface EarlyEnqueueInput {
  sb: any;
  cycleId: string;
  userId: string;
  /** Optional payload ref for phase4_centrum_tail (created by main cycle). */
  centrumTailPayloadRef?: { payload_id: string; payload_hash: string } | null;
  /** Optional pending drive write count for phase9 dispatch metadata. */
  pendingDriveWritesCount?: number;
  source: string;
}

export interface EarlyEnqueueResult {
  enqueued: PhaseJobKind[];
  skipped: Array<{ kind: PhaseJobKind; reason: string }>;
  errors: Array<{ kind: PhaseJobKind; reason: string }>;
}

export async function enqueueRequiredPostPhase4Jobs(
  i: EarlyEnqueueInput,
): Promise<EarlyEnqueueResult> {
  const out: EarlyEnqueueResult = { enqueued: [], skipped: [], errors: [] };
  for (const kind of P29B3_REQUIRED_PHASE_JOB_KINDS) {
    const input: Record<string, unknown> = { source: i.source };
    if (kind === "phase4_centrum_tail") {
      if (!i.centrumTailPayloadRef) {
        // payload missing → leave to runtime tail logic to enqueue with payload
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
      if (enq.ok) out.enqueued.push(kind);
      else out.errors.push({ kind, reason: enq.reason ?? "enqueue_failed" });
    } catch (e: any) {
      out.errors.push({ kind, reason: e?.message ?? String(e) });
    }
  }
  return out;
}

/** Default-ON kill switch for inline phase 5–7.x blocks. */
export function isInlinePhase5To7Disabled(): boolean {
  const v = Deno.env.get("P29B_DISABLE_INLINE_PHASE_5_7") ?? "true";
  return v.toLowerCase() !== "false";
}
