/**
 * P29B.3-H8.2 — durable background launcher contract.
 *
 * Pins the contract that:
 *   1. Launcher calls did_schedule_daily_cycle_background RPC.
 *   2. Response includes background_request_id and durable_scheduler_used.
 *   3. context_data persists background_request_id + background_scheduler.
 *   4. Background path writes an "entered" marker BEFORE running/recent/quiet
 *      guards, with phase=p29b3_background_orchestrator_entered.
 *   5. Running guard records guard_exit when blocked by a different cycle.
 *   6. recordBackgroundGuardExit helper exists.
 *   7. waitUntil is fallback-only (only fires when backgroundRequestId is null).
 *   8. phase8a5_session_eval_safety_net is part of the required job kinds.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { P29B3_REQUIRED_PHASE_JOB_KINDS } from "../../supabase/functions/_shared/dailyCyclePhaseJobs.ts";

const SRC = readFileSync(
  resolve(__dirname, "../../supabase/functions/karel-did-daily-cycle/index.ts"),
  "utf8",
);

describe("P29B.3-H8.2 durable background launcher", () => {
  it("calls did_schedule_daily_cycle_background RPC with cycle id + body", () => {
    expect(SRC).toMatch(/\.rpc\("did_schedule_daily_cycle_background"/);
    expect(SRC).toMatch(/p_cycle_id:\s*launchedCycleId/);
    expect(SRC).toMatch(/p_body:\s*\{/);
  });

  it("captures pg_net request id into backgroundRequestId", () => {
    expect(SRC).toMatch(/backgroundRequestId\s*=\s*Number\(rid\)/);
  });

  it("persists background_request_id + scheduler outcome to context_data", () => {
    expect(SRC).toMatch(/background_request_id:\s*backgroundRequestId/);
    expect(SRC).toMatch(/background_scheduler:\s*\{/);
    expect(SRC).toMatch(/durable_scheduler_used:\s*backgroundRequestId\s*!==\s*null/);
  });

  it("waitUntil(self-fetch) is fallback-only (gated on null request id)", () => {
    expect(SRC).toMatch(/if \(backgroundRequestId === null\)/);
    // The fallback branch must contain EdgeRuntime + waitUntil.
    const fallbackIdx = SRC.indexOf("if (backgroundRequestId === null)");
    expect(fallbackIdx).toBeGreaterThan(0);
    const fallbackSlice = SRC.slice(fallbackIdx, fallbackIdx + 2000);
    expect(fallbackSlice).toMatch(/EdgeRuntime/);
    expect(fallbackSlice).toMatch(/_bg_fallback:\s*true/);
  });

  it("uses X-Karel-Cron-Secret in fallback (no service-role bearer leak)", () => {
    const fallbackIdx = SRC.indexOf("if (backgroundRequestId === null)");
    const fallbackSlice = SRC.slice(fallbackIdx, fallbackIdx + 2000);
    expect(fallbackSlice).toMatch(/"X-Karel-Cron-Secret"/);
    expect(fallbackSlice).not.toMatch(/Authorization:\s*`Bearer \$\{serviceKey\}`/);
  });

  it("HTTP 202 response now includes background_request_id and durable flag", () => {
    expect(SRC).toMatch(/background_request_id:\s*backgroundRequestId,\s*\n\s*durable_scheduler_used:/);
  });

  it("background path writes 'entered' marker BEFORE any guard", () => {
    expect(SRC).toMatch(/BACKGROUND ENTERED MARKER/);
    expect(SRC).toMatch(/phase:\s*"p29b3_background_orchestrator_entered"/);
    expect(SRC).toMatch(/phase_step:\s*"background_entered_before_guards"/);
    // Marker must appear BEFORE the running guard.
    const markerIdx = SRC.indexOf("p29b3_background_orchestrator_entered");
    const runningGuardIdx = SRC.indexOf("Already running (live)");
    expect(markerIdx).toBeGreaterThan(0);
    expect(runningGuardIdx).toBeGreaterThan(markerIdx);
  });

  it("entered marker only fires for background orchestrator + existing cycle + canonical user", () => {
    expect(SRC).toMatch(/if \(isBackgroundOrchestrator && existingCycleIdFromBody && resolvedUserId\)/);
  });

  it("recordBackgroundGuardExit helper exists and is invoked on already_running other cycle", () => {
    expect(SRC).toMatch(/async function recordBackgroundGuardExit/);
    expect(SRC).toMatch(/recordBackgroundGuardExit\(`already_running_other_cycle:/);
  });

  it("running guard still ALLOWS same existing_cycle_id (no regression)", () => {
    expect(SRC).toMatch(
      /if \(runningDailyCycle && !\(isBackgroundOrchestrator && existingCycleIdFromBody && runningDailyCycle\.id === existingCycleIdFromBody\)\)/,
    );
  });

  it("recent_success dedup still bypassed by background orchestrator", () => {
    expect(SRC).toMatch(
      /!isManualTriggerEarly && !forceFullPathEarly && !isInternalForceFullBypass && !isBackgroundOrchestrator && resolvedUserId/,
    );
  });

  it("quiet-day branch still bypassed by forceFullPath", () => {
    expect(SRC).toMatch(/quietDayBranchTaken[\s\S]{0,200}!forceFullPath/);
  });

  it("canonical guard still required for launcher (no force-full bypass)", () => {
    const launcherIdx = SRC.indexOf("FORCE-FULL DETACHED LAUNCHER");
    expect(launcherIdx).toBeGreaterThan(0);
    const slice = SRC.slice(launcherIdx, launcherIdx + 1000);
    expect(slice).toMatch(/if \(!resolvedUserId\)/);
    expect(slice).toMatch(/CANONICAL_USER_SCOPE_UNRESOLVED/);
  });

  it("user JWT path cannot trigger forceFullPath (isCronCall required)", () => {
    expect(SRC).toMatch(/forceFullPathEarly\s*=\s*\([^)]+\)\s*&&\s*isCronCall/);
  });

  it("phase8a5_session_eval_safety_net is part of the required job kinds", () => {
    expect(P29B3_REQUIRED_PHASE_JOB_KINDS).toContain("phase8a5_session_eval_safety_net");
    // 14 kinds total now
    expect(P29B3_REQUIRED_PHASE_JOB_KINDS.length).toBe(14);
  });
});
