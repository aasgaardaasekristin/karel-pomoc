/**
 * P29B.2-CF — static source proof for the CENTRUM tail extraction.
 *
 * These tests are intentionally filesystem-level: they assert the refactor
 * is structurally complete (job kind, helper, worker dispatch, no
 * inline tail in main path, no large payload in context_data, payload
 * table migration exists). They do NOT exercise the cycle at runtime —
 * runtime acceptance is a separate subpass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const F = {
  jobs: "supabase/functions/_shared/dailyCyclePhaseJobs.ts",
  helper: "supabase/functions/_shared/dailyCyclePhase4CentrumTail.ts",
  worker: "supabase/functions/karel-did-daily-cycle-phase-worker/index.ts",
  cycle: "supabase/functions/karel-did-daily-cycle/index.ts",
} as const;

const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("P29B.2-CF — CENTRUM tail extraction", () => {
  it("PhaseJobKind union includes phase4_centrum_tail", () => {
    expect(read(F.jobs)).toMatch(/"phase4_centrum_tail"/);
  });

  it("helper file exists and exports runPhase4CentrumTail", () => {
    const h = read(F.helper);
    expect(h).toMatch(/export\s+(async\s+)?function\s+runPhase4CentrumTail/);
    // result shape contract
    expect(h).toMatch(/writes_enqueued/);
    expect(h).toMatch(/duration_ms/);
    expect(h).toMatch(/controlled_skips/);
  });

  it("helper has a wall-clock budget and AI timeout", () => {
    const h = read(F.helper);
    expect(h).toMatch(/TAIL_TOTAL_BUDGET_MS/);
    expect(h).toMatch(/KNIHOVNA_BUDGET_MS/);
    expect(h).toMatch(/KNIHOVNA_AI_TIMEOUT_MS/);
    expect(h).toMatch(/AbortController/);
  });

  it("phase worker dispatches phase4_centrum_tail in-process", () => {
    const w = read(F.worker);
    expect(w).toMatch(/job\.job_kind\s*===\s*"phase4_centrum_tail"/);
    expect(w).toMatch(/runPhase4CentrumTail/);
  });

  it("main daily-cycle enqueues phase4_centrum_tail with payload_ref", () => {
    const c = read(F.cycle);
    expect(c).toMatch(/job_kind:\s*"phase4_centrum_tail"/);
    expect(c).toMatch(/phase4_tail_payload_ref/);
    expect(c).toMatch(/did_daily_cycle_phase_payloads/);
  });

  it("main daily-cycle no longer contains inline CENTRUM tail work between markers", () => {
    const c = read(F.cycle).split("\n");
    const startIdx = c.findIndex((l) => l.includes('setPhase("update_cards_enqueued"'));
    const endIdx = c.findIndex(
      (l, i) => i > startIdx && l.includes('setPhase("phase4_centrum_tail_enqueued"'),
    );
    expect(startIdx).toBeGreaterThan(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    const region = c.slice(startIdx, endIdx + 1).join("\n");

    // Forbidden tokens that indicate inline tail work survived
    const forbidden = [
      /\bai\.gateway\.lovable\.dev\b/,
      /\blistFilesInFolder\s*\(/,
      /\breadFileContent\s*\(/,
      /\bdid_pending_drive_writes\b/,
      /\bKNIHOVNA_BUDGET_MS\b/,
      /\bCENTRUM-FALLBACK\b/,
      /\[KNIHOVNA_KARTA:/,
      /\[KNIHOVNA_CENTRUM:/,
    ];
    for (const re of forbidden) {
      expect(region, `forbidden token survived in main path: ${re}`).not.toMatch(re);
    }
  });

  it("main daily-cycle stores only payload_ref (no >20KB inline payload) in context_data.phase4", () => {
    const c = read(F.cycle);
    // The merged context patch must contain payload_id + payload_table, not the raw payload.
    const block = c.split('phase4_tail_payload_ref')[1] ?? "";
    const head = block.slice(0, 800);
    expect(head).toMatch(/payload_table/);
    expect(head).toMatch(/payload_id/);
    // We must NOT be cramming validatedAnalysisText into context_data.
    expect(head).not.toMatch(/validatedAnalysisText/);
  });

  it("payload table migration exists", () => {
    const dir = "supabase/migrations";
    const files = readdirSync(join(ROOT, dir));
    const found = files.some((f) => {
      try {
        const body = readFileSync(join(ROOT, dir, f), "utf8");
        return /CREATE\s+TABLE[^;]*did_daily_cycle_phase_payloads/i.test(body);
      } catch {
        return false;
      }
    });
    expect(found).toBe(true);
  });

  it("enqueuePhaseJob idempotency key for phase4_centrum_tail is cycle_id:phase4_centrum_tail", () => {
    const j = read(F.jobs);
    expect(j).toMatch(/idempotency_key\s*=\s*`\$\{i\.cycle_id\}:\$\{i\.job_kind\}/);
  });
});
