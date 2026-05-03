/**
 * P15 — Watchdog is not primary
 * ──────────────────────────────
 * Architectural acceptance tests:
 *  1. A watchdog-produced briefing CANNOT show "Aktuální" in UI.
 *  2. A watchdog-produced briefing is treated as "Náhradní omezený přehled"
 *     even if `payload.limited` was not explicitly set.
 *  3. Only PRIMARY methods (auto, primary_orchestrator) can be "Aktuální".
 *  4. Method category sets are mutually exclusive and cover all known methods.
 */
import { describe, it, expect } from "vitest";
import {
  categorizeBriefingMethod,
  isPrimaryBriefingMethod,
  isWatchdogBriefingMethod,
  isManualBriefingMethod,
  PRIMARY_BRIEFING_METHODS,
  WATCHDOG_BRIEFING_METHODS,
} from "@/lib/briefingMethodAuthority";
import { getBriefingTruthStatus } from "@/lib/briefingTruthStatus";

const TODAY = "2026-05-03";

const baseRow = {
  briefing_date: TODAY,
  is_stale: false,
  generation_duration_ms: 45000,
  payload: { daily_cycle_status: "completed" },
};

describe("P15 — briefing method authority", () => {
  it("classifies primary methods correctly", () => {
    expect(categorizeBriefingMethod("auto")).toBe("primary");
    expect(categorizeBriefingMethod("primary_orchestrator")).toBe("primary");
    expect(isPrimaryBriefingMethod("auto")).toBe(true);
  });

  it("classifies watchdog methods correctly", () => {
    expect(categorizeBriefingMethod("sla_watchdog")).toBe("watchdog");
    expect(categorizeBriefingMethod("sla_watchdog_repair")).toBe("watchdog");
    expect(categorizeBriefingMethod("auto_repair_after_missed_morning")).toBe("watchdog");
    expect(categorizeBriefingMethod("watchdog_limited_repair")).toBe("watchdog");
    expect(isWatchdogBriefingMethod("sla_watchdog")).toBe(true);
  });

  it("classifies manual methods correctly", () => {
    expect(categorizeBriefingMethod("manual")).toBe("manual");
    expect(categorizeBriefingMethod("manual_force")).toBe("manual");
    expect(isManualBriefingMethod("manual")).toBe(true);
  });

  it("classifies missing/unknown methods correctly", () => {
    expect(categorizeBriefingMethod(null)).toBe("unknown");
    expect(categorizeBriefingMethod("")).toBe("unknown");
    expect(categorizeBriefingMethod("totally_made_up")).toBe("unknown");
  });

  it("primary and watchdog sets are mutually exclusive", () => {
    for (const m of PRIMARY_BRIEFING_METHODS) {
      expect(WATCHDOG_BRIEFING_METHODS.has(m)).toBe(false);
    }
    for (const m of WATCHDOG_BRIEFING_METHODS) {
      expect(PRIMARY_BRIEFING_METHODS.has(m)).toBe(false);
    }
  });
});

describe("P15 — watchdog is not primary in UI", () => {
  it("watchdog row today CANNOT show Aktuální (even if cycle completed and not limited)", () => {
    const status = getBriefingTruthStatus(
      { ...baseRow, generation_method: "sla_watchdog" },
      TODAY,
    );
    expect(status.canShowCurrent).toBe(false);
    expect(status.badgeLabel).not.toBe("Aktuální");
    expect(status.badgeLabel).toBe("Náhradní omezený přehled");
    expect(status.level).toBe("fresh_limited");
  });

  it("sla_watchdog_repair row today is also Náhradní omezený", () => {
    const status = getBriefingTruthStatus(
      { ...baseRow, generation_method: "sla_watchdog_repair", payload: { ...baseRow.payload, limited: true } },
      TODAY,
    );
    expect(status.canShowCurrent).toBe(false);
    expect(status.badgeLabel).toBe("Náhradní omezený přehled");
  });

  it("watchdog_limited_repair row today is Náhradní omezený", () => {
    const status = getBriefingTruthStatus(
      { ...baseRow, generation_method: "watchdog_limited_repair" },
      TODAY,
    );
    expect(status.canShowCurrent).toBe(false);
    expect(status.badgeLabel).toBe("Náhradní omezený přehled");
  });

  it("auto (primary) row today CAN show Aktuální", () => {
    const status = getBriefingTruthStatus(
      { ...baseRow, generation_method: "auto" },
      TODAY,
    );
    expect(status.canShowCurrent).toBe(true);
    expect(status.badgeLabel).toBe("Aktuální");
    expect(status.level).toBe("fresh_full");
  });

  it("primary_orchestrator row today CAN show Aktuální", () => {
    const status = getBriefingTruthStatus(
      { ...baseRow, generation_method: "primary_orchestrator" },
      TODAY,
    );
    expect(status.canShowCurrent).toBe(true);
    expect(status.badgeLabel).toBe("Aktuální");
  });

  it("regression: dnešní 3.5. watchdog row scenario must NOT be Aktuální", () => {
    // exact shape of what we observed in DB: sla_watchdog with no limited flag
    // and no cycle_status, generation_duration_ms = 45011
    const status = getBriefingTruthStatus(
      {
        briefing_date: TODAY,
        is_stale: false,
        generation_method: "sla_watchdog",
        generation_duration_ms: 45011,
        payload: null,
      },
      TODAY,
    );
    expect(status.canShowCurrent).toBe(false);
    expect(status.badgeLabel).toBe("Náhradní omezený přehled");
  });
});
