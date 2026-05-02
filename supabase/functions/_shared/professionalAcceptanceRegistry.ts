/**
 * P4: Professional Acceptance Registry — Deno mirror.
 *
 * IMPORTANT: This file MUST stay in sync with `src/lib/professionalAcceptanceRegistry.ts`.
 * It is intentionally pure TypeScript with zero imports so that it works
 * unchanged in Deno edge functions and Node/Vite frontend builds.
 */

export type CheckType =
  | "sql_check"
  | "dom_check"
  | "fixture_check"
  | "test_check"
  | "guard_check"
  | "rollback_check"
  | "deployment_check";

export type CheckStatus = "passed" | "failed" | "skipped" | "blocked";
export type RunStatus = "accepted" | "not_accepted" | "partial" | "blocked";

export interface AcceptanceCheck {
  id: string;
  label: string;
  type: CheckType;
  required: boolean;
  status: CheckStatus;
  observed?: unknown;
  expected?: string;
  message?: string;
  evidence_ref?: string;
}

export interface AcceptanceRun {
  pass_name: string;
  status: RunStatus;
  generated_at: string;
  checks: AcceptanceCheck[];
  failed_checks: AcceptanceCheck[];
  evidence: Record<string, unknown>;
  app_version?: string;
}

export function aggregateStatus(checks: readonly AcceptanceCheck[]): RunStatus {
  const required = checks.filter((c) => c.required);
  if (required.length === 0) return "not_accepted";
  if (required.some((c) => c.status === "blocked")) return "blocked";
  if (required.some((c) => c.status === "failed")) return "not_accepted";
  if (required.some((c) => c.status === "skipped")) return "partial";
  if (required.every((c) => c.status === "passed")) return "accepted";
  return "not_accepted";
}

export function failedChecks(checks: readonly AcceptanceCheck[]): AcceptanceCheck[] {
  return checks.filter((c) => c.required && (c.status === "failed" || c.status === "blocked"));
}

export function buildRun(
  pass_name: string,
  checks: AcceptanceCheck[],
  evidence: Record<string, unknown> = {},
  app_version?: string,
): AcceptanceRun {
  return {
    pass_name,
    status: aggregateStatus(checks),
    generated_at: new Date().toISOString(),
    checks,
    failed_checks: failedChecks(checks),
    evidence,
    app_version,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical check ID catalog — MUST stay in sync with frontend registry
// (src/lib/professionalAcceptanceRegistry.ts)
// ─────────────────────────────────────────────────────────────────────────────

export const P1_CHECK_IDS = {
  briefing_dom: "p1_briefing_dom_forbidden_count",
  herna_dom: "p1_herna_modal_dom_forbidden_count",
  team_delib_dom: "p1_team_deliberation_modal_forbidden_count",
  live_session_dom: "p1_live_session_dom_forbidden_count",
  visible_fields_dirty: "p1_visible_fields_dirty_count",
  required_all_true: "p1_required_all_true",
  tests_passed: "p1_tests_passed",
} as const;

export const P2P3_CHECK_IDS = {
  canonical_active_count: "p2_canonical_active_count",
  canonical_user_resolves: "p2_canonical_user_resolves",
  team_delib_orphan_fresh_7d: "p2_team_delib_orphan_fresh_7d",
  daily_plans_orphan_fresh_7d: "p2_daily_plans_orphan_fresh_7d",
  snapshot_rpc_exists: "p3_snapshot_rpc_exists",
  rollback_rpc_exists: "p3_rollback_rpc_exists",
  snapshots_table_exists: "p3_snapshots_table_exists",
  snapshots_total: "p3_snapshots_total",
  edge_helpers_present: "p2p3_edge_helpers_present",
  tests_passed: "p2p3_tests_passed",
} as const;
