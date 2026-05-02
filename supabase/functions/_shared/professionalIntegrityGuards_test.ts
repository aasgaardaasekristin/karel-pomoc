/**
 * P2 + P3 Professional Integrity Guards — Deno production helper tests.
 *
 * IMPORTUJE skutečné helpery (žádné lokální kopie):
 *   - ./canonicalUserScopeGuard.ts
 *   - ./mutationSnapshotGuard.ts
 *
 * Mockujeme jen Supabase admin client (RPC vrstvu) — implementaci guardů NE.
 *
 * Spuštění:
 *   deno test --allow-net --allow-env supabase/functions/_shared/professionalIntegrityGuards_test.ts
 */

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  assertCanonicalDidScopeOrThrow,
  CanonicalUserScopeError,
  type AdminClientLike,
} from "./canonicalUserScopeGuard.ts";

import {
  createSnapshot,
  snapshotProtectedMutation,
  rollbackProtectedMutation,
  MutationSnapshotError,
} from "./mutationSnapshotGuard.ts";

const CANONICAL = "8a7816ee-4fd1-43d4-8d83-4230d7517ae1";
const ORPHAN = "00000000-0000-4000-8000-000000000001";
const ROW_ID = "11111111-1111-4111-8111-111111111111";
const SNAP_ID = "22222222-2222-4222-8222-222222222222";

function makeAdmin(
  rpcImpl: (fn: string, args?: Record<string, unknown>) =>
    Promise<{ data: unknown; error: { message: string; code?: string } | null }>,
): AdminClientLike {
  return { rpc: rpcImpl };
}

// ───────── P2 canonicalUserScopeGuard ─────────

Deno.test("P2: canonical user is allowed", async () => {
  const admin = makeAdmin(async () => ({ data: CANONICAL, error: null }));
  const id = await assertCanonicalDidScopeOrThrow(admin, CANONICAL);
  assertEquals(id, CANONICAL);
});

Deno.test("P2: orphan/test user is blocked with MISMATCH", async () => {
  const admin = makeAdmin(async () => ({ data: CANONICAL, error: null }));
  await assertRejects(
    () => assertCanonicalDidScopeOrThrow(admin, ORPHAN),
    CanonicalUserScopeError,
    "not the canonical",
  );
});

Deno.test("P2: unresolved scope fails closed", async () => {
  const admin = makeAdmin(async () => ({
    data: null,
    error: { message: "CANONICAL_USER_SCOPE_UNRESOLVED" },
  }));
  const err = await assertRejects(
    () => assertCanonicalDidScopeOrThrow(admin, CANONICAL),
    CanonicalUserScopeError,
  );
  assertEquals(err.code, "CANONICAL_USER_SCOPE_UNRESOLVED");
});

Deno.test("P2: ambiguous scope fails closed", async () => {
  const admin = makeAdmin(async () => ({
    data: null,
    error: { message: "CANONICAL_USER_SCOPE_AMBIGUOUS" },
  }));
  const err = await assertRejects(
    () => assertCanonicalDidScopeOrThrow(admin, CANONICAL),
    CanonicalUserScopeError,
  );
  assertEquals(err.code, "CANONICAL_USER_SCOPE_AMBIGUOUS");
});

Deno.test("P2: null caller fails closed", async () => {
  const admin = makeAdmin(async () => ({ data: CANONICAL, error: null }));
  await assertRejects(
    () => assertCanonicalDidScopeOrThrow(admin, null),
    CanonicalUserScopeError,
  );
});

// ───────── P3 mutationSnapshotGuard ─────────

Deno.test("P3: protected table allowed (snapshot RPC called)", async () => {
  let captured: Record<string, unknown> | undefined;
  const admin = makeAdmin(async (fn, args) => {
    assertEquals(fn, "did_snapshot_protected_mutation");
    captured = args;
    return { data: SNAP_ID, error: null };
  });
  const id = await createSnapshot(admin, "did_team_deliberations", ROW_ID, "test", "actor");
  assertEquals(id, SNAP_ID);
  assertEquals(captured?.p_table_name, "did_team_deliberations");
  assertEquals(captured?.p_row_id, ROW_ID);
});

Deno.test("P3: non-protected table is rejected (no RPC call)", async () => {
  let called = false;
  const admin = makeAdmin(async () => {
    called = true;
    return { data: null, error: null };
  });
  await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => createSnapshot(admin, "did_pending_questions" as any, ROW_ID, "x", "y"),
    MutationSnapshotError,
  );
  assertEquals(called, false);
});

Deno.test("P3: snapshot RPC failure prevents mutation", async () => {
  let mutated = false;
  const admin = makeAdmin(async () => ({ data: null, error: { message: "DB down" } }));
  await assertRejects(
    () =>
      snapshotProtectedMutation(admin, {
        tableName: "did_team_deliberations",
        rowId: ROW_ID,
        reason: "iterate: test",
        actor: "edge:test",
        mutate: async () => {
          mutated = true;
          return "x";
        },
      }),
    MutationSnapshotError,
  );
  assertEquals(mutated, false);
});

Deno.test("P3: happy path — snapshot then mutate", async () => {
  const admin = makeAdmin(async () => ({ data: SNAP_ID, error: null }));
  const out = await snapshotProtectedMutation(admin, {
    tableName: "did_daily_session_plans",
    rowId: ROW_ID,
    reason: "sync_and_start",
    actor: "edge:test",
    mutate: async () => ({ updated: true }),
  });
  assertEquals(out.snapshotId, SNAP_ID);
  assertEquals(out.result, { updated: true });
});

Deno.test("P3: rollback RPC error surfaces", async () => {
  const admin = makeAdmin(async () => ({
    data: null,
    error: { message: "snapshot not found" },
  }));
  await assertRejects(
    () => rollbackProtectedMutation(admin, SNAP_ID),
    Error,
    "MUTATION_ROLLBACK_FAILED",
  );
});

Deno.test("P3: reason and actor are required (audit)", async () => {
  const admin = makeAdmin(async () => ({ data: SNAP_ID, error: null }));
  await assertRejects(
    () => createSnapshot(admin, "did_team_deliberations", ROW_ID, "  ", "actor"),
    MutationSnapshotError,
  );
  await assertRejects(
    () => createSnapshot(admin, "did_team_deliberations", ROW_ID, "reason", ""),
    MutationSnapshotError,
  );
});
