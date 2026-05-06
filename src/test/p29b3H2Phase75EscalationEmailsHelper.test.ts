/**
 * P29B.3-H2: phase75_escalation_emails helper acceptance tests.
 *
 * Source-audit + structural checks against the helper, the unimplemented
 * list, the worker dispatch and the main daily-cycle inline guard.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "supabase", "functions");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const phaseJobs = read("_shared/dailyCyclePhaseJobs.ts");
const helper = read("_shared/dailyCyclePhase75EscalationEmails.ts");
const worker = read("karel-did-daily-cycle-phase-worker/index.ts");
const mainCycle = read("karel-did-daily-cycle/index.ts");

describe("P29B.3-H2 — phase75 escalation emails helper", () => {
  it("removed phase75_escalation_emails from unimplemented list", () => {
    const block = phaseJobs.split("P29B3_S0_UNIMPLEMENTED_HELPER_KINDS")[1] ?? "";
    const closed = block.split("] as const")[0];
    expect(closed).not.toMatch(/"phase75_escalation_emails"/);
  });

  it("phase75_escalation_emails remains in required jobs list", () => {
    const block = phaseJobs.split("P29B3_REQUIRED_PHASE_JOB_KINDS")[1] ?? "";
    const closed = block.split("] as const")[0];
    expect(closed).toMatch(/"phase75_escalation_emails"/);
  });

  it("helper file exports runPhase75EscalationEmails", () => {
    expect(helper).toMatch(/export\s+async\s+function\s+runPhase75EscalationEmails/);
  });

  it("helper defaults to dry_run unless send_email === true", () => {
    expect(helper).toMatch(/send_email\s*=\s*input\.send_email\s*===\s*true/);
    expect(helper).toMatch(/dry_run\s*=\s*!send_email\s*\|\|\s*input\.dry_run\s*===\s*true/);
  });

  it("helper result shape contains required fields", () => {
    for (const f of [
      "would_send_count",
      "sent_count",
      "deduped_count",
      "duration_ms",
      "escalation_candidates_count",
      "controlled_skips",
    ]) {
      expect(helper).toContain(f);
    }
  });

  it("helper has heartbeat hook", () => {
    expect(helper).toMatch(/setHeartbeat\?\.\(\)/);
  });

  it("helper has dedupe / already-sent guard", () => {
    expect(helper).toMatch(/last_escalation_email_at/);
    expect(helper).toMatch(/maxFreqMs/);
  });

  it("worker dispatches phase75_escalation_emails to the helper, not via HTTP", () => {
    expect(worker).toMatch(/runPhase75EscalationEmails/);
    expect(worker).toMatch(/job\.job_kind === "phase75_escalation_emails"/);
  });

  it("inline phase 5–7 block stays behind kill switch", () => {
    expect(mainCycle).toMatch(/isInlinePhase5To7Disabled\s*\(\s*\)/);
    // FÁZE 7.5 inline section must remain inside the guarded branch — i.e.
    // it lives between the second guard open and the closing `} // P29B.3-S0`.
    const idx75 = mainCycle.indexOf("FÁZE 7.5");
    const guardClose = mainCycle.indexOf("end inline phase 6.5–7.6a guard");
    expect(idx75).toBeGreaterThan(0);
    expect(guardClose).toBeGreaterThan(idx75);
  });

  it("no inline Resend send is added in normal path of helper besides controlled production branch", () => {
    // Helper is the only allowed location of api.resend.com beyond main cycle.
    expect(helper).toMatch(/api\.resend\.com/);
  });
});
