/**
 * P29B.3-H7: phase55_crisis_bridge helper acceptance tests.
 *
 * The helper must default to dry-run, must never call AI / send email /
 * write to Drive / mutate live-session state in smoke, and must keep
 * weak hints out of the auto-task path.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "supabase", "functions");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const phaseJobs = read("_shared/dailyCyclePhaseJobs.ts");
const helper = read("_shared/dailyCyclePhase55CrisisBridge.ts");
const worker = read("karel-did-daily-cycle-phase-worker/index.ts");
const mainCycle = read("karel-did-daily-cycle/index.ts");

describe("P29B.3-H7 — phase55_crisis_bridge helper", () => {
  it("phase55_crisis_bridge is in PhaseJobKind union", () => {
    expect(phaseJobs).toMatch(/"phase55_crisis_bridge"/);
  });

  it("phase55_crisis_bridge is in required jobs list", () => {
    const block = phaseJobs.split("P29B3_REQUIRED_PHASE_JOB_KINDS")[1] ?? "";
    const closed = block.split("] as const")[0];
    expect(closed).toMatch(/"phase55_crisis_bridge"/);
  });

  it("phase55_crisis_bridge is NOT in unimplemented list", () => {
    const block = phaseJobs.split("P29B3_S0_UNIMPLEMENTED_HELPER_KINDS")[1] ?? "";
    const closed = block.split("] as const")[0];
    expect(closed).not.toMatch(/"phase55_crisis_bridge"/);
  });

  it("helper exports runPhase55CrisisBridge", () => {
    expect(helper).toMatch(/export\s+async\s+function\s+runPhase55CrisisBridge/);
  });

  it("helper defaults: dry_run=true, apply_output=false, generate_ai=false, send_alert=false", () => {
    expect(helper).toMatch(/dry_run\s*=\s*input\.dry_run\s*!==\s*false/);
    expect(helper).toMatch(/apply_output\s*=\s*input\.apply_output\s*===\s*true/);
    expect(helper).toMatch(/generate_ai\s*=\s*input\.generate_ai\s*===\s*true/);
    expect(helper).toMatch(/send_alert\s*=\s*input\.send_alert\s*===\s*true/);
  });

  it("helper has bounded max_candidates (default 20, hard 100)", () => {
    expect(helper).toMatch(/DEFAULT_MAX_CANDIDATES\s*=\s*20/);
    expect(helper).toMatch(/HARD_MAX_CANDIDATES\s*=\s*100/);
  });

  it("helper result shape contains required fields", () => {
    for (const f of [
      "candidates_count",
      "evaluated_count",
      "weak_hints_count",
      "evidence_supported_count",
      "would_flag_count",
      "would_create_task_count",
      "would_enqueue_drive_count",
      "tasks_created_count",
      "drive_writes_enqueued",
      "alerts_sent_count",
      "ai_calls_made",
      "controlled_skips",
      "errors",
      "evidence_levels_summary",
      "requires_therapist_review_count",
    ]) {
      expect(helper).toContain(f);
    }
  });

  it("helper documents controlled_skip reasons", () => {
    for (const r of [
      "no_crisis_bridge_candidates",
      "only_weak_hints_no_action",
      "dry_run_no_apply",
      "apply_output_false",
      "generate_ai_false",
      "send_alert_false",
      "missing_required_table",
    ]) {
      expect(helper).toContain(r);
    }
  });

  it("helper has NO email / Drive / live-session side effects", () => {
    const forbidden = [
      "sendOrQueueEmail",
      "sendEmail(",
      "api.resend.com",
      "safeEnqueueDriveWrite(",
      "safeInsertGovernedDriveWrite(",
      "drive.googleapis.com",
      "did_pending_drive_writes",
      "did_pending_emails",
      "session_signoff",
      "playroom_session",
      "playroom_start",
      "live_session_start",
      "session_start",
    ];
    for (const t of forbidden) {
      expect(helper.includes(t), `helper must not contain "${t}"`).toBe(false);
    }
  });

  it("helper AI tokens appear only behind generate_ai guard (or not at all)", () => {
    // We allow "generate_ai" identifier itself, but no actual AI call should
    // exist outside a generate_ai-guarded branch. In H7 there is no AI call
    // at all, so the helper must not contain any of these tokens.
    const aiTokens = [
      "ai.gateway.lovable.dev",
      "callAiForJson",
      "aiCallWrapper(",
      "/v1/ai/",
    ];
    for (const t of aiTokens) {
      expect(helper.includes(t), `helper must not contain AI token "${t}"`).toBe(false);
    }
  });

  it("helper has raw text leak guard (no Hana-personal table read)", () => {
    expect(helper.includes("hana_personal_memory")).toBe(false);
    expect(helper.includes("raw_text")).toBe(false);
  });

  it("weak hints (I0/I1) cannot become a crisis task by themselves", () => {
    // Either of these patterns must hold: wouldCreateTask is gated to
    // isEvidenceSupported (D1/D2) only.
    expect(helper).toMatch(/wouldCreateTask\s*[:=]\s*isEvidenceSupported/);
    // And the alert-only branch explicitly sets wouldCreateTask: false.
    expect(helper).toMatch(/wouldCreateTask:\s*false/);
  });

  it("worker dispatches phase55_crisis_bridge to the helper, not via HTTP", () => {
    expect(worker).toMatch(/runPhase55CrisisBridge/);
    expect(worker).toMatch(/job\.job_kind === "phase55_crisis_bridge"/);
  });

  it("inline phase 5.5 crisis bridge remains behind kill switch", () => {
    expect(mainCycle).toMatch(/p29b3_inline_phase_5_5_disabled/);
    expect(mainCycle).toMatch(/isInlinePhase5To7Disabled\s*\(\s*\)/);
  });
});
