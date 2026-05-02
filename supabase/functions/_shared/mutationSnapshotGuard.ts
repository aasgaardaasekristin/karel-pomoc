/**
 * P3: mutationSnapshotGuard (TS edge helper)
 *
 * Wraps a destructive mutation on did_team_deliberations or
 * did_daily_session_plans with a before-image snapshot. Snapshot creation
 * is delegated to the SECURITY DEFINER SQL function
 * `did_snapshot_protected_mutation`.
 *
 * Behavior:
 *   - If the snapshot RPC fails -> mutationSnapshotGuard throws and the
 *     caller MUST NOT perform the mutation (fail-closed).
 *   - If the mutation throws -> caller can use the returned snapshotId to
 *     run did_rollback_protected_mutation.
 *
 * Allowlisted tables (this pass):
 *   - did_team_deliberations
 *   - did_daily_session_plans
 *
 * Usage:
 *
 *   const { snapshotId, result } = await snapshotProtectedMutation(admin, {
 *     tableName: "did_team_deliberations",
 *     rowId: delib.id,
 *     reason: "iterate: external_current_event_replan",
 *     actor: "edge:karel-team-deliberation-iterate",
 *     mutate: async () => {
 *       const { data, error } = await admin.from("did_team_deliberations")...;
 *       if (error) throw error;
 *       return data;
 *     },
 *   });
 */

import type { AdminClientLike } from "./canonicalUserScopeGuard.ts";

export type ProtectedTable = "did_team_deliberations" | "did_daily_session_plans";

export class MutationSnapshotError extends Error {
  public readonly code = "MUTATION_SNAPSHOT_FAILED" as const;
  public readonly tableName: ProtectedTable;
  public readonly rowId: string;
  constructor(tableName: ProtectedTable, rowId: string, cause: string) {
    super(`MUTATION_SNAPSHOT_FAILED for ${tableName}/${rowId}: ${cause}`);
    this.tableName = tableName;
    this.rowId = rowId;
  }
}

export type SnapshotProtectedMutationOptions<T> = {
  tableName: ProtectedTable;
  rowId: string;
  reason: string;
  actor: string;
  /**
   * The destructive mutation to run AFTER the snapshot succeeds.
   * If it throws, the snapshotId is returned so the caller can roll back.
   */
  mutate: () => Promise<T>;
};

export type SnapshotProtectedMutationResult<T> = {
  snapshotId: string;
  result: T;
};

export async function createSnapshot(
  admin: AdminClientLike,
  tableName: ProtectedTable,
  rowId: string,
  reason: string,
  actor: string,
): Promise<string> {
  if (tableName !== "did_team_deliberations" && tableName !== "did_daily_session_plans") {
    throw new MutationSnapshotError(tableName, rowId, `table ${tableName} not in protected allowlist`);
  }
  if (!rowId) {
    throw new MutationSnapshotError(tableName, rowId, "rowId is required");
  }
  if (!reason || !reason.trim()) {
    throw new MutationSnapshotError(tableName, rowId, "reason is required (audit)");
  }
  if (!actor || !actor.trim()) {
    throw new MutationSnapshotError(tableName, rowId, "actor is required (audit)");
  }

  const { data, error } = await admin.rpc("did_snapshot_protected_mutation", {
    p_table_name: tableName,
    p_row_id: rowId,
    p_reason: reason,
    p_actor: actor,
  });
  if (error) {
    throw new MutationSnapshotError(tableName, rowId, String(error.message || error));
  }
  const snapshotId = typeof data === "string" ? data : null;
  if (!snapshotId) {
    throw new MutationSnapshotError(tableName, rowId, "snapshot RPC returned no id");
  }
  return snapshotId;
}

/**
 * Snapshot-then-mutate. Snapshot fail -> throws BEFORE mutation runs.
 */
export async function snapshotProtectedMutation<T>(
  admin: AdminClientLike,
  opts: SnapshotProtectedMutationOptions<T>,
): Promise<SnapshotProtectedMutationResult<T>> {
  const snapshotId = await createSnapshot(admin, opts.tableName, opts.rowId, opts.reason, opts.actor);
  const result = await opts.mutate();
  return { snapshotId, result };
}

/**
 * Roll back a previously taken snapshot via SECURITY DEFINER SQL helper.
 */
export async function rollbackProtectedMutation(
  admin: AdminClientLike,
  snapshotId: string,
): Promise<void> {
  const { error } = await admin.rpc("did_rollback_protected_mutation", {
    p_snapshot_id: snapshotId,
  });
  if (error) {
    throw new Error(`MUTATION_ROLLBACK_FAILED: ${error.message}`);
  }
}
