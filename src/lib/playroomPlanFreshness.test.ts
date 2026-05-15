/**
 * HOTFIX 1.6 — testy pro isPlayroomPlanFreshForToday (AC9).
 * 4 case: fresh, stale_date, stale_prepared_at (proxy: starší plan_date),
 * empty_program. Plus null/missing.
 */
import { describe, it, expect } from "vitest";
import { isPlayroomPlanFreshForToday } from "./playroomPlanFreshness";

// Fixní "now" v Europe/Prague tak, aby pragueTodayISO vracel 2026-05-15.
// 12:00 UTC 2026-05-15 = 14:00 Praha → bez ohledu na DST den = 2026-05-15.
const NOW = new Date("2026-05-15T12:00:00Z");
const TODAY = "2026-05-15";

describe("isPlayroomPlanFreshForToday", () => {
  it("fresh: dnešní plan_date + ne-prázdný program → true", () => {
    expect(isPlayroomPlanFreshForToday(
      { plan_date: TODAY, therapeutic_program: [{ block: "x", minutes: 3 }] },
      NOW,
    )).toBe(true);
  });

  it("stale_date: včerejší plan_date → false (i s programem)", () => {
    expect(isPlayroomPlanFreshForToday(
      { plan_date: "2026-05-14", therapeutic_program: [{ block: "x", minutes: 3 }] },
      NOW,
    )).toBe(false);
  });

  it("stale_prepared_at proxy: chybějící plan_date → false (canonical fallback ze staršího řádku)", () => {
    expect(isPlayroomPlanFreshForToday(
      { plan_date: undefined, therapeutic_program: [{ block: "x", minutes: 3 }] },
      NOW,
    )).toBe(false);
  });

  it("empty_program: dnešní plan_date ale prázdný program → false", () => {
    expect(isPlayroomPlanFreshForToday(
      { plan_date: TODAY, therapeutic_program: [] },
      NOW,
    )).toBe(false);
  });

  it("null/undefined plan → false", () => {
    expect(isPlayroomPlanFreshForToday(null, NOW)).toBe(false);
    expect(isPlayroomPlanFreshForToday(undefined, NOW)).toBe(false);
  });

  it("non-array program → false", () => {
    expect(isPlayroomPlanFreshForToday(
      { plan_date: TODAY, therapeutic_program: "not-array" as unknown },
      NOW,
    )).toBe(false);
  });
});
