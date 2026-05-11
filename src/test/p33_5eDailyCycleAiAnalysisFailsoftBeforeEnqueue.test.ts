/**
 * P33.5E — main daily-cycle ai_analysis must be a bounded, fail-soft step
 * that NEVER blocks creation of the 14 required phase jobs.
 *
 * These are source-guard tests over supabase/functions/karel-did-daily-cycle/index.ts.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC_PATH = path.join(
  process.cwd(),
  "supabase/functions/karel-did-daily-cycle/index.ts",
);
const SRC = fs.readFileSync(SRC_PATH, "utf-8");

describe("P33.5E ai_analysis fail-soft before enqueue", () => {
  it("ai_analysis bounded budget <= 45_000 ms", () => {
    const m = SRC.match(/AI_ANALYSIS_TIMEOUT_MS\s*=\s*(\d[\d_]*)/);
    expect(m, "AI_ANALYSIS_TIMEOUT_MS missing").toBeTruthy();
    const v = Number((m![1] || "").replace(/_/g, ""));
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(45_000);
  });

  it("ai_analysis uses AbortController", () => {
    expect(SRC).toMatch(/const\s+analysisController\s*=\s*new\s+AbortController/);
    expect(SRC).toMatch(/signal:\s*analysisController\.signal/);
  });

  it("ai_analysis old 120s timeout removed", () => {
    expect(SRC).not.toMatch(/abort\(\),\s*120000\b/);
    expect(SRC).not.toMatch(/timeout 120s/);
  });

  it("aiAnalysisFailsoft state object exists with required fields", () => {
    expect(SRC).toMatch(/aiAnalysisFailsoft\s*:\s*\{/);
    expect(SRC).toMatch(/p33_5e_ai_analysis_failsoft\s*:\s*true/);
    expect(SRC).toMatch(/analyzer_status/);
    expect(SRC).toMatch(/fallback_used/);
  });

  it("timeout / exception paths set fallback instead of throwing", () => {
    expect(SRC).toMatch(/timeout_fallback/);
    expect(SRC).toMatch(/exception_fallback/);
    expect(SRC).toMatch(/http_error_fallback/);
    // No `throw abortErr` left in the ai_analysis catch.
    expect(SRC).not.toMatch(/throw\s+abortErr/);
  });

  it("non-JSON response is fail-soft", () => {
    expect(SRC).toMatch(/ai_gateway_non_json/);
  });

  it("ai_analysis never throws 'AI response missing required fields'", () => {
    expect(SRC).not.toMatch(/throw\s+new\s+Error\(\s*["']AI response missing required fields/);
  });

  it("context_data.ai_analysis is persisted with failsoft metadata", () => {
    expect(SRC).toMatch(/ai_analysis:\s*aiAnalysisFailsoft/);
  });

  it("recovery marker exists before enqueueRequiredPostPhase4Jobs", () => {
    expect(SRC).toMatch(/pre_required_jobs_recovery/);
    expect(SRC).toMatch(/p33_5e_ai_analysis_fallback_continue/);
  });

  it("source order: AI_ANALYSIS_TIMEOUT_MS appears BEFORE enqueueRequiredPostPhase4Jobs call", () => {
    const a = SRC.indexOf("AI_ANALYSIS_TIMEOUT_MS");
    const b = SRC.indexOf("enqueueRequiredPostPhase4Jobs({");
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
  });

  it("recovery marker appears BEFORE enqueueRequiredPostPhase4Jobs call", () => {
    const a = SRC.indexOf("pre_required_jobs_recovery");
    const b = SRC.indexOf("enqueueRequiredPostPhase4Jobs({");
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
  });

  it("fast completion barrier still present after enqueue", () => {
    expect(SRC).toMatch(/completeMainOrchestratorAfterPhaseJobDetach/);
  });

  it("ai_analysis fetch is guarded by analysisController.signal", () => {
    // Find the fetch immediately following analysisController declaration.
    const ctrlIdx = SRC.indexOf("const analysisController = new AbortController");
    expect(ctrlIdx).toBeGreaterThan(0);
    const window = SRC.slice(ctrlIdx, ctrlIdx + 1500);
    expect(window).toMatch(/ai\.gateway\.lovable\.dev\/v1\/chat\/completions/);
    expect(window).toMatch(/signal:\s*analysisController\.signal/);
  });

  it("required phase job list remains 14", () => {
    const sharedPath = path.join(
      process.cwd(),
      "supabase/functions/_shared/dailyCyclePhaseJobs.ts",
    );
    const shared = fs.readFileSync(sharedPath, "utf-8");
    const m = shared.match(/P29B3_REQUIRED_PHASE_JOB_KINDS[^=]*=\s*\[([\s\S]*?)\]/);
    expect(m, "P29B3_REQUIRED_PHASE_JOB_KINDS not found").toBeTruthy();
    const items = (m![1].match(/"[^"]+"/g) || []).length;
    expect(items).toBe(14);
  });
});
