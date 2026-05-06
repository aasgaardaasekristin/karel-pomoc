/**
 * P29B.3-H3: phase76_feedback_retry helper acceptance tests.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "supabase", "functions");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const phaseJobs = read("_shared/dailyCyclePhaseJobs.ts");
const helper = read("_shared/dailyCyclePhase76FeedbackRetry.ts");
const worker = read("karel-did-daily-cycle-phase-worker/index.ts");
const mainCycle = read("karel-did-daily-cycle/index.ts");

describe("P29B.3-H3 — phase76_feedback_retry helper", () => {
  it("removed phase76_feedback_retry from unimplemented list", () => {
    const block = phaseJobs.split("P29B3_S0_UNIMPLEMENTED_HELPER_KINDS")[1] ?? "";
    const closed = block.split("] as const")[0];
    expect(closed).not.toMatch(/"phase76_feedback_retry"/);
  });

  it("phase76_feedback_retry remains in required jobs list", () => {
    const block = phaseJobs.split("P29B3_REQUIRED_PHASE_JOB_KINDS")[1] ?? "";
    const closed = block.split("] as const")[0];
    expect(closed).toMatch(/"phase76_feedback_retry"/);
  });

  it("helper exports runPhase76FeedbackRetry", () => {
    expect(helper).toMatch(/export\s+async\s+function\s+runPhase76FeedbackRetry/);
  });

  it("helper defaults to dry_run = true", () => {
    expect(helper).toMatch(/dry_run\s*=\s*input\.dry_run\s*!==\s*false/);
  });

  it("helper has bounded max_items (default 25, hard 100)", () => {
    expect(helper).toMatch(/DEFAULT_MAX_ITEMS\s*=\s*25/);
    expect(helper).toMatch(/HARD_MAX_ITEMS\s*=\s*100/);
  });

  it("helper result shape contains required fields", () => {
    for (const f of [
      "candidates_count",
      "would_retry_count",
      "retried_count",
      "skipped_count",
      "deduped_count",
      "state_updates_count",
      "controlled_skips",
      "duration_ms",
      "dry_run",
    ]) {
      expect(helper).toContain(f);
    }
  });

  it("helper has no AI / email / Drive tokens", () => {
    const forbidden = [
      "ai.gateway",
      "Gemini",
      "gemini",
      "openai",
      "OpenAI",
      "fetch(\"https://ai",
      "sendEmail",
      "api.resend.com",
      "did_pending_drive_writes",
      "safeEnqueueDriveWrite",
    ];
    for (const t of forbidden) {
      expect(helper.includes(t), `helper must not contain "${t}"`).toBe(false);
    }
  });

  it("worker dispatches phase76_feedback_retry to the helper, not via HTTP", () => {
    expect(worker).toMatch(/runPhase76FeedbackRetry/);
    expect(worker).toMatch(/job\.job_kind === "phase76_feedback_retry"/);
  });

  it("inline phase 7.6a retry block stays behind kill switch", () => {
    const idx = mainCycle.indexOf("FÁZE 7.6a");
    const guardClose = mainCycle.indexOf("end inline phase 6.5–7.6a guard");
    expect(idx).toBeGreaterThan(0);
    expect(guardClose).toBeGreaterThan(idx);
    expect(mainCycle).toMatch(/isInlinePhase5To7Disabled\s*\(\s*\)/);
  });
});
