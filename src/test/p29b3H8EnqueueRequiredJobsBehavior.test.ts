/**
 * P29B.3-H8: behavior test for enqueueRequiredPostPhase4Jobs.
 *
 * This is NOT a grep test. It mocks a Supabase client, invokes the helper,
 * and asserts that EVERY required job kind is inserted with the correct
 * idempotency key shape `${cycleId}:${job_kind}`.
 */
import { describe, it, expect } from "vitest";
import { enqueueRequiredPostPhase4Jobs } from "../../supabase/functions/_shared/dailyCycleEarlyEnqueue.ts";
import { P29B3_REQUIRED_PHASE_JOB_KINDS } from "../../supabase/functions/_shared/dailyCyclePhaseJobs.ts";

type Inserted = Record<string, any>;

function makeMockSb(inserted: Inserted[]) {
  return {
    from(_table: string) {
      return {
        insert(row: Inserted) {
          inserted.push(row);
          return {
            select(_cols: string) {
              return {
                async single() {
                  return { data: { id: `id-${inserted.length}` }, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

describe("P29B.3-H8 enqueueRequiredPostPhase4Jobs behavior", () => {
  const cycleId = "cycle-test-h8";
  const userId = "8a7816ee-aaaa-bbbb-cccc-000000000000";

  it("creates exactly one job per required kind with correct idempotency_key", async () => {
    const inserted: Inserted[] = [];
    const sb = makeMockSb(inserted);
    const res = await enqueueRequiredPostPhase4Jobs({
      sb,
      cycleId,
      userId,
      source: "p29b3_h8_test",
      centrumTailPayloadRef: {
        payload_table: "did_daily_cycle_phase_payloads",
        payload_id: "payload-test",
        payload_hash: "hash",
        job_kind: "phase4_centrum_tail",
      },
      pendingDriveWritesCount: 0,
    });

    // No errors, no skips
    expect(res.errors).toEqual([]);
    expect(res.skipped).toEqual([]);

    // Exactly one insert per required kind
    expect(inserted.length).toBe(P29B3_REQUIRED_PHASE_JOB_KINDS.length);
    expect(res.enqueued.length).toBe(P29B3_REQUIRED_PHASE_JOB_KINDS.length);

    const insertedKinds = inserted.map(r => r.job_kind).sort();
    const requiredKinds = [...P29B3_REQUIRED_PHASE_JOB_KINDS].sort();
    expect(insertedKinds).toEqual(requiredKinds);

    // Idempotency key shape and uniqueness
    const keys = inserted.map(r => r.idempotency_key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of inserted) {
      expect(r.idempotency_key).toBe(`${cycleId}:${r.job_kind}`);
      expect(r.cycle_id).toBe(cycleId);
      expect(r.user_id).toBe(userId);
      expect(r.status).toBe("queued");
      expect(r.input?.p29b3_required_job).toBe(true);
      expect(r.input?.source).toBe("p29b3_h8_test");
    }
  });

  it("skips ONLY phase4_centrum_tail when payload ref is missing; all others enqueued", async () => {
    const inserted: Inserted[] = [];
    const sb = makeMockSb(inserted);
    const res = await enqueueRequiredPostPhase4Jobs({
      sb,
      cycleId,
      userId,
      source: "p29b3_h8_test_no_payload",
    });
    expect(res.skipped.map(s => s.kind)).toEqual(["phase4_centrum_tail"]);
    expect(res.errors).toEqual([]);
    expect(inserted.length).toBe(P29B3_REQUIRED_PHASE_JOB_KINDS.length - 1);
    expect(inserted.find(r => r.job_kind === "phase4_centrum_tail")).toBeUndefined();
  });

  it("phase9_drive_queue_flush priority=high, others=normal", async () => {
    const inserted: Inserted[] = [];
    const sb = makeMockSb(inserted);
    await enqueueRequiredPostPhase4Jobs({
      sb,
      cycleId,
      userId,
      source: "prio_test",
      centrumTailPayloadRef: { payload_id: "p", payload_hash: "h" },
    });
    const flush = inserted.find(r => r.job_kind === "phase9_drive_queue_flush");
    expect(flush?.priority).toBe("high");
    const profiling = inserted.find(r => r.job_kind === "phase4_card_profiling");
    expect(profiling?.priority).toBe("normal");
  });
});
