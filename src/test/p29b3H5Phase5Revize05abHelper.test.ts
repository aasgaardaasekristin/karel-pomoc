/**
 * P29B.3-H5: phase5_revize_05ab helper acceptance tests.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "supabase", "functions");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const phaseJobs = read("_shared/dailyCyclePhaseJobs.ts");
const helper = read("_shared/dailyCyclePhase5Revize05ab.ts");
const worker = read("karel-did-daily-cycle-phase-worker/index.ts");
const mainCycle = read("karel-did-daily-cycle/index.ts");

describe("P29B.3-H5 — phase5_revize_05ab helper", () => {
  it("removed phase5_revize_05ab from unimplemented list", () => {
    const block = phaseJobs.split("P29B3_S0_UNIMPLEMENTED_HELPER_KINDS")[1] ?? "";
    const closed = block.split("] as const")[0];
    expect(closed).not.toMatch(/"phase5_revize_05ab"/);
  });

  it("phase5_revize_05ab remains in required jobs list", () => {
    const block = phaseJobs.split("P29B3_REQUIRED_PHASE_JOB_KINDS")[1] ?? "";
    const closed = block.split("] as const")[0];
    expect(closed).toMatch(/"phase5_revize_05ab"/);
  });

  it("helper exports runPhase5Revize05ab", () => {
    expect(helper).toMatch(/export\s+async\s+function\s+runPhase5Revize05ab/);
  });

  it("helper defaults: dry_run=true, apply_output=false", () => {
    expect(helper).toMatch(/dry_run\s*=\s*input\.dry_run\s*!==\s*false/);
    expect(helper).toMatch(/apply_output\s*=\s*input\.apply_output\s*===\s*true/);
  });

  it("helper has bounded max_items (default 25, hard 100)", () => {
    expect(helper).toMatch(/DEFAULT_MAX_ITEMS\s*=\s*25/);
    expect(helper).toMatch(/HARD_MAX_ITEMS\s*=\s*100/);
  });

  it("helper has heartbeat calls", () => {
    expect(helper).toMatch(/setHeartbeat\?\.\(\)/);
  });

  it("helper result shape contains required fields", () => {
    for (const f of [
      "candidates_count",
      "evaluated_count",
      "would_update_count",
      "would_enqueue_drive_count",
      "db_updates_count",
      "drive_writes_enqueued",
      "controlled_skips",
      "duration_ms",
      "dry_run",
      "apply_output",
      "expired_count",
      "downgraded_count",
      "demoted_count",
      "promoted_count",
      "crisis_bridge_split",
    ]) {
      expect(helper).toContain(f);
    }
  });

  it("helper documents controlled_skip reasons", () => {
    for (const r of [
      "no_phase5_candidates",
      "dry_run_no_apply",
      "apply_output_false",
      "missing_required_table",
      "crisis_bridge_split_to_future_helper",
    ]) {
      expect(helper).toContain(r);
    }
  });

  it("helper has NO AI / email / live-session / playroom / signoff side effects", () => {
    const forbidden = [
      "ai.gateway.lovable.dev",
      "callAiForJson",
      "aiCallWrapper",
      "sendEmail",
      "api.resend.com",
      "did_pending_drive_writes",
      "drive.googleapis.com",
      "session_signoff",
      "playroom_session",
      "playroom_start",
      "session_start",
      "live_session_start",
    ];
    for (const t of forbidden) {
      expect(helper.includes(t), `helper must not contain "${t}"`).toBe(false);
    }
  });

  it("helper Drive flush goes only through post-intervention-sync (governed)", () => {
    expect(helper).toMatch(/post-intervention-sync/);
  });

  it("worker dispatches phase5_revize_05ab to the helper, not via HTTP", () => {
    expect(worker).toMatch(/runPhase5Revize05ab/);
    expect(worker).toMatch(/job\.job_kind === "phase5_revize_05ab"/);
  });

  it("inline phase5 block is behind kill switch (default-on)", () => {
    expect(mainCycle).toMatch(/p29b3_inline_phase_5_5_disabled/);
    expect(mainCycle).toMatch(/isInlinePhase5To7Disabled\s*\(\s*\)/);
  });
});
