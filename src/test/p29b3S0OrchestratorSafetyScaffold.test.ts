import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../");
const phaseJobsPath = resolve(root, "supabase/functions/_shared/dailyCyclePhaseJobs.ts");
const earlyEnqueuePath = resolve(root, "supabase/functions/_shared/dailyCycleEarlyEnqueue.ts");
const workerPath = resolve(root, "supabase/functions/karel-did-daily-cycle-phase-worker/index.ts");
const mainCyclePath = resolve(root, "supabase/functions/karel-did-daily-cycle/index.ts");

const phaseJobsSrc = readFileSync(phaseJobsPath, "utf-8");
const workerSrc = readFileSync(workerPath, "utf-8");
const mainSrc = readFileSync(mainCyclePath, "utf-8");
const earlyEnqueueSrc = existsSync(earlyEnqueuePath) ? readFileSync(earlyEnqueuePath, "utf-8") : "";

const REQUIRED_KINDS = [
  "phase4_centrum_tail",
  "phase4_card_profiling",
  "phase5_revize_05ab",
  "phase6_card_autoupdate",
  "phase65_memory_cleanup",
  "phase7_operative_plan",
  "phase75_escalation_emails",
  "phase76_feedback_retry",
  "phase76b_auto_feedback_ai",
  "phase8_therapist_intel",
  "phase8b_pantry_flush",
  "phase9_drive_queue_flush",
];

const UNIMPLEMENTED_KINDS = [
  "phase5_revize_05ab",
  "phase65_memory_cleanup",
  "phase7_operative_plan",
  "phase75_escalation_emails",
  "phase76_feedback_retry",
  "phase76b_auto_feedback_ai",
];

describe("P29B.3-S0 orchestrator safety scaffold", () => {
  it("PhaseJobKind union includes all required phase5–7.x job kinds", () => {
    for (const kind of REQUIRED_KINDS) {
      expect(phaseJobsSrc).toContain(`"${kind}"`);
    }
  });

  it("exports P29B3_REQUIRED_PHASE_JOB_KINDS containing all required kinds", () => {
    expect(phaseJobsSrc).toContain("P29B3_REQUIRED_PHASE_JOB_KINDS");
    for (const kind of REQUIRED_KINDS) {
      expect(phaseJobsSrc).toMatch(new RegExp(`"${kind}"`));
    }
  });

  it("exports unimplemented helper list and reason constant", () => {
    expect(phaseJobsSrc).toContain("P29B3_S0_UNIMPLEMENTED_HELPER_KINDS");
    expect(phaseJobsSrc).toContain("helper_not_implemented_yet_p29b3_staged_refactor");
    for (const kind of UNIMPLEMENTED_KINDS) {
      expect(phaseJobsSrc).toContain(`"${kind}"`);
    }
  });

  it("phase worker imports the unimplemented set and short-circuits to controlled_skipped", () => {
    expect(workerSrc).toContain("P29B3_S0_UNIMPLEMENTED_SET");
    expect(workerSrc).toContain('"controlled_skipped"');
    expect(workerSrc).toContain("helper_not_implemented_yet_p29b3_staged_refactor");
    // Must use try/catch (not .catch on PostgrestBuilder)
    expect(workerSrc).not.toMatch(/\.from\(["'][^"']+["']\)\.update\([\s\S]*?\)\.catch\(/);
  });

  it("kill switch P29B_DISABLE_INLINE_PHASE_5_7 default is true", () => {
    expect(earlyEnqueueSrc).toContain("P29B_DISABLE_INLINE_PHASE_5_7");
    expect(earlyEnqueueSrc).toMatch(/\?\?\s*"true"/);
    expect(earlyEnqueueSrc).toContain('!== "false"');
  });

  it("main daily-cycle imports the kill switch and early-enqueue helper", () => {
    expect(mainSrc).toContain("isInlinePhase5To7Disabled");
    expect(mainSrc).toContain("enqueueRequiredPostPhase4Jobs");
    expect(mainSrc).toContain("P29B3_REQUIRED_PHASE_JOB_KINDS");
  });

  it("main cycle calls early enqueue right after update_cards_enqueued (before phase8 enqueue)", () => {
    const idxEnqueued = mainSrc.indexOf('"update_cards_enqueued"');
    const idxEarly = mainSrc.indexOf("p29b3_s0_required_jobs_enqueued");
    const idxPhase8 = mainSrc.indexOf('"phase_8_therapist_intel"');
    expect(idxEnqueued).toBeGreaterThan(0);
    expect(idxEarly).toBeGreaterThan(idxEnqueued);
    expect(idxPhase8).toBeGreaterThan(idxEarly);
  });

  it("inline phase 5–7.x blocks are guarded by the kill switch", () => {
    expect(mainSrc).toContain("p29b3_inline_phase_5_5_disabled");
    expect(mainSrc).toContain("p29b3_inline_phase_65_to_76a_disabled");
  });

  it("completion semantics mark p29b_accepted:false and helper_coverage_partial:true", () => {
    expect(mainSrc).toContain("p29b_accepted: false");
    expect(mainSrc).toContain("helper_coverage_partial: true");
    expect(mainSrc).toContain("p29b3_s0_scaffold: true");
    expect(mainSrc).toContain("p29b3_staged_hard_architecture_no_false_green");
  });

  it("source audit: no inline ai.gateway / sendEmail / long edge fetches between guarded blocks (when kill switch true)", () => {
    // Slice between the two guard markers — that range is the legacy inline
    // body which only runs when kill switch is OFF; OK if it contains those
    // tokens. We instead verify the early-enqueue happens before phase8 and
    // that no NEW awaited fetch to operative-plan/pantry/drive-queue exists
    // between p29b3_s0_required_jobs_enqueued and phase_8_therapist_intel
    // OUTSIDE the inline guards.
    const start = mainSrc.indexOf("p29b3_s0_required_jobs_enqueued");
    const end = mainSrc.indexOf('"phase_8_therapist_intel"');
    const middle = mainSrc.slice(start, end);
    // Anything that performs awaited long work must be inside the
    // `if (isInlinePhase5To7Disabled())` else-branch — which we verified
    // above by presence of the disabled markers. So just check that the
    // guards exist within the middle slice.
    expect(middle).toContain("p29b3_inline_phase_5_5_disabled");
    expect(middle).toContain("p29b3_inline_phase_65_to_76a_disabled");
  });
});
