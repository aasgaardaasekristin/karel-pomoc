/**
 * P29B.3-H8.4 — explicit isInternalForceFullBypass marker static contract.
 *
 * Pins:
 *  1. The marker is defined and requires isCronCall AND forceFullPathEarly
 *     AND requestBody.bypassDispatchCheck === true.
 *  2. recent_success dedup gate references the marker (or forceFullPathEarly)
 *     and is skipped when bypass is active.
 *  3. dispatch slot cooldown bypass references the marker.
 *  4. Quiet-day branch is bypassed by forceFullPath.
 *  5. Canonical user guard remains BEFORE the launcher and is NOT bypassed.
 *  6. User-JWT path cannot trigger forceFullPath (isCronCall required).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(__dirname, "../../supabase/functions/karel-did-daily-cycle/index.ts"),
  "utf8",
);

describe("P29B.3-H8.4 explicit force-full bypass marker", () => {
  it("declares isInternalForceFullBypass with all three required conditions", () => {
    expect(SRC).toMatch(
      /const\s+isInternalForceFullBypass\s*=\s*\n\s*isCronCall\s*&&\s*\n\s*forceFullPathEarly\s*&&\s*\n\s*requestBody\?\.bypassDispatchCheck\s*===\s*true;/,
    );
  });

  it("recent_success dedup is skipped when isInternalForceFullBypass is true", () => {
    expect(SRC).toMatch(
      /!isManualTriggerEarly && !forceFullPathEarly && !isInternalForceFullBypass && !isBackgroundOrchestrator && resolvedUserId/,
    );
  });

  it("dispatch slot cooldown bypass references isInternalForceFullBypass", () => {
    expect(SRC).toMatch(
      /forceFullBypass\s*=\s*isInternalForceFullBypass\s*\|\|\s*\(forceFullPathEarly\s*&&\s*requestBody\?\.bypassDispatchCheck\s*===\s*true\)/,
    );
    expect(SRC).toMatch(/if \(!isManualTrigger && !forceFullBypass\)/);
  });

  it("quiet-day branch is bypassed by forceFullPath", () => {
    expect(SRC).toMatch(/quietDayBranchTaken[\s\S]{0,200}!forceFullPath/);
  });

  it("canonical user guard remains required before launcher (no force-full bypass)", () => {
    const launcherIdx = SRC.indexOf("FORCE-FULL DETACHED LAUNCHER");
    expect(launcherIdx).toBeGreaterThan(0);
    const slice = SRC.slice(launcherIdx, launcherIdx + 1500);
    expect(slice).toMatch(/if \(!resolvedUserId\)/);
    expect(slice).toMatch(/CANONICAL_USER_SCOPE_UNRESOLVED/);
  });

  it("forceFullPathEarly always requires isCronCall (user JWT cannot bypass)", () => {
    expect(SRC).toMatch(/forceFullPathEarly\s*=\s*\([^)]+\)\s*&&\s*isCronCall/);
  });

  it("isInternalForceFullBypass requires isCronCall (user JWT cannot bypass)", () => {
    const idx = SRC.indexOf("isInternalForceFullBypass");
    const slice = SRC.slice(idx, idx + 400);
    expect(slice).toMatch(/isCronCall/);
  });
});
