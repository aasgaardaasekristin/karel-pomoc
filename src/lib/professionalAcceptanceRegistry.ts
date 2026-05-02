/**
 * P4: Professional Acceptance Registry (shared, frontend + edge)
 *
 * Pure type definitions and aggregation logic. NO runtime dependencies on
 * Supabase, Vitest, Deno, or DOM — usable from:
 *   - src/lib (frontend UI panel)
 *   - supabase/functions/_shared (mirrored copy)
 *   - scripts/professional-acceptance-runner.ts (CLI)
 *
 * The registry defines the canonical SHAPE of a check and a run, plus the
 * `aggregateStatus` rule used by every consumer to produce a verdict from
 * a check list. Consumers must NEVER hand-roll their own status logic.
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
  /** stable machine key, e.g. `p1_briefing_dom_forbidden_count` */
  id: string;
  /** short human label (Czech is fine) */
  label: string;
  type: CheckType;
  /** `true` => failure flips run to not_accepted; `false` => informational */
  required: boolean;
  status: CheckStatus;
  /** observed value for the check (number, boolean, string, …) */
  observed?: unknown;
  /** expected value/predicate description (e.g. `= 0`, `true`) */
  expected?: string;
  /** free-text reason when failed/blocked */
  message?: string;
  /** opaque pointer to evidence (sql query name, snapshot id, etc.) */
  evidence_ref?: string;
}

export interface AcceptanceRun {
  pass_name: string;
  status: RunStatus;
  generated_at: string; // ISO
  checks: AcceptanceCheck[];
  failed_checks: AcceptanceCheck[];
  evidence: Record<string, unknown>;
  app_version?: string;
}

/**
 * Single source of truth for run status.
 *
 * Rules:
 *  - any required check `blocked` => run = `blocked`
 *  - any required check `failed`  => run = `not_accepted`
 *  - all required checks `passed` AND no required `skipped` => `accepted`
 *  - all required checks `passed` but some required `skipped` => `partial`
 *  - if zero required checks exist => `not_accepted` (cannot prove anything)
 */
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
// Canonical check ID catalog (so UI labels and runner code never drift)
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

export const P6_CHECK_IDS = {
  slo_table_exists: "p6_slo_table_exists",
  pipelines_seeded_count: "p6_pipelines_seeded_count",
  pipelines_evaluated_recent: "p6_pipelines_evaluated_recent",
  not_implemented_explicit: "p6_not_implemented_explicit",
  no_silent_failures: "p6_no_silent_failures",
  drive_to_pantry_honest: "p6_drive_to_pantry_honest",
  acceptance_runner_pipeline_recent: "p6_acceptance_runner_pipeline_recent",
} as const;

export const P7_CHECK_IDS = {
  events_table_exists: "p7_events_table_exists",
  sensitivities_seeded_arthur: "p7_sensitivities_seeded_arthur",
  sensitivities_seeded_tundrupek: "p7_sensitivities_seeded_tundrupek",
  ingestion_path_works: "p7_ingestion_path_works",
  no_fake_internet_verification: "p7_no_fake_internet_verification",
  no_identity_confirmation_in_impacts: "p7_no_identity_confirmation_in_impacts",
  graphic_content_guarded: "p7_graphic_content_guarded",
  briefing_warning_integrated: "p7_briefing_warning_integrated",
  tasks_created_for_amber_red: "p7_tasks_created_for_amber_red",
} as const;
