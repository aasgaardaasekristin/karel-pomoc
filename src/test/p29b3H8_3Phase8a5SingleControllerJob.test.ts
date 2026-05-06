/**
 * P29B.3-H8.3: phase8a5_session_eval_safety_net is a single REQUIRED
 * controller job per cycle. Legacy per-plan enqueue with the same
 * job_kind + idempotency_suffix is forbidden.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  enqueuePhaseJob,
  P29B3_REQUIRED_PHASE_JOB_KINDS,
} from "../../supabase/functions/_shared/dailyCyclePhaseJobs.ts";

const root = resolve(__dirname, "../../");
const mainCycleSrc = readFileSync(resolve(root, "supabase/functions/karel-did-daily-cycle/index.ts"), "utf-8");
const workerSrc = readFileSync(resolve(root, "supabase/functions/karel-did-daily-cycle-phase-worker/index.ts"), "utf-8");

function makeMockSb(inserted: any[]) {
  return {
    from() {
      return {
        insert(row: any) {
          inserted.push(row);
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
      };
    },
  };
}

describe("P29B.3-H8.3 phase8a5 single controller job", () => {
  it("phase8a5 is in required list", () => {
    expect(P29B3_REQUIRED_PHASE_JOB_KINDS).toContain("phase8a5_session_eval_safety_net");
  });

  it("enqueuePhaseJob REJECTS idempotency_suffix for required job kinds", async () => {
    const inserted: any[] = [];
    const sb = makeMockSb(inserted);
    const r = await enqueuePhaseJob(sb, {
      cycle_id: "c1",
      user_id: "u1",
      phase_name: "phase_8a5_session_eval_safety_net",
      job_kind: "phase8a5_session_eval_safety_net",
      idempotency_suffix: "plan-xyz",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("idempotency_suffix_for_required_job_forbidden");
    expect(inserted.length).toBe(0);
  });

  it("enqueuePhaseJob ALLOWS suffix on non-required kinds and produces clean key", async () => {
    const inserted: any[] = [];
    const sb = makeMockSb(inserted);
    const r = await enqueuePhaseJob(sb, {
      cycle_id: "c1",
      user_id: "u1",
      phase_name: "child",
      job_kind: "phase8a5_session_eval_safety_net_plan" as any,
      idempotency_suffix: "plan-xyz",
    });
    expect(r.ok).toBe(true);
    expect(r.idempotency_key).toBe("c1:phase8a5_session_eval_safety_net_plan:plan-xyz");
  });

  it("no trailing colon when suffix is empty/whitespace", async () => {
    const inserted: any[] = [];
    const sb = makeMockSb(inserted);
    const r = await enqueuePhaseJob(sb, {
      cycle_id: "c1",
      user_id: "u1",
      phase_name: "phase8_therapist_intel",
      job_kind: "phase8_therapist_intel",
      idempotency_suffix: "   ",
    });
    expect(r.ok).toBe(true);
    expect(r.idempotency_key).toBe("c1:phase8_therapist_intel");
    expect(r.idempotency_key.endsWith(":")).toBe(false);
  });

  it("main daily-cycle does NOT enqueue per-plan phase8a5 with idempotency_suffix", () => {
    // The legacy block enqueued: job_kind: "phase8a5_session_eval_safety_net" with idempotency_suffix.
    // After H8.3 it must be removed.
    const block = mainCycleSrc;
    // Simple structural check: there must be no enqueuePhaseJob(...) call that mentions
    // both phase8a5_session_eval_safety_net AND idempotency_suffix in the same callsite.
    const re = /enqueuePhaseJob\([\s\S]{0,800}?phase8a5_session_eval_safety_net[\s\S]{0,400}?idempotency_suffix/;
    expect(re.test(block)).toBe(false);
  });

  it("worker has phase8a5 controller mode (no plan_id) with bounded plan scan", () => {
    expect(workerSrc).toContain('job.job_kind === "phase8a5_session_eval_safety_net"');
    expect(workerSrc).toContain('mode: "controller"');
    expect(workerSrc).toContain("MAX_PLANS = 5");
    expect(workerSrc).toContain("no_stale_session_eval_plans");
  });

  it("worker still supports legacy single-plan path via dispatchTarget", () => {
    expect(workerSrc).toContain("controller_mode_handled_in_process");
  });
});
