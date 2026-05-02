/**
 * P4: Deno mirror parity test for professionalAcceptanceRegistry.
 *
 * Validates aggregateStatus rules and presence of canonical check IDs that
 * `karel-acceptance-runner` depends on at boot time.
 */

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aggregateStatus,
  buildRun,
  P1_CHECK_IDS,
  P2P3_CHECK_IDS,
  type AcceptanceCheck,
} from "./professionalAcceptanceRegistry.ts";

const mk = (status: AcceptanceCheck["status"], required = true): AcceptanceCheck => ({
  id: `t_${Math.random()}`,
  label: "t",
  type: "sql_check",
  required,
  status,
});

Deno.test("aggregateStatus: accepted when all required passed", () => {
  assertEquals(aggregateStatus([mk("passed"), mk("passed")]), "accepted");
});

Deno.test("aggregateStatus: not_accepted on required failed", () => {
  assertEquals(aggregateStatus([mk("passed"), mk("failed")]), "not_accepted");
});

Deno.test("aggregateStatus: blocked dominates", () => {
  assertEquals(aggregateStatus([mk("blocked"), mk("failed")]), "blocked");
});

Deno.test("aggregateStatus: partial when required skipped but none failed", () => {
  assertEquals(aggregateStatus([mk("passed"), mk("skipped")]), "partial");
});

Deno.test("aggregateStatus: not_accepted with zero required", () => {
  assertEquals(aggregateStatus([mk("passed", false)]), "not_accepted");
});

Deno.test("P1_CHECK_IDS contains briefing_dom", () => {
  assertEquals(P1_CHECK_IDS.briefing_dom, "p1_briefing_dom_forbidden_count");
});

Deno.test("P2P3_CHECK_IDS contains canonical_active_count", () => {
  assertEquals(P2P3_CHECK_IDS.canonical_active_count, "p2_canonical_active_count");
});

Deno.test("buildRun produces structured AcceptanceRun", () => {
  const run = buildRun("P1", [mk("passed")], { sample: true }, "v-test");
  assertEquals(run.pass_name, "P1");
  assertEquals(run.status, "accepted");
  assertEquals(run.failed_checks.length, 0);
  assertEquals(run.app_version, "v-test");
  assert(run.generated_at.length > 0);
});
