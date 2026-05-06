import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../");
const phaseJobsSrc = readFileSync(
  resolve(root, "supabase/functions/_shared/dailyCyclePhaseJobs.ts"),
  "utf-8",
);
const workerSrc = readFileSync(
  resolve(root, "supabase/functions/karel-did-daily-cycle-phase-worker/index.ts"),
  "utf-8",
);
const mainSrc = readFileSync(
  resolve(root, "supabase/functions/karel-did-daily-cycle/index.ts"),
  "utf-8",
);

describe("P29B.3-H1 phase7_operative_plan helper", () => {
  it("phase7_operative_plan is REMOVED from unimplemented helper list", () => {
    const m = phaseJobsSrc.match(
      /P29B3_S0_UNIMPLEMENTED_HELPER_KINDS[\s\S]*?\]\s*as const/,
    );
    expect(m).toBeTruthy();
    expect(m![0]).not.toMatch(/"phase7_operative_plan"/);
  });

  it("phase7_operative_plan is still in REQUIRED jobs list", () => {
    const m = phaseJobsSrc.match(
      /P29B3_REQUIRED_PHASE_JOB_KINDS[\s\S]*?\]\s*as const/,
    );
    expect(m).toBeTruthy();
    expect(m![0]).toMatch(/"phase7_operative_plan"/);
  });

  it("phase worker dispatches phase7_operative_plan to update-operative-plan", () => {
    expect(workerSrc).toMatch(
      /case\s+"phase7_operative_plan"[\s\S]{0,200}fn:\s*"update-operative-plan"/,
    );
  });

  it("phase worker dispatch sets a finite timeout for phase7", () => {
    const m = workerSrc.match(
      /case\s+"phase7_operative_plan"[\s\S]{0,300}timeoutMs:\s*(\d+)/,
    );
    expect(m).toBeTruthy();
    const ms = Number(m![1]);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(180_000);
  });

  it("worker keeps heartbeat + retry/exhaustion path (try/catch, no .catch on builder)", () => {
    expect(workerSrc).toContain("withHeartbeat");
    expect(workerSrc).toContain("failed_retry");
    expect(workerSrc).toContain("failed_permanent");
    expect(workerSrc).toMatch(
      /try\s*\{\s*await admin\.rpc\("did_phase_jobs_sweep_stale"\)/,
    );
  });

  it("main daily-cycle keeps phase7 inline guarded behind kill switch", () => {
    expect(mainSrc).toContain("isInlinePhase5To7Disabled");
    // The inline phase 7 setPhase marker must live AFTER the
    // 'p29b3_inline_phase_65_to_76a_disabled' guard marker (i.e. inside the
    // legacy else-branch).
    const guardIdx = mainSrc.indexOf("p29b3_inline_phase_65_to_76a_disabled");
    const phase7Idx = mainSrc.indexOf('"phase_7_operative_plan"');
    expect(guardIdx).toBeGreaterThan(0);
    expect(phase7Idx).toBeGreaterThan(guardIdx);
  });

  it("P29B is still NOT marked accepted (p29b_accepted:false remains)", () => {
    expect(mainSrc).toContain("p29b_accepted: false");
    expect(mainSrc).toContain("helper_coverage_partial: true");
  });
});
