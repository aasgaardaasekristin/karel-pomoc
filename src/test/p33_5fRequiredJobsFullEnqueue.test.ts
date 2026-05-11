/**
 * P33.5F — required jobs full enqueue contract.
 *
 * Behavior + source guards proving the main daily-cycle always enqueues
 * exactly the 14 P29B3_REQUIRED_PHASE_JOB_KINDS per cycle, fails fast when
 * required kinds are missing, persists the structured phase_enqueue audit
 * to context_data, and never marks the cycle completed with a partial
 * required-job graph.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  enqueueRequiredPostPhase4Jobs,
  type EarlyEnqueueResult,
} from "../../supabase/functions/_shared/dailyCycleEarlyEnqueue.ts";
import { P29B3_REQUIRED_PHASE_JOB_KINDS } from "../../supabase/functions/_shared/dailyCyclePhaseJobs.ts";

const root = resolve(__dirname, "../../");
const dailyCycleSrc = readFileSync(
  resolve(root, "supabase/functions/karel-did-daily-cycle/index.ts"),
  "utf-8",
);
const earlyEnqueueSrc = readFileSync(
  resolve(root, "supabase/functions/_shared/dailyCycleEarlyEnqueue.ts"),
  "utf-8",
);

type Inserted = Record<string, any>;

function makeMockSb(opts: { existingForCycle?: string[]; failKind?: string } = {}) {
  const inserted: Inserted[] = [];
  const existing = new Set<string>(opts.existingForCycle ?? []);
  const sb: any = {
    from(table: string) {
      const builder: any = {
        _filters: {} as Record<string, any>,
        _table: table,
        select(_cols?: string, _opts?: any) { return builder; },
        insert(row: Inserted) {
          if (opts.failKind && row.job_kind === opts.failKind) {
            return {
              select() {
                return {
                  async single() {
                    return { data: null, error: { message: "boom" } };
                  },
                };
              },
            };
          }
          inserted.push(row);
          existing.add(row.job_kind);
          return {
            select() {
              return {
                async single() {
                  return { data: { id: `id-${inserted.length}` }, error: null };
                },
              };
            },
          };
        },
        eq() { return builder; },
        in(_col: string, kinds: string[]) {
          builder._inKinds = kinds;
          return Promise.resolve({
            data: kinds.filter((k) => existing.has(k)).map((k) => ({ job_kind: k })),
            error: null,
          });
        },
      };
      return builder;
    },
    _inserted: inserted,
  };
  return sb;
}

describe("P33.5F required jobs full enqueue", () => {
  const cycleId = "p33_5f-cycle-full";
  const userId = "00000000-0000-0000-0000-000000000001";

  it("required list has exactly 14 distinct kinds", () => {
    expect(P29B3_REQUIRED_PHASE_JOB_KINDS.length).toBe(14);
    expect(new Set(P29B3_REQUIRED_PHASE_JOB_KINDS).size).toBe(14);
  });

  it("attempts every required kind", async () => {
    const sb = makeMockSb();
    const res = await enqueueRequiredPostPhase4Jobs({
      sb, cycleId, userId,
      centrumTailPayloadRef: { payload_id: "p", payload_hash: "h" },
      source: "test",
    });
    expect(res.attempted.length).toBe(14);
    expect([...res.attempted].sort()).toEqual([...P29B3_REQUIRED_PHASE_JOB_KINDS].sort());
  });

  it("P33.5G: phase4_centrum_tail no longer silently skips on missing ref — becomes an error", async () => {
    const sb = makeMockSb();
    const res = await enqueueRequiredPostPhase4Jobs({
      sb, cycleId, userId,
      centrumTailPayloadRef: null,
      source: "test_no_payload",
    });
    expect(res.skipped).toEqual([]);
    expect(res.errors.map((e) => e.kind)).toEqual(["phase4_centrum_tail"]);
    expect(res.enqueued.length).toBe(13);
  });

  it("verifies DB state after insert (verified=true) and reports already_existing/duplicates", async () => {
    const sb = makeMockSb();
    const res = await enqueueRequiredPostPhase4Jobs({
      sb, cycleId, userId,
      centrumTailPayloadRef: { payload_id: "p", payload_hash: "h" },
      source: "test_verify",
    });
    expect(res.verified).toBe(true);
    expect(res.duplicate_existing).toEqual([]);
    expect(res.missing_after_enqueue).toEqual([]);
  });

  it("missing_after_enqueue reports any required kind that has no row (excluding legitimate centrum skip)", async () => {
    // Force an enqueue failure on phase8_therapist_intel — DB verification
    // must surface it as missing_after_enqueue.
    const sb = makeMockSb({ failKind: "phase8_therapist_intel" });
    const res = await enqueueRequiredPostPhase4Jobs({
      sb, cycleId, userId,
      centrumTailPayloadRef: { payload_id: "p", payload_hash: "h" },
      source: "test_missing",
    });
    expect(res.errors.map((e) => e.kind)).toContain("phase8_therapist_intel");
    expect(res.missing_after_enqueue).toContain("phase8_therapist_intel");
    expect(res.missing_after_enqueue).not.toContain("phase4_centrum_tail");
  });

  it("idempotency key is strictly cycle-scoped: ${cycleId}:${job_kind}", async () => {
    const sb = makeMockSb();
    await enqueueRequiredPostPhase4Jobs({
      sb, cycleId, userId,
      centrumTailPayloadRef: { payload_id: "p", payload_hash: "h" },
      source: "test_idem",
    });
    const inserts = (sb as any)._inserted as Inserted[];
    expect(inserts.length).toBe(14);
    const keys = inserts.map((r) => r.idempotency_key);
    expect(new Set(keys).size).toBe(14);
    for (const r of inserts) {
      expect(r.idempotency_key).toBe(`${cycleId}:${r.job_kind}`);
      expect(r.cycle_id).toBe(cycleId);
      expect(r.input?.p29b3_required_job).toBe(true);
    }
  });

  it("source: main daily-cycle has the P33.5F recovery branch outside `if (validatedAnalysisText)`", () => {
    expect(dailyCycleSrc).toContain("P33.5F — RECOVERY PATH for empty validatedAnalysisText");
    expect(dailyCycleSrc).toContain("if (!validatedAnalysisText)");
    expect(dailyCycleSrc).toContain("main_daily_cycle_p33_5f_recovery");
    // Recovery branch must call the canonical helper.
    const recoveryStart = dailyCycleSrc.indexOf("P33.5F — RECOVERY PATH");
    const recoveryWindow = dailyCycleSrc.slice(recoveryStart, recoveryStart + 6000);
    expect(recoveryWindow).toContain("enqueueRequiredPostPhase4Jobs");
    expect(recoveryWindow).toContain("completeMainOrchestratorAfterPhaseJobDetach");
  });

  it("source: main daily-cycle persists phase_enqueue into context_data in both branches", () => {
    const occurrences = dailyCycleSrc.split("phase_enqueue:").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("source: main daily-cycle fail-fast on missing required jobs in inside branch", () => {
    expect(dailyCycleSrc).toMatch(/P33\.5[FG]: FAIL-FAST guard/);
    expect(dailyCycleSrc).toContain("p29b3_required_jobs_enqueue_failed");
    expect(dailyCycleSrc).toContain("missing_required_jobs");
  });

  it("source: shared helper exposes attempted/missing_after_enqueue/already_existing/duplicate_existing/verified", () => {
    expect(earlyEnqueueSrc).toContain("attempted: PhaseJobKind[]");
    expect(earlyEnqueueSrc).toContain("missing_after_enqueue: PhaseJobKind[]");
    expect(earlyEnqueueSrc).toContain("already_existing: PhaseJobKind[]");
    expect(earlyEnqueueSrc).toContain("duplicate_existing: PhaseJobKind[]");
    expect(earlyEnqueueSrc).toContain("verified: boolean");
  });

  it("source: no hardcoded 4-job subset literal exists outside the legacy inline phase enqueues", () => {
    // The four legacy-inline kinds must NOT appear in the same array literal
    // anywhere as a single subset masquerading as the required list.
    const partialSubsetRegex = /\[\s*"phase6_card_autoupdate"\s*,\s*"phase8_therapist_intel"\s*,\s*"phase8b_pantry_flush"\s*,\s*"phase9_drive_queue_flush"\s*\]/;
    expect(partialSubsetRegex.test(dailyCycleSrc)).toBe(false);
  });

  it("required job count stays 14 (regression guard)", () => {
    expect(P29B3_REQUIRED_PHASE_JOB_KINDS.length).toBe(14);
  });

  it("EarlyEnqueueResult typing includes the new fields", () => {
    const sample: EarlyEnqueueResult = {
      enqueued: [], skipped: [], errors: [],
      attempted: [], missing_after_enqueue: [],
      already_existing: [], duplicate_existing: [],
      verified: false,
    };
    expect(sample.attempted).toEqual([]);
  });
});
