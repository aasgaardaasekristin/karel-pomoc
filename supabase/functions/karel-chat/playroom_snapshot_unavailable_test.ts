// Integration test for the karel-chat playroom snapshot contract.
//
// Verifies that when no approved playroom_plan_snapshot exists, the resolver
// returns a stable diagnostic that karel-chat translates into HTTP 409 with
// the exact body shape the UI relies on:
//
//   status: 409
//   body:   { ok: false, error: "playroom_snapshot_unavailable",
//             reason: <string>, plan_id: <string|null>, source: "snapshot",
//             message: <string> }
//
// Uses a stub Supabase client so the test is deterministic, hermetic and
// requires no live network or auth (production verify_jwt gate blocks
// anon-only HTTP tests, see chat history).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildPlayroomSnapshotUnavailableBody,
  resolvePlayroomSnapshot,
} from "../_shared/playroomSnapshotResolver.ts";

type Row = {
  id: string;
  plan_date: string;
  selected_part: string;
  program_status: string | null;
  urgency_breakdown: any;
};

function makeStub(row: Row | null, dbError: { message: string } | null = null) {
  return {
    from(_table: string) {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        ilike: () => builder,
        contains: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: row, error: dbError }),
      };
      return builder;
    },
  };
}

const today = "2026-05-12";

Deno.test("snapshot missing -> reason=no_approved_plan_today and 409 body shape", async () => {
  const result = await resolvePlayroomSnapshot("Tundrupek", { sb: makeStub(null), today });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason, "no_approved_plan_today");
  assertEquals(result.plan_id, null);

  const body = buildPlayroomSnapshotUnavailableBody(result);
  assertEquals(body.ok, false);
  assertEquals(body.error, "playroom_snapshot_unavailable");
  assertEquals(body.source, "snapshot");
  assertEquals(body.reason, "no_approved_plan_today");
  assertEquals(body.plan_id, null);
  assert(typeof body.message === "string" && body.message.length > 0);
});

Deno.test("snapshot key absent on approved plan -> reason=snapshot_missing", async () => {
  const row: Row = {
    id: "plan-1",
    plan_date: today,
    selected_part: "Tundrupek",
    program_status: "approved",
    urgency_breakdown: { session_actor: "karel_direct", playroom_plan: { therapeutic_program: [] } },
  };
  const result = await resolvePlayroomSnapshot("Tundrupek", { sb: makeStub(row), today });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason, "snapshot_missing");
  assertEquals(result.plan_id, "plan-1");

  const body = buildPlayroomSnapshotUnavailableBody(result);
  assertEquals(body.error, "playroom_snapshot_unavailable");
  assertEquals(body.plan_id, "plan-1");
  assertEquals(body.reason, "snapshot_missing");
});

Deno.test("snapshot exists but payload invalid -> reason=snapshot_payload_invalid", async () => {
  const row: Row = {
    id: "plan-2",
    plan_date: today,
    selected_part: "Tundrupek",
    program_status: "approved",
    urgency_breakdown: {
      playroom_plan_snapshot: {
        version_key: "v1",
        snapshot_at: "2026-05-12T08:00:00.000Z",
        payload: { therapeutic_program: "not-an-array" },
      },
    },
  };
  const result = await resolvePlayroomSnapshot("Tundrupek", { sb: makeStub(row), today });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason, "snapshot_payload_invalid");
  assertEquals(result.plan_id, "plan-2");
});

Deno.test("missing part name -> reason=missing_part_name (no DB call required)", async () => {
  const result = await resolvePlayroomSnapshot("", { sb: makeStub(null), today });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason, "missing_part_name");
  assertEquals(result.plan_id, null);
});

Deno.test("DB error -> reason carries db_error: prefix", async () => {
  const result = await resolvePlayroomSnapshot("Tundrupek", {
    sb: makeStub(null, { message: "boom" }),
    today,
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason.startsWith("db_error:"), true);
});

Deno.test("valid snapshot -> ok=true, source=snapshot, no fallback to live plan", async () => {
  const row: Row = {
    id: "plan-3",
    plan_date: today,
    selected_part: "Tundrupek",
    program_status: "approved",
    urgency_breakdown: {
      playroom_plan: { therapeutic_program: [{ from_live: true }] }, // MUST NOT be used
      playroom_plan_snapshot: {
        version_key: "v_snap_1",
        snapshot_at: "2026-05-12T08:00:00.000Z",
        snapshot_source_program_status: "approved",
        payload: { therapeutic_program: [{ from_snapshot: true, title: "Krok 1" }] },
      },
    },
  };
  const result = await resolvePlayroomSnapshot("Tundrupek", { sb: makeStub(row), today });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.source, "snapshot");
  assertEquals(result.plan_id, "plan-3");
  assertEquals(result.version_key, "v_snap_1");
  assertEquals(result.playroom_plan.therapeutic_program[0].from_snapshot, true);
  // Hard guarantee: payload is the snapshot's, not the live plan's.
  assertEquals((result.playroom_plan.therapeutic_program[0] as any).from_live, undefined);
});
