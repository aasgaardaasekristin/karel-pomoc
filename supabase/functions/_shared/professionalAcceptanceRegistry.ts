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
