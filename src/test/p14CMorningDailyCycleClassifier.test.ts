/**
 * P14C: morning_daily_cycle classifier static contract.
 *
 * Guards against the false-negative bug where the operational coverage check
 * marked morning_daily_cycle as not_implemented despite a canonical completed
 * daily cycle existing today. The classifier MUST read from did_update_cycles
 * scoped to the canonical user, and accept "completed" without last_error.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const COVERAGE_FILE = resolve(
  process.cwd(),
  "supabase/functions/karel-operational-coverage-check/index.ts",
);

describe("P14C morning_daily_cycle classifier (static)", () => {
  const src = readFileSync(COVERAGE_FILE, "utf-8");

  it("uses did_update_cycles as canonical source", () => {
    const block = src.split("morning_daily_cycle")[1] ?? "";
    const window = block.slice(0, 4000);
    expect(window.includes('"did_update_cycles"')).toBe(true);
  });

  it("does NOT classify morning_daily_cycle from did_cycle_run_log anymore", () => {
    const block = src.split("morning_daily_cycle")[1] ?? "";
    const window = block.slice(0, 4000);
    expect(window.includes("did_cycle_run_log")).toBe(false);
  });

  it("requires status=completed and no last_error to mark ok", () => {
    const block = src.split("morning_daily_cycle")[1] ?? "";
    const window = block.slice(0, 4000);
    expect(/status\)\.toLowerCase\(\)\s*===\s*"completed"/.test(window)).toBe(true);
    expect(window.includes("last_error")).toBe(true);
  });

  it("emits canonical_daily_cycle_completed_today reason on green", () => {
    expect(src.includes("canonical_daily_cycle_completed_today")).toBe(true);
  });

  it("scopes the canonical query by canonical user_id", () => {
    const block = src.split("morning_daily_cycle")[1] ?? "";
    const window = block.slice(0, 4000);
    expect(window.includes('.eq("user_id", userId)')).toBe(true);
  });
});
