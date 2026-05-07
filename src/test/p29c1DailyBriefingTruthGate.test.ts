/**
 * P29C.1 — Daily Briefing Truth Gate.
 *
 * Verifies the gate accepts a fully-completed P29B cycle with all 14 required
 * jobs terminal and rejects every other shape (no cycle, running cycle,
 * missing job, duplicate job, queued/running, failed, controlled_skipped
 * without reason, briefing generated before cycle completion). Also verifies
 * that the gate imports the canonical required-jobs list instead of
 * duplicating it manually.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateDailyBriefingTruthGate,
  type DailyBriefingTruthGateResult,
} from "../../supabase/functions/_shared/dailyBriefingTruthGate.ts";
import { P29B3_REQUIRED_PHASE_JOB_KINDS } from "../../supabase/functions/_shared/dailyCyclePhaseJobs.ts";

const TODAY = "2026-05-07";
const USER = "00000000-0000-0000-0000-000000000001";
const CYCLE = "11111111-1111-1111-1111-111111111111";

interface FixtureCycle {
  id?: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
  context_data?: any;
}

function buildSb(opts: {
  cycle: FixtureCycle | null;
  jobs: Array<{
    job_kind: string;
    status: string;
    result?: any;
    error_message?: string | null;
  }>;
}) {
  return {
    from(table: string) {
      if (table === "did_update_cycles") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                gte: () => ({
                  lte: () => ({
                    order: () => ({
                      limit: () => ({
                        async maybeSingle() {
                          return {
                            data: opts.cycle
                              ? {
                                  id: CYCLE,
                                  status: "completed",
                                  started_at: `${TODAY}T05:00:00Z`,
                                  completed_at: `${TODAY}T05:05:00Z`,
                                  context_data: {
                                    daily_cycle_completion_semantics: {
                                      main_orchestrator_completed: true,
                                    },
                                  },
                                  ...opts.cycle,
                                }
                              : null,
                            error: null,
                          };
                        },
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "did_daily_cycle_phase_jobs") {
        return {
          select: () => ({
            async eq() {
              return { data: opts.jobs, error: null };
            },
          }),
        };
      }
      throw new Error("unexpected table " + table);
    },
  };
}

function fullyCompletedJobs() {
  return P29B3_REQUIRED_PHASE_JOB_KINDS.map((k) => ({
    job_kind: k,
    status: "completed",
    result: { ok: true },
    error_message: null,
  }));
}

async function evalGate(sb: any, extra: Partial<Parameters<typeof evaluateDailyBriefingTruthGate>[1]> = {}) {
  return evaluateDailyBriefingTruthGate(sb, {
    userId: USER,
    briefingDatePrague: TODAY,
    now: new Date(`${TODAY}T05:30:00Z`),
    ...extra,
  });
}

describe("P29C.1 daily briefing truth gate", () => {
  it("imports canonical required-jobs list, not a duplicated copy", () => {
    const src = readFileSync(
      resolve(__dirname, "../../supabase/functions/_shared/dailyBriefingTruthGate.ts"),
      "utf-8",
    );
    expect(src).toContain('from "./dailyCyclePhaseJobs.ts"');
    expect(src).toContain("P29B3_REQUIRED_PHASE_JOB_KINDS");
    // forbid manual literal job kind list duplication
    expect(src).not.toMatch(/\["phase4_centrum_tail"[\s,\n]+"phase4_card_profiling"/);
  });

  it("passes when cycle completed + all 14 required jobs terminal", async () => {
    const sb = buildSb({ cycle: {}, jobs: fullyCompletedJobs() });
    const r = await evalGate(sb);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("ready");
    expect(r.source_cycle_id).toBe(CYCLE);
    expect(r.distinct_required_jobs_count).toBe(P29B3_REQUIRED_PHASE_JOB_KINDS.length);
    expect(r.job_graph_snapshot.length).toBe(P29B3_REQUIRED_PHASE_JOB_KINDS.length);
  });

  it("fails when no daily cycle exists", async () => {
    const sb = buildSb({ cycle: null, jobs: [] });
    const r = await evalGate(sb);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("no_completed_daily_cycle");
  });

  it("fails when cycle still running", async () => {
    const sb = buildSb({ cycle: { status: "running" }, jobs: fullyCompletedJobs() });
    const r = await evalGate(sb);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("cycle_still_running");
  });

  it("fails when one required job is missing", async () => {
    const jobs = fullyCompletedJobs().slice(1);
    const sb = buildSb({ cycle: {}, jobs });
    const r = await evalGate(sb);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("required_jobs_missing");
    expect(r.missing_required_jobs).toContain(P29B3_REQUIRED_PHASE_JOB_KINDS[0]);
  });

  it("fails when a required job_kind is duplicated", async () => {
    const jobs = [...fullyCompletedJobs(), { ...fullyCompletedJobs()[0] }];
    const sb = buildSb({ cycle: {}, jobs });
    const r = await evalGate(sb);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("duplicate_required_jobs");
    expect(r.duplicate_required_jobs).toContain(P29B3_REQUIRED_PHASE_JOB_KINDS[0]);
  });

  it("fails when any required job is queued/running", async () => {
    const jobs = fullyCompletedJobs();
    jobs[0] = { ...jobs[0], status: "queued" };
    const sb = buildSb({ cycle: {}, jobs });
    const r = await evalGate(sb);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("required_jobs_not_terminal");
    expect(r.queued_jobs).toBe(1);
  });

  it("fails when any required job failed_permanent", async () => {
    const jobs = fullyCompletedJobs();
    jobs[0] = { ...jobs[0], status: "failed_permanent", error_message: "boom" };
    const sb = buildSb({ cycle: {}, jobs });
    const r = await evalGate(sb);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("required_job_failed");
    expect(r.failed_permanent_jobs).toBe(1);
  });

  it("fails when any required job failed_retry", async () => {
    const jobs = fullyCompletedJobs();
    jobs[0] = { ...jobs[0], status: "failed_retry", error_message: "transient" };
    const sb = buildSb({ cycle: {}, jobs });
    const r = await evalGate(sb);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("required_job_failed");
  });

  it("allows controlled_skipped only when result or reason exists", async () => {
    const jobsOk = fullyCompletedJobs();
    jobsOk[0] = { ...jobsOk[0], status: "controlled_skipped", result: {}, error_message: "reason_x" };
    const r1 = await evalGate(buildSb({ cycle: {}, jobs: jobsOk }));
    expect(r1.ok).toBe(true);

    const jobsBad = fullyCompletedJobs();
    jobsBad[0] = { ...jobsBad[0], status: "controlled_skipped", result: {}, error_message: null };
    const r2 = await evalGate(buildSb({ cycle: {}, jobs: jobsBad }));
    expect(r2.ok).toBe(false);
    expect(r2.status).toBe("required_job_failed");
  });

  it("flags briefing generated before cycle completion", async () => {
    const sb = buildSb({ cycle: {}, jobs: fullyCompletedJobs() });
    const r = await evalGate(sb, {
      briefingGeneratedAt: `${TODAY}T05:04:00Z`, // before completed_at 05:05
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("briefing_generated_before_cycle_completion");
  });

  it("returns a job graph snapshot the briefing payload can store", async () => {
    const sb = buildSb({ cycle: {}, jobs: fullyCompletedJobs() });
    const r = (await evalGate(sb)) as DailyBriefingTruthGateResult;
    expect(Array.isArray(r.job_graph_snapshot)).toBe(true);
    expect(r.job_graph_snapshot[0]).toHaveProperty("job_kind");
    expect(r.job_graph_snapshot[0]).toHaveProperty("status");
  });
});

describe("P29C.1 briefing function wires gate (static check)", () => {
  const briefingSrc = readFileSync(
    resolve(__dirname, "../../supabase/functions/karel-did-daily-briefing/index.ts"),
    "utf-8",
  );
  it("imports the truth gate helper", () => {
    expect(briefingSrc).toContain('from "../_shared/dailyBriefingTruthGate.ts"');
    expect(briefingSrc).toContain("evaluateDailyBriefingTruthGate");
  });
  it("blocks non-manual generation when gate fails", () => {
    expect(briefingSrc).toContain('generation_method: "truth_gate_blocked"');
    expect(briefingSrc).toContain("do_not_present_as_daily_ready");
  });
  it("stamps source_cycle_id and phase_jobs_snapshot into successful payloads", () => {
    expect(briefingSrc).toContain("payload.source_cycle_id = truthGateResult.source_cycle_id");
    expect(briefingSrc).toContain("payload.phase_jobs_snapshot = truthGateResult.job_graph_snapshot");
  });
  it("cached today briefing without truth gate is not considered ready", () => {
    expect(briefingSrc).toContain("cachedGateOk");
    expect(briefingSrc).toContain("cachedAfterCycle");
  });
});
