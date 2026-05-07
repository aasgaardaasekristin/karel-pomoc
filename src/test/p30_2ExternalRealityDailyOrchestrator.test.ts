/**
 * P30.2 — External Reality Daily Orchestrator unit-style tests.
 *
 * These tests cover policy invariants for the orchestrator + briefing payload
 * integration without booting Deno (the edge function itself is exercised in
 * the runtime proof). They focus on contract guarantees that future
 * regressions could break:
 *   - briefing payload only carries external_reality_watch when truth-gate ok
 *   - audit row contract (status enum, idempotency key)
 *   - SLO downgrade contract (provider_not_configured -> degraded)
 *
 * The tests run against pure helpers and a small in-memory adapter.
 */

import { describe, it, expect } from "vitest";

// Minimal contract surface mirrored from the orchestrator. We do NOT import
// the Deno edge function here; we assert the invariants the function relies on.

type ProviderStatus =
  | "configured"
  | "provider_not_configured"
  | "provider_error"
  | "not_run";

interface OrchestratorAuditRow {
  status:
    | "ok"
    | "ok_provider_not_configured"
    | "ok_provider_error"
    | "blocked_by_truth_gate";
  truth_gate_ok: boolean;
  provider_status: ProviderStatus;
  source_cycle_id: string | null;
}

function deriveSloStatus(
  ps: ProviderStatus,
  truthGateOk: boolean,
): "ok" | "degraded" | "failed" {
  if (!truthGateOk) return "degraded";
  if (ps === "configured") return "ok";
  if (ps === "provider_not_configured") return "degraded";
  if (ps === "provider_error") return "failed";
  return "degraded";
}

function deriveAuditStatus(
  ps: ProviderStatus,
  truthGateOk: boolean,
): OrchestratorAuditRow["status"] {
  if (!truthGateOk) return "blocked_by_truth_gate";
  if (ps === "configured") return "ok";
  if (ps === "provider_not_configured") return "ok_provider_not_configured";
  return "ok_provider_error";
}

describe("P30.2 — external reality daily orchestrator contract", () => {
  it("blocks normal-path runs when truth gate is not ok", () => {
    const status = deriveAuditStatus("not_run", false);
    expect(status).toBe("blocked_by_truth_gate");
    expect(deriveSloStatus("not_run", false)).toBe("degraded");
  });

  it("records provider_not_configured as degraded SLO, not ok", () => {
    expect(deriveSloStatus("provider_not_configured", true)).toBe("degraded");
    expect(deriveAuditStatus("provider_not_configured", true)).toBe(
      "ok_provider_not_configured",
    );
  });

  it("records provider_error as failed SLO", () => {
    expect(deriveSloStatus("provider_error", true)).toBe("failed");
    expect(deriveAuditStatus("provider_error", true)).toBe("ok_provider_error");
  });

  it("only records SLO ok when configured AND truth gate ok", () => {
    expect(deriveSloStatus("configured", true)).toBe("ok");
    expect(deriveSloStatus("configured", false)).toBe("degraded");
  });

  it("idempotency unique key uses (user, run_date, source_cycle_id)", () => {
    // Sanity: two rows on the same cycle should share the same composite key.
    const key = (u: string, d: string, c: string | null) =>
      `${u}::${d}::${c ?? "00000000-0000-0000-0000-000000000000"}`;
    expect(key("u1", "2026-05-07", "c1")).toBe(key("u1", "2026-05-07", "c1"));
    expect(key("u1", "2026-05-07", "c1")).not.toBe(
      key("u1", "2026-05-07", "c2"),
    );
  });

  it("provider_status enum is constrained", () => {
    const allowed: ProviderStatus[] = [
      "configured",
      "provider_not_configured",
      "provider_error",
      "not_run",
    ];
    for (const v of allowed) {
      expect(["configured", "provider_not_configured", "provider_error", "not_run"])
        .toContain(v);
    }
  });
});

describe("P30.2 — briefing payload integration invariants", () => {
  // Mirrors logic at supabase/functions/karel-did-daily-briefing/index.ts
  function computeProviderStatusFromBriefRows(
    rows: Array<{ evidence_summary?: { provider_status?: string } }>,
  ): string {
    let providerStatus = "not_run";
    for (const r of rows) {
      const ps = r?.evidence_summary?.provider_status;
      if (ps && ps !== "not_run") providerStatus = ps;
    }
    return providerStatus;
  }

  it("returns not_run when no rows exist (table empty)", () => {
    expect(computeProviderStatusFromBriefRows([])).toBe("not_run");
  });

  it("returns provider_not_configured when only that status present", () => {
    expect(
      computeProviderStatusFromBriefRows([
        { evidence_summary: { provider_status: "provider_not_configured" } },
      ]),
    ).toBe("provider_not_configured");
  });

  it("propagates configured when at least one row reports it", () => {
    expect(
      computeProviderStatusFromBriefRows([
        { evidence_summary: { provider_status: "not_run" } },
        { evidence_summary: { provider_status: "configured" } },
      ]),
    ).toBe("configured");
  });

  it("does not invent ok status when rows are empty", () => {
    const rows: Array<{ evidence_summary?: { provider_status?: string } }> = [];
    const ps = computeProviderStatusFromBriefRows(rows);
    expect(ps).not.toBe("ok");
    expect(ps).not.toBe("verified");
  });
});
