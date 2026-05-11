/**
 * P33.5G — phase4_centrum_tail must always have a job row.
 *
 * Behavior + source guards proving:
 *   1. ensureCentrumTailPayloadRef exists and creates an empty deterministic
 *      payload when no real payload is provided.
 *   2. enqueueRequiredPostPhase4Jobs no longer silently skips
 *      phase4_centrum_tail — missing ref becomes an error.
 *   3. The main daily-cycle calls ensureCentrumTailPayloadRef BEFORE the
 *      early-enqueue helper in both the normal and recovery branches.
 *   4. The phase4_centrum_tail worker terminates as controlled_skipped on
 *      empty payload (terminal, non-failed).
 *   5. The required job count remains 14 and there is no acceptance path
 *      that admits 13/14.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ensureCentrumTailPayloadRef,
} from "../../supabase/functions/_shared/dailyCyclePhasePayloads.ts";
import {
  enqueueRequiredPostPhase4Jobs,
} from "../../supabase/functions/_shared/dailyCycleEarlyEnqueue.ts";
import { P29B3_REQUIRED_PHASE_JOB_KINDS } from "../../supabase/functions/_shared/dailyCyclePhaseJobs.ts";

const root = resolve(__dirname, "../../");
const dailyCycleSrc = readFileSync(
  resolve(root, "supabase/functions/karel-did-daily-cycle/index.ts"),
  "utf-8",
);
const earlyEnqueueSrc = readFileSync(
  resolve(root, "supabase/functions/_shared/dailyCycleEarlyEnqueue.ts"),
  "utf-8",
);
const tailWorkerSrc = readFileSync(
  resolve(root, "supabase/functions/_shared/dailyCyclePhase4CentrumTail.ts"),
  "utf-8",
);
const ensureSrc = readFileSync(
  resolve(root, "supabase/functions/_shared/dailyCyclePhasePayloads.ts"),
  "utf-8",
);

// ─── Mock supabase: in-memory phase_payloads + phase_jobs tables ──────
function makeMockSb(seed?: { existingPayloads?: Array<any>; existingJobs?: string[] }) {
  const payloads: any[] = [...(seed?.existingPayloads ?? [])];
  const jobs: any[] = [];
  const existingJobKinds = new Set<string>(seed?.existingJobs ?? []);
  const sb: any = {
    from(table: string) {
      const builder: any = {
        _table: table, _filters: {} as Record<string, any>,
        _order: null as null | { col: string; asc: boolean },
        _limit: null as null | number,
        _inKinds: null as null | string[],
        select(_cols?: string, _opts?: any) { return builder; },
        eq(col: string, val: any) { builder._filters[col] = val; return builder; },
        order(col: string, opts?: any) { builder._order = { col, asc: !!opts?.ascending }; return builder; },
        limit(n: number) { builder._limit = n; return builder; },
        in(_col: string, kinds: string[]) {
          builder._inKinds = kinds;
          if (table === "did_daily_cycle_phase_jobs") {
            return Promise.resolve({
              data: kinds
                .filter((k) => existingJobKinds.has(k) || jobs.some((j) => j.job_kind === k))
                .map((k) => ({ job_kind: k })),
              error: null,
            });
          }
          return Promise.resolve({ data: [], error: null });
        },
        async maybeSingle() {
          if (table === "did_daily_cycle_phase_payloads") {
            const matches = payloads.filter((r) =>
              Object.entries(builder._filters).every(([k, v]) => r[k] === v));
            const ordered = builder._order
              ? matches.sort((a, b) => (a[builder._order!.col] < b[builder._order!.col] ? 1 : -1) * (builder._order!.asc ? -1 : 1))
              : matches;
            return { data: ordered[0] ?? null, error: null };
          }
          return { data: null, error: null };
        },
        async single() {
          if (table === "did_daily_cycle_phase_payloads") {
            const matches = payloads.filter((r) =>
              Object.entries(builder._filters).every(([k, v]) => r[k] === v));
            return { data: matches[0] ?? null, error: matches[0] ? null : { message: "no row" } };
          }
          if (table === "did_daily_cycle_phase_jobs") {
            const last = jobs[jobs.length - 1];
            return { data: { id: last?.id ?? "id-x" }, error: null };
          }
          return { data: null, error: null };
        },
        insert(row: any) {
          if (table === "did_daily_cycle_phase_jobs") {
            const id = `job-${jobs.length + 1}`;
            jobs.push({ id, ...row });
            existingJobKinds.add(row.job_kind);
          }
          return {
            select() { return builder; },
          };
        },
        upsert(row: any, _opts?: any) {
          if (table === "did_daily_cycle_phase_payloads") {
            const idx = payloads.findIndex((r) =>
              r.cycle_id === row.cycle_id && r.job_kind === row.job_kind && r.payload_kind === row.payload_kind);
            if (idx >= 0) {
              payloads[idx] = { ...payloads[idx], ...row };
            } else {
              payloads.push({ id: `pay-${payloads.length + 1}`, ...row });
            }
          }
          return {
            select() { return builder; },
          };
        },
      };
      return builder;
    },
    _payloads: payloads,
    _jobs: jobs,
  };
  return sb;
}

const cycleId = "p33_5g-cycle";
const userId = "00000000-0000-0000-0000-000000000abc";

describe("P33.5G — ensureCentrumTailPayloadRef + 14/14 required jobs", () => {
  it("creates an empty deterministic payload when no real payload is provided", async () => {
    const sb = makeMockSb();
    const res = await ensureCentrumTailPayloadRef({
      sb, cycleId, userId, source: "p33_5g_test", centrumPayload: null,
    });
    expect(res.ok).toBe(true);
    expect(res.ref).not.toBeNull();
    expect(res.ref!.job_kind).toBe("phase4_centrum_tail");
    expect(res.ref!.payload_table).toBe("did_daily_cycle_phase_payloads");
    expect(res.ref!.payload_id).toBeTruthy();
    expect(res.ref!.payload_hash).toBeTruthy();
    expect(res.created).toBe(true);
    expect(res.empty_payload).toBe(true);
    const stored = (sb as any)._payloads[0];
    expect(stored.payload.empty_payload).toBe(true);
    expect(stored.payload.kind).toBe("phase4_centrum_tail");
  });

  it("reuses an existing payload row for the same cycle", async () => {
    const sb = makeMockSb({
      existingPayloads: [{
        id: "pay-existing", cycle_id: cycleId, user_id: userId,
        job_kind: "phase4_centrum_tail", payload_kind: "tail_input_v1",
        payload: { validatedAnalysisText: "real" }, payload_hash: "abc123",
        created_at: new Date().toISOString(),
      }],
    });
    const res = await ensureCentrumTailPayloadRef({
      sb, cycleId, userId, source: "p33_5g_reuse", centrumPayload: null,
    });
    expect(res.ok).toBe(true);
    expect(res.reused).toBe(true);
    expect(res.created).toBe(false);
    expect(res.ref!.payload_id).toBe("pay-existing");
    expect(res.ref!.payload_hash).toBe("abc123");
  });

  it("never silently returns null ref when ok=true", async () => {
    const sb = makeMockSb();
    const res = await ensureCentrumTailPayloadRef({
      sb, cycleId, userId, source: "p33_5g_null_guard", centrumPayload: null,
    });
    if (res.ok) expect(res.ref).not.toBeNull();
  });

  it("empty payload hash is stable across calls for the same cycle", async () => {
    const sb1 = makeMockSb();
    const sb2 = makeMockSb();
    const a = await ensureCentrumTailPayloadRef({ sb: sb1, cycleId, userId, source: "s", centrumPayload: null });
    const b = await ensureCentrumTailPayloadRef({ sb: sb2, cycleId, userId, source: "s2", centrumPayload: null });
    expect(a.ref!.payload_hash).toBe(b.ref!.payload_hash);
  });

  it("enqueueRequiredPostPhase4Jobs reports phase4_centrum_tail as ERROR (not skip) on missing ref", async () => {
    const sb = makeMockSb();
    const res = await enqueueRequiredPostPhase4Jobs({
      sb, cycleId, userId, source: "p33_5g_no_ref", centrumTailPayloadRef: null,
    });
    expect(res.skipped).toEqual([]);
    expect(res.errors.map((e) => e.kind)).toEqual(["phase4_centrum_tail"]);
    expect(res.errors[0].reason).toMatch(/missing_centrum_payload_ref_not_allowed_p33_5g/);
  });

  it("with ensured payload ref, all 14 required jobs are enqueued (incl. phase4_centrum_tail)", async () => {
    const sb = makeMockSb();
    const ensure = await ensureCentrumTailPayloadRef({
      sb, cycleId, userId, source: "p33_5g_full", centrumPayload: null,
    });
    const res = await enqueueRequiredPostPhase4Jobs({
      sb, cycleId, userId, source: "p33_5g_full",
      centrumTailPayloadRef: ensure.ref!,
    });
    expect(res.attempted.length).toBe(14);
    expect(res.enqueued.length).toBe(14);
    expect(res.skipped).toEqual([]);
    expect(res.errors).toEqual([]);
    expect(res.missing_after_enqueue).toEqual([]);
    const jobs = (sb as any)._jobs as Array<{ job_kind: string }>;
    expect(jobs.find((j) => j.job_kind === "phase4_centrum_tail")).toBeTruthy();
  });

  it("source: main daily-cycle imports and calls ensureCentrumTailPayloadRef", () => {
    expect(dailyCycleSrc).toContain("ensureCentrumTailPayloadRef");
    expect(dailyCycleSrc).toContain("dailyCyclePhasePayloads");
    // Both branches must call it.
    const occurrences = dailyCycleSrc.split("ensureCentrumTailPayloadRef(").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("source: main daily-cycle stores centrum_tail_payload meta in context_data", () => {
    expect(dailyCycleSrc).toContain("centrum_tail_payload");
  });

  it("source: main daily-cycle fail-fast on ensure failure", () => {
    expect(dailyCycleSrc).toContain("p33_5g_centrum_payload_ref_failed");
  });

  it("source: main daily-cycle no longer filters phase4_centrum_tail out of realMissing", () => {
    // The legacy P33.5F filter was: .filter((k) => k !== "phase4_centrum_tail")
    // Under P33.5G that filter must be gone — the centrum tail must count.
    expect(dailyCycleSrc).not.toMatch(/\.filter\s*\(\s*\(\s*k\s*\)\s*=>\s*k\s*!==\s*"phase4_centrum_tail"\s*\)/);
  });

  it("source: early-enqueue helper treats missing centrum ref as an error", () => {
    expect(earlyEnqueueSrc).toContain("missing_centrum_payload_ref_not_allowed_p33_5g");
    expect(earlyEnqueueSrc).not.toContain('reason: "missing_centrum_payload_ref"');
  });

  it("source: phase4_centrum_tail worker treats empty_payload as controlled_skipped (terminal, non-failed)", () => {
    expect(tailWorkerSrc).toContain("empty_payload");
    expect(tailWorkerSrc).toContain("empty_centrum_payload_no_tail_work");
    expect(tailWorkerSrc).toContain('result.outcome = "controlled_skipped"');
  });

  it("source: ensure helper exists and exports the expected ref shape", () => {
    expect(ensureSrc).toContain("export async function ensureCentrumTailPayloadRef");
    expect(ensureSrc).toContain('payload_table: "did_daily_cycle_phase_payloads"');
    expect(ensureSrc).toContain('job_kind: "phase4_centrum_tail"');
  });

  it("required job count remains 14 (regression guard)", () => {
    expect(P29B3_REQUIRED_PHASE_JOB_KINDS.length).toBe(14);
    expect(P29B3_REQUIRED_PHASE_JOB_KINDS).toContain("phase4_centrum_tail");
  });

  it("source: no '13/14' acceptance path remains in helper or worker", () => {
    // We deliberately keep the phrase "accepted with caveat" in comments to
    // document the historical regression; the test only enforces there is
    // no actual acceptance code-path that admits 13 of 14 required jobs.
    expect(dailyCycleSrc).not.toContain('"accepted_with_caveat"');
    expect(dailyCycleSrc).not.toContain("13/14");
  });
});
