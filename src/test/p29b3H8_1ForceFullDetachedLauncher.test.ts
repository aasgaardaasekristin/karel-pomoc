/**
 * P29B.3-H8.1 — force-full detached launcher static contract.
 *
 * This is a static (regex/structural) test against the entrypoint source,
 * pinning the contract that:
 *   1. force-full (forceFullPath / forceFullAnalysis) is internal-only
 *      (gated by isCronCall AND/OR isCronSecretCall).
 *   2. The launcher creates a did_update_cycles row SYNCHRONOUSLY before
 *      scheduling background work.
 *   3. The launcher returns HTTP 202 with cycle_id.
 *   4. Background orchestrator path reuses existing_cycle_id and does not
 *      create a second row.
 *   5. Quiet-day branch is bypassed by forceFullPath; canonical guard is NOT.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(__dirname, "../../supabase/functions/karel-did-daily-cycle/index.ts"),
  "utf8",
);

describe("P29B.3-H8.1 force-full detached launcher", () => {
  it("declares forceFullPathEarly gated on isCronCall (internal-only)", () => {
    expect(SRC).toMatch(
      /forceFullPathEarly\s*=\s*\(requestBody\?\.forceFullAnalysis\s*===\s*true\s*\|\|\s*requestBody\?\.forceFullPath\s*===\s*true\)\s*&&\s*isCronCall/,
    );
  });

  it("recognises background_orchestrator and existing_cycle_id from body", () => {
    expect(SRC).toMatch(/isBackgroundOrchestrator\s*=\s*requestBody\?\.background_orchestrator\s*===\s*true\s*&&\s*isCronCall/);
    expect(SRC).toMatch(/existingCycleIdFromBody/);
    expect(SRC).toMatch(/requestBody\?\.existing_cycle_id/);
  });

  it("requires resolved canonical user before launcher accepts", () => {
    // The launcher branch must error out with CANONICAL_USER_SCOPE_UNRESOLVED
    // when resolvedUserId is missing, BEFORE any cycle row is inserted.
    const launcherIdx = SRC.indexOf("P29B.3-H8.1 FORCE-FULL DETACHED LAUNCHER");
    expect(launcherIdx).toBeGreaterThan(0);
    const slice = SRC.slice(launcherIdx, launcherIdx + 4000);
    expect(slice).toMatch(/if \(!resolvedUserId\)/);
    expect(slice).toMatch(/CANONICAL_USER_SCOPE_UNRESOLVED/);
  });

  it("inserts cycle row synchronously with running status + force-full markers", () => {
    const launcherIdx = SRC.indexOf("P29B.3-H8.1 FORCE-FULL DETACHED LAUNCHER");
    const slice = SRC.slice(launcherIdx, launcherIdx + 6000);
    expect(slice).toMatch(/from\("did_update_cycles"\)\s*\.insert\(/);
    expect(slice).toMatch(/p29b3_force_full_launcher_accepted/);
    expect(slice).toMatch(/p29b_force_full_path:\s*true/);
    expect(slice).toMatch(/p29b_force_full_launcher:\s*true/);
    expect(slice).toMatch(/launcher_accepted_at/);
    expect(slice).toMatch(/quiet_day_bypass_only:\s*true/);
  });

  it("returns 202 with cycle_id BEFORE long work", () => {
    const launcherIdx = SRC.indexOf("P29B.3-H8.1 FORCE-FULL DETACHED LAUNCHER");
    const slice = SRC.slice(launcherIdx, launcherIdx + 6000);
    expect(slice).toMatch(/mode:\s*"detached_force_full_orchestrator"/);
    expect(slice).toMatch(/cycle_id:\s*launchedCycleId/);
    expect(slice).toMatch(/status:\s*202/);
  });

  it("schedules background self-invoke with existing_cycle_id + background_orchestrator markers", () => {
    const launcherIdx = SRC.indexOf("P29B.3-H8.1 FORCE-FULL DETACHED LAUNCHER");
    const slice = SRC.slice(launcherIdx, launcherIdx + 6000);
    expect(slice).toMatch(/existing_cycle_id:\s*launchedCycleId/);
    expect(slice).toMatch(/background_orchestrator:\s*true/);
    expect(slice).toMatch(/EdgeRuntime/);
  });

  it("background orchestrator path REUSES the existing cycle row (no duplicate)", () => {
    // When isBackgroundOrchestrator + existingCycleIdFromBody, the worker
    // selects the existing row and updates phase, instead of inserting.
    expect(SRC).toMatch(/if \(existingCycleIdFromBody && isBackgroundOrchestrator\)/);
    expect(SRC).toMatch(/p29b3_force_full_background_orchestrator_started/);
  });

  it("dedup (3h recent_success) is bypassed by forceFullPathEarly OR background orchestrator", () => {
    expect(SRC).toMatch(
      /!isManualTriggerEarly && !forceFullPathEarly && !isBackgroundOrchestrator && resolvedUserId/,
    );
  });

  it("canonical user guard is NOT bypassed by forceFullPath", () => {
    // P23 guard runs unconditionally for any resolvedUserId, before launcher.
    const guardIdx = SRC.indexOf("P23 fix: enforce canonical scope match");
    const launcherIdx = SRC.indexOf("P29B.3-H8.1 FORCE-FULL DETACHED LAUNCHER");
    expect(guardIdx).toBeGreaterThan(0);
    expect(launcherIdx).toBeGreaterThan(guardIdx); // guard runs FIRST
    const guardSlice = SRC.slice(guardIdx, launcherIdx);
    expect(guardSlice).toMatch(/CANONICAL_USER_SCOPE_MISMATCH/);
    expect(guardSlice).not.toMatch(/forceFullPath/); // guard does not check force flag
  });

  it("user JWT path cannot trigger forceFullPath (isCronCall required)", () => {
    // forceFullPathEarly explicitly ANDs with isCronCall; user JWT requests
    // (no cron secret + no service-role bearer) make isCronCall=false.
    expect(SRC).toMatch(/&&\s*isCronCall/);
    // Sanity: isCronCall is built from cron secret OR legacy service bearer only.
    expect(SRC).toMatch(/isCronCall\s*=\s*isCronSecretCall\s*\|\|\s*isLegacyBearerCron/);
  });

  it("quiet-day branch only fires when NOT forceFullPath", () => {
    expect(SRC).toMatch(/quietDayBranchTaken[\s\S]{0,200}!forceFullPath/);
  });
});
