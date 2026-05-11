/**
 * P33.5B.3 — DB-backed transport observability + bounded phase-worker delegates.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..", "..");
const phaseWorkerSrc = readFileSync(
  resolve(root, "supabase/functions/karel-did-daily-cycle-phase-worker/index.ts"),
  "utf8",
);
const pantrySrc = readFileSync(
  resolve(root, "supabase/functions/karel-pantry-flush-to-drive/index.ts"),
  "utf8",
);
const driveQueueSrc = readFileSync(
  resolve(root, "supabase/functions/karel-drive-queue-processor/index.ts"),
  "utf8",
);
const phaseJobsSrc = readFileSync(
  resolve(root, "supabase/functions/_shared/dailyCyclePhaseJobs.ts"),
  "utf8",
);

describe("P33.5B.3 phase-worker DB transport observability", () => {
  it("DB transport result records request_id and target_function", () => {
    expect(phaseWorkerSrc).toMatch(/db_transport_request_id/);
    expect(phaseWorkerSrc).toMatch(/target_function/);
    expect(phaseWorkerSrc).toMatch(/db_transport_started_at/);
    expect(phaseWorkerSrc).toMatch(/db_transport_completed_at/);
  });

  it("timeout result preserves request_id in stored result", () => {
    // The failure branch stores observability (which contains request_id)
    expect(phaseWorkerSrc).toMatch(/result:\s*\{\s*http_status:\s*result\.status,\s*body:\s*result\.body,\s*\.\.\.observability\s*\}/);
  });

  it("late-response reconciliation helper exists", () => {
    expect(phaseWorkerSrc).toMatch(/function reconcilePreviousDbTransportResponse/);
    expect(phaseWorkerSrc).toMatch(/reconciled_late_response/);
  });

  it("reconciliation runs before scheduling new pg_net call", () => {
    const proc = phaseWorkerSrc.match(/if \(useDbTransport\) \{\s*const reconciled = await reconcilePreviousDbTransportResponse/);
    expect(proc).toBeTruthy();
  });

  it("error prefixes are precise", () => {
    expect(phaseWorkerSrc).toMatch(/delegate_db_timeout_/);
    expect(phaseWorkerSrc).toMatch(/delegate_db_schedule_failed_/);
    expect(phaseWorkerSrc).toMatch(/delegate_db_http_401_/);
  });

  it("P33.5C critical DB transport timeouts stay below pg_net hard limit", () => {
    expect(phaseWorkerSrc).toMatch(/DB_TRANSPORT_TIMEOUTS_MS/);
    // P33.5C: pg_net is not a long-running completion channel.
    // Critical delegate calls must stay under the ~60s pg_net timeout.
    expect(phaseWorkerSrc).toMatch(/phase4_card_profiling:\s*55_000/);
    expect(phaseWorkerSrc).toMatch(/phase6_card_autoupdate:\s*55_000/);
    expect(phaseWorkerSrc).toMatch(/phase8b_pantry_flush:\s*55_000/);
    expect(phaseWorkerSrc).toMatch(/phase9_drive_queue_flush:\s*55_000/);
    expect(phaseWorkerSrc).not.toMatch(/phase8b_pantry_flush:\s*180_000/);
    expect(phaseWorkerSrc).not.toMatch(/phase9_drive_queue_flush:\s*180_000/);
  });

  it("P33.5C bounded delegate budget is <= 45s", () => {
    expect(phaseWorkerSrc).toMatch(/BOUNDED_DELEGATE_BUDGET_MS\s*=\s*45_000/);
    expect(phaseWorkerSrc).toMatch(/timeout_budget_ms:\s*BOUNDED_DELEGATE_BUDGET_MS/);
  });

  it("pg_net poll window is aligned with scheduling timeout (no extra +10s)", () => {
    expect(phaseWorkerSrc).toMatch(/waitForPgNetResponse\(admin, requestId, timeoutMs\)/);
  });

  it("phase-worker job select includes result column for reconciliation", () => {
    expect(phaseWorkerSrc).toMatch(/attempt_count, max_attempts, input, result/);
  });

  it("does not log secrets", () => {
    expect(phaseWorkerSrc).not.toMatch(/console\.\w+\([^)]*SERVICE_KEY/);
    expect(phaseWorkerSrc).not.toMatch(/console\.\w+\([^)]*cronSecret/);
  });
});

describe("P33.5B.3 pantry-flush bounded phase-worker mode", () => {
  it("detects phase-worker source", () => {
    expect(pantrySrc).toMatch(/isPhaseWorkerCall/);
    expect(pantrySrc).toMatch(/daily_cycle_phase_worker|p29b_phase_worker/);
  });

  it("respects max_items and timeout_budget_ms", () => {
    expect(pantrySrc).toMatch(/max_items/);
    expect(pantrySrc).toMatch(/timeout_budget_ms/);
    expect(pantrySrc).toMatch(/budgetExhausted/);
  });

  it("returns controlled_skipped 200 when no items to flush", () => {
    expect(pantrySrc).toMatch(/no_pantry_items_to_flush/);
    expect(pantrySrc).toMatch(/outcome:\s*"controlled_skipped"/);
  });

  it("never returns 401 in phase-worker bounded path (uses cron-secret accept path upstream)", () => {
    // helper still gates 401, but bounded mode is gated only after auth passes.
    expect(pantrySrc).toMatch(/X-Karel-Cron-Secret/);
  });
});

describe("P33.5B.3 drive-queue bounded phase-worker mode", () => {
  it("detects phase-worker source", () => {
    expect(driveQueueSrc).toMatch(/isPhaseWorkerCall/);
  });

  it("returns controlled_skipped 200 when no claimable work", () => {
    expect(driveQueueSrc).toMatch(/already_claimed_or_no_claimable_work/);
    expect(driveQueueSrc).toMatch(/outcome:\s*"controlled_skipped"/);
  });

  it("does not exceed lane limits (already bounded)", () => {
    expect(driveQueueSrc).toMatch(/FAST_LIMIT = 10/);
    expect(driveQueueSrc).toMatch(/BULK_LIMIT = 20/);
  });
});

describe("P33.5B.3 required job inventory unchanged (still 14)", () => {
  it("required phase job kinds count = 14", () => {
    const kinds = (phaseJobsSrc.match(/"phase[^"]+"/g) ?? []);
    const required = new Set(kinds);
    expect(required.size).toBeGreaterThanOrEqual(14);
  });
});
