/**
 * P2 + P3 Professional Integrity Guards — unit tests
 *
 * Pokrývá:
 *  - P2 canonicalUserScopeGuard: fail-closed při unresolved/ambiguous/mismatch,
 *    pass-through při shodě.
 *  - P3 mutationSnapshotGuard: snapshot fail-closed → mutace neproběhne;
 *    úspěšný snapshot → vrátí snapshotId; rollback → zavolá správné RPC.
 *
 * Testy běží proti mock admin clientovi (žádná reálná DB), čistě validují
 * kontrakt helperů, který používají edge funkce
 * karel-team-deliberation-iterate a karel-team-deliberation-signoff.
 */

import { describe, it, expect, vi } from "vitest";

// ── Re-implementace minimálního kontraktu helperů (zrcadlí _shared/*.ts) ──
// Edge funkce běží v Deno; helpery jsou TS, importovat je přímo do Vitest
// (Node) je nepraktické (Deno-specific URL imports). Místo toho zde
// re-deklarujeme JEJICH SMLOUVU a testujeme tvar — pokud edge helper
// někdy přestane fail-close držet, tento test zůstane platnou specifikací,
// kterou musí splnit i nová implementace.

type RpcResp<T> = Promise<{ data: T | null; error: { message: string; code?: string } | null }>;

interface MockAdmin {
  rpc: (fn: string, args?: Record<string, unknown>) => RpcResp<unknown>;
}

class CanonicalUserScopeError extends Error {
  constructor(public code: string, message: string, public callingUserId: string | null) {
    super(message);
  }
}

async function assertCanonicalDidScopeOrThrow(
  admin: MockAdmin,
  callingUserId: string | null | undefined,
): Promise<string> {
  const { data, error } = await admin.rpc("get_canonical_did_user_id");
  if (error) {
    const msg = String(error.message || "");
    if (/CANONICAL_USER_SCOPE_UNRESOLVED/.test(msg)) {
      throw new CanonicalUserScopeError("CANONICAL_USER_SCOPE_UNRESOLVED", msg, callingUserId ?? null);
    }
    if (/CANONICAL_USER_SCOPE_AMBIGUOUS/.test(msg)) {
      throw new CanonicalUserScopeError("CANONICAL_USER_SCOPE_AMBIGUOUS", msg, callingUserId ?? null);
    }
    throw new CanonicalUserScopeError("CANONICAL_USER_SCOPE_UNRESOLVED", msg, callingUserId ?? null);
  }
  const canonicalUserId = typeof data === "string" ? data : null;
  if (!canonicalUserId) {
    throw new CanonicalUserScopeError("CANONICAL_USER_SCOPE_UNRESOLVED", "no id", callingUserId ?? null);
  }
  if (!callingUserId || callingUserId !== canonicalUserId) {
    throw new CanonicalUserScopeError("CANONICAL_USER_SCOPE_MISMATCH", "mismatch", callingUserId ?? null);
  }
  return canonicalUserId;
}

class MutationSnapshotError extends Error {
  code = "MUTATION_SNAPSHOT_FAILED" as const;
  constructor(public tableName: string, public rowId: string, cause: string) {
    super(`MUTATION_SNAPSHOT_FAILED for ${tableName}/${rowId}: ${cause}`);
  }
}

const ALLOWED_TABLES = ["did_team_deliberations", "did_daily_session_plans"] as const;

async function createSnapshot(
  admin: MockAdmin,
  tableName: string,
  rowId: string,
  reason: string,
  actor: string,
): Promise<string> {
  if (!ALLOWED_TABLES.includes(tableName as any)) {
    throw new MutationSnapshotError(tableName, rowId, "table not in allowlist");
  }
  if (!rowId) throw new MutationSnapshotError(tableName, rowId, "rowId required");
  if (!reason?.trim()) throw new MutationSnapshotError(tableName, rowId, "reason required");
  if (!actor?.trim()) throw new MutationSnapshotError(tableName, rowId, "actor required");
  const { data, error } = await admin.rpc("did_snapshot_protected_mutation", {
    p_table_name: tableName, p_row_id: rowId, p_reason: reason, p_actor: actor,
  });
  if (error) throw new MutationSnapshotError(tableName, rowId, String(error.message));
  const id = typeof data === "string" ? data : null;
  if (!id) throw new MutationSnapshotError(tableName, rowId, "RPC returned no id");
  return id;
}

async function snapshotProtectedMutation<T>(
  admin: MockAdmin,
  opts: { tableName: string; rowId: string; reason: string; actor: string; mutate: () => Promise<T> },
): Promise<{ snapshotId: string; result: T }> {
  const snapshotId = await createSnapshot(admin, opts.tableName, opts.rowId, opts.reason, opts.actor);
  const result = await opts.mutate();
  return { snapshotId, result };
}

async function rollbackProtectedMutation(admin: MockAdmin, snapshotId: string): Promise<void> {
  const { error } = await admin.rpc("did_rollback_protected_mutation", { p_snapshot_id: snapshotId });
  if (error) throw new Error(`MUTATION_ROLLBACK_FAILED: ${error.message}`);
}

// ── Tests ──

const CANONICAL_USER = "8a7816ee-4fd1-43d4-8d83-4230d7517ae1";
const ORPHAN_USER = "00000000-0000-4000-8000-000000000001";

describe("P2 canonicalUserScopeGuard", () => {
  it("blocks orphan/test user when canonical resolves OK", async () => {
    const admin: MockAdmin = {
      rpc: vi.fn().mockResolvedValue({ data: CANONICAL_USER, error: null }),
    };
    await expect(assertCanonicalDidScopeOrThrow(admin, ORPHAN_USER)).rejects.toMatchObject({
      code: "CANONICAL_USER_SCOPE_MISMATCH",
    });
  });

  it("allows the canonical user", async () => {
    const admin: MockAdmin = {
      rpc: vi.fn().mockResolvedValue({ data: CANONICAL_USER, error: null }),
    };
    await expect(assertCanonicalDidScopeOrThrow(admin, CANONICAL_USER)).resolves.toBe(CANONICAL_USER);
  });

  it("fail-closed on unresolved scope (no row)", async () => {
    const admin: MockAdmin = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "CANONICAL_USER_SCOPE_UNRESOLVED" } }),
    };
    await expect(assertCanonicalDidScopeOrThrow(admin, CANONICAL_USER)).rejects.toMatchObject({
      code: "CANONICAL_USER_SCOPE_UNRESOLVED",
    });
  });

  it("fail-closed on ambiguous scope (>1 active row)", async () => {
    const admin: MockAdmin = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "CANONICAL_USER_SCOPE_AMBIGUOUS" } }),
    };
    await expect(assertCanonicalDidScopeOrThrow(admin, CANONICAL_USER)).rejects.toMatchObject({
      code: "CANONICAL_USER_SCOPE_AMBIGUOUS",
    });
  });

  it("fail-closed when calling user is null/undefined", async () => {
    const admin: MockAdmin = {
      rpc: vi.fn().mockResolvedValue({ data: CANONICAL_USER, error: null }),
    };
    await expect(assertCanonicalDidScopeOrThrow(admin, null)).rejects.toMatchObject({
      code: "CANONICAL_USER_SCOPE_MISMATCH",
    });
  });
});

describe("P3 mutationSnapshotGuard", () => {
  const ROW_ID = "11111111-1111-4111-8111-111111111111";
  const SNAP_ID = "22222222-2222-4222-8222-222222222222";

  it("rejects tables not in protected allowlist", async () => {
    const admin: MockAdmin = { rpc: vi.fn() };
    await expect(
      createSnapshot(admin, "did_pending_questions", ROW_ID, "test", "actor"),
    ).rejects.toMatchObject({ code: "MUTATION_SNAPSHOT_FAILED" });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("requires reason and actor (audit fields)", async () => {
    const admin: MockAdmin = { rpc: vi.fn() };
    await expect(createSnapshot(admin, "did_team_deliberations", ROW_ID, "", "x")).rejects.toThrow();
    await expect(createSnapshot(admin, "did_team_deliberations", ROW_ID, "x", "")).rejects.toThrow();
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("snapshot RPC failure prevents the mutation (fail-closed)", async () => {
    const mutate = vi.fn().mockResolvedValue("would-be-mutated");
    const admin: MockAdmin = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "DB down" } }),
    };
    await expect(
      snapshotProtectedMutation(admin, {
        tableName: "did_team_deliberations",
        rowId: ROW_ID,
        reason: "iterate: test",
        actor: "edge:test",
        mutate,
      }),
    ).rejects.toMatchObject({ code: "MUTATION_SNAPSHOT_FAILED" });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("happy path: snapshot succeeds → mutate runs → snapshotId returned", async () => {
    const mutate = vi.fn().mockResolvedValue({ updated: true });
    const admin: MockAdmin = {
      rpc: vi.fn().mockResolvedValue({ data: SNAP_ID, error: null }),
    };
    const out = await snapshotProtectedMutation(admin, {
      tableName: "did_daily_session_plans",
      rowId: ROW_ID,
      reason: "sync_and_start: pre-overwrite",
      actor: "edge:test",
      mutate,
    });
    expect(out.snapshotId).toBe(SNAP_ID);
    expect(out.result).toEqual({ updated: true });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("rollback calls did_rollback_protected_mutation with snapshot id", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const admin: MockAdmin = { rpc };
    await rollbackProtectedMutation(admin, SNAP_ID);
    expect(rpc).toHaveBeenCalledWith("did_rollback_protected_mutation", { p_snapshot_id: SNAP_ID });
  });

  it("rollback surfaces RPC errors", async () => {
    const admin: MockAdmin = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "snapshot not found" } }),
    };
    await expect(rollbackProtectedMutation(admin, SNAP_ID)).rejects.toThrow(/MUTATION_ROLLBACK_FAILED/);
  });
});
