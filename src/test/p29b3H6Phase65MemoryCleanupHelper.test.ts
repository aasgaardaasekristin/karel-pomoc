/**
 * P29B.3-H6: phase65_memory_cleanup helper acceptance tests.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "supabase", "functions");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const phaseJobs = read("_shared/dailyCyclePhaseJobs.ts");
const helper = read("_shared/dailyCyclePhase65MemoryCleanup.ts");
const worker = read("karel-did-daily-cycle-phase-worker/index.ts");
const mainCycle = read("karel-did-daily-cycle/index.ts");

describe("P29B.3-H6 — phase65_memory_cleanup helper", () => {
  it("removed phase65_memory_cleanup from unimplemented list", () => {
    const block = phaseJobs.split("P29B3_S0_UNIMPLEMENTED_HELPER_KINDS")[1] ?? "";
    const closed = block.split("] as const")[0];
    expect(closed).not.toMatch(/"phase65_memory_cleanup"/);
  });

  it("phase65_memory_cleanup remains in required jobs list", () => {
    const block = phaseJobs.split("P29B3_REQUIRED_PHASE_JOB_KINDS")[1] ?? "";
    const closed = block.split("] as const")[0];
    expect(closed).toMatch(/"phase65_memory_cleanup"/);
  });

  it("helper exports runPhase65MemoryCleanup", () => {
    expect(helper).toMatch(/export\s+async\s+function\s+runPhase65MemoryCleanup/);
  });

  it("helper defaults: dry_run=true, apply_output=false", () => {
    expect(helper).toMatch(/dry_run\s*=\s*input\.dry_run\s*!==\s*false/);
    expect(helper).toMatch(/apply_output\s*=\s*input\.apply_output\s*===\s*true/);
  });

  it("helper has bounded limits", () => {
    expect(helper).toMatch(/DEFAULT_MAX_ITEMS\s*=\s*100/);
    expect(helper).toMatch(/HARD_MAX_ITEMS\s*=\s*500/);
    expect(helper).toMatch(/HARD_MIN_MAX_AGE_DAYS\s*=\s*7/);
  });

  it("helper has heartbeat calls", () => {
    expect(helper).toMatch(/setHeartbeat\?\.\(\)/);
  });

  it("helper result shape contains required fields", () => {
    for (const f of [
      "candidates_count",
      "evaluated_count",
      "would_archive_count",
      "would_delete_cache_count",
      "archived_count",
      "deleted_cache_count",
      "blocked_sensitive_count",
      "skipped_count",
      "controlled_skips",
      "errors",
      "tables_touched",
      "duration_ms",
      "dry_run",
      "apply_output",
    ]) {
      expect(helper).toContain(f);
    }
  });

  it("helper documents controlled_skip reasons", () => {
    for (const r of [
      "no_memory_cleanup_candidates",
      "dry_run_no_apply",
      "apply_output_false",
      "missing_required_table",
    ]) {
      expect(helper).toContain(r);
    }
  });

  it("helper has NO AI / email / Drive / live-session side effects", () => {
    const forbidden = [
      "ai.gateway.lovable.dev",
      "callAiForJson",
      "aiCallWrapper",
      "sendEmail",
      "api.resend.com",
      "did_pending_drive_writes",
      "safeEnqueueDriveWrite",
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

  it("helper does NOT delete from sensitive clinical or audit tables", () => {
    const sensitive = [
      "did_update_cycles",
      "did_event_ingestion_log",
      "did_daily_briefings",
      "did_daily_cycle_phase_jobs",
      "did_daily_cycle_phase_payloads",
      "card_update_queue",
      "hana_personal_memory",
      "did_part_registry",
      "did_part_profiles",
      "did_daily_session_plans",
      "did_team_deliberations",
      "did_observations",
      "did_implications",
    ];
    for (const t of sensitive) {
      // forbid `from("<sensitive>")...delete(`
      const re = new RegExp(`from\\(\\s*["'\`]${t}["'\`]\\s*\\)[\\s\\S]{0,200}\\.delete\\(`);
      expect(helper.match(re), `helper must NOT delete from ${t}`).toBeNull();
    }
  });

  it("worker dispatches phase65_memory_cleanup to the helper, not via HTTP", () => {
    expect(worker).toMatch(/runPhase65MemoryCleanup/);
    expect(worker).toMatch(/job\.job_kind === "phase65_memory_cleanup"/);
  });

  it("inline phase 6.5 cleanup remains behind kill switch", () => {
    expect(mainCycle).toMatch(/p29b3_inline_phase_65_to_76a_disabled/);
    expect(mainCycle).toMatch(/isInlinePhase5To7Disabled\s*\(\s*\)/);
  });
});
