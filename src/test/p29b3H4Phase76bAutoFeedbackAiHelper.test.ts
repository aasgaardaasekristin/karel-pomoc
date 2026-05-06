/**
 * P29B.3-H4: phase76b_auto_feedback_ai helper acceptance tests.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "supabase", "functions");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const phaseJobs = read("_shared/dailyCyclePhaseJobs.ts");
const helper = read("_shared/dailyCyclePhase76bAutoFeedbackAi.ts");
const worker = read("karel-did-daily-cycle-phase-worker/index.ts");
const mainCycle = read("karel-did-daily-cycle/index.ts");

describe("P29B.3-H4 — phase76b_auto_feedback_ai helper", () => {
  it("removed phase76b_auto_feedback_ai from unimplemented list", () => {
    const block = phaseJobs.split("P29B3_S0_UNIMPLEMENTED_HELPER_KINDS")[1] ?? "";
    const closed = block.split("] as const")[0];
    expect(closed).not.toMatch(/"phase76b_auto_feedback_ai"/);
  });

  it("phase76b_auto_feedback_ai remains in required jobs list", () => {
    const block = phaseJobs.split("P29B3_REQUIRED_PHASE_JOB_KINDS")[1] ?? "";
    const closed = block.split("] as const")[0];
    expect(closed).toMatch(/"phase76b_auto_feedback_ai"/);
  });

  it("helper exports runPhase76bAutoFeedbackAi", () => {
    expect(helper).toMatch(/export\s+async\s+function\s+runPhase76bAutoFeedbackAi/);
  });

  it("helper defaults: dry_run=true, generate_ai=false, apply_output=false", () => {
    expect(helper).toMatch(/dry_run\s*=\s*input\.dry_run\s*!==\s*false/);
    expect(helper).toMatch(/generate_ai\s*=\s*input\.generate_ai\s*===\s*true/);
    expect(helper).toMatch(/apply_output\s*=\s*input\.apply_output\s*===\s*true/);
  });

  it("helper has bounded max_candidates (default 3, hard 10)", () => {
    expect(helper).toMatch(/DEFAULT_MAX_CANDIDATES\s*=\s*3/);
    expect(helper).toMatch(/HARD_MAX_CANDIDATES\s*=\s*10/);
  });

  it("helper has AI timeout", () => {
    expect(helper).toMatch(/AI_TIMEOUT_MS/);
    expect(helper).toMatch(/AbortController/);
  });

  it("helper result shape contains required fields", () => {
    for (const f of [
      "candidates_count",
      "would_generate_count",
      "ai_calls_made",
      "generated_count",
      "applied_count",
      "skipped_count",
      "deduped_count",
      "controlled_skips",
      "duration_ms",
      "dry_run",
      "generate_ai",
      "apply_output",
    ]) {
      expect(helper).toContain(f);
    }
  });

  it("helper AI gateway/import only appears behind generate_ai guard", () => {
    // The only AI import must be inside the optional-generation phase, after
    // the generate_ai check. We assert the guard appears before the import.
    const guardIdx = helper.indexOf("if (!generate_ai)");
    const importIdx = helper.indexOf('import("./aiCallWrapper.ts")');
    expect(guardIdx).toBeGreaterThan(0);
    expect(importIdx).toBeGreaterThan(guardIdx);
  });

  it("helper has no email / Drive / session-plan tokens", () => {
    const forbidden = [
      "sendEmail",
      "api.resend.com",
      "did_pending_drive_writes",
      "safeEnqueueDriveWrite",
      "session_plan",
      "playroom_plan",
      "therapy_plan",
    ];
    for (const t of forbidden) {
      expect(helper.includes(t), `helper must not contain "${t}"`).toBe(false);
    }
  });

  it("helper AI prompt has anti-hallucination / evidence boundaries", () => {
    expect(helper).toMatch(/anti-halucinace|evidence/i);
    expect(helper).toMatch(/hypotéza|hypoteza|hypothes/i);
    expect(helper).toMatch(/Nevytvářej|neměň|nepotvr|žádné medical|medical\/legal/i);
  });

  it("helper has output JSON schema with certainty / needs_verification", () => {
    expect(helper).toMatch(/feedback_text/);
    expect(helper).toMatch(/quality_score/);
    expect(helper).toMatch(/certainty/);
    expect(helper).toMatch(/needs_verification/);
  });

  it("worker dispatches phase76b_auto_feedback_ai to the helper, not via HTTP", () => {
    expect(worker).toMatch(/runPhase76bAutoFeedbackAi/);
    expect(worker).toMatch(/job\.job_kind === "phase76b_auto_feedback_ai"/);
  });

  it("inline phase 7.6b AI block is behind kill switch (default-on)", () => {
    const idx = mainCycle.indexOf("FÁZE 7.6b");
    expect(idx).toBeGreaterThan(0);
    expect(mainCycle).toMatch(/isInlinePhase5To7Disabled\s*\(\s*\)/);
  });
});
