// @ts-nocheck
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decideAction } from "./index.ts";

Deno.test("noop when fresh non-manual exists", () => {
  const r = decideAction({ fresh_non_manual_exists: true, fresh_manual_exists: false, cycle_status: "completed" });
  assertEquals(r.action, "noop");
  assertEquals(r.reason, "fresh_non_manual_exists");
});

Deno.test("noop when fresh non-manual exists even with running cycle", () => {
  const r = decideAction({ fresh_non_manual_exists: true, fresh_manual_exists: true, cycle_status: "running" });
  assertEquals(r.action, "noop");
});

Deno.test("invoke sla_watchdog when only manual exists and cycle completed", () => {
  const r = decideAction({ fresh_non_manual_exists: false, fresh_manual_exists: true, cycle_status: "completed" });
  assertEquals(r.action, "invoke_sla_watchdog");
  assertEquals(r.method, "sla_watchdog");
  assertEquals(r.reason, "replacing_manual_with_sla_watchdog");
});

Deno.test("invoke sla_watchdog when no fresh and cycle completed", () => {
  const r = decideAction({ fresh_non_manual_exists: false, fresh_manual_exists: false, cycle_status: "completed" });
  assertEquals(r.action, "invoke_sla_watchdog");
});

Deno.test("invoke sla_repair when cycle running", () => {
  const r = decideAction({ fresh_non_manual_exists: false, fresh_manual_exists: true, cycle_status: "running" });
  assertEquals(r.action, "invoke_sla_repair");
  assertEquals(r.method, "sla_watchdog_repair");
  assertEquals(r.reason, "cycle_running");
});

Deno.test("invoke sla_repair when cycle missing", () => {
  const r = decideAction({ fresh_non_manual_exists: false, fresh_manual_exists: false, cycle_status: "missing" });
  assertEquals(r.action, "invoke_sla_repair");
  assertEquals(r.reason, "cycle_missing");
});

Deno.test("invoke sla_repair when cycle failed_stale", () => {
  const r = decideAction({ fresh_non_manual_exists: false, fresh_manual_exists: false, cycle_status: "failed_stale" });
  assertEquals(r.action, "invoke_sla_repair");
  assertEquals(r.reason, "cycle_stuck");
});

Deno.test("invoke sla_repair when cycle failed", () => {
  const r = decideAction({ fresh_non_manual_exists: false, fresh_manual_exists: true, cycle_status: "failed" });
  assertEquals(r.action, "invoke_sla_repair");
  assertEquals(r.reason, "cycle_failed");
});

Deno.test("invoke sla_repair when cycle status null defaults to missing", () => {
  const r = decideAction({ fresh_non_manual_exists: false, fresh_manual_exists: false, cycle_status: null as any });
  assertEquals(r.action, "invoke_sla_repair");
  assertEquals(r.reason, "cycle_missing");
});
