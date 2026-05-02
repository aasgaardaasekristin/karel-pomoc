import { describe, it, expect } from "vitest";
import {
  aggregateStatus,
  buildRun,
  failedChecks,
  type AcceptanceCheck,
} from "@/lib/professionalAcceptanceRegistry";

const passReq = (id: string): AcceptanceCheck => ({
  id, label: id, type: "sql_check", required: true, status: "passed",
});
const failReq = (id: string): AcceptanceCheck => ({
  id, label: id, type: "sql_check", required: true, status: "failed",
});
const skipReq = (id: string): AcceptanceCheck => ({
  id, label: id, type: "sql_check", required: true, status: "skipped",
});
const blockReq = (id: string): AcceptanceCheck => ({
  id, label: id, type: "sql_check", required: true, status: "blocked",
});
const passOpt = (id: string): AcceptanceCheck => ({
  id, label: id, type: "sql_check", required: false, status: "passed",
});

describe("professionalAcceptanceRegistry", () => {
  it("returns not_accepted when there are no required checks", () => {
    expect(aggregateStatus([passOpt("a")])).toBe("not_accepted");
  });

  it("returns accepted only when all required checks pass", () => {
    expect(aggregateStatus([passReq("a"), passReq("b"), passOpt("c")])).toBe("accepted");
  });

  it("returns not_accepted when any required check failed", () => {
    expect(aggregateStatus([passReq("a"), failReq("b")])).toBe("not_accepted");
  });

  it("returns blocked when any required check is blocked", () => {
    expect(aggregateStatus([passReq("a"), blockReq("b"), failReq("c")])).toBe("blocked");
  });

  it("returns partial when required checks are skipped but none failed", () => {
    expect(aggregateStatus([passReq("a"), skipReq("b")])).toBe("partial");
  });

  it("buildRun snapshots failed_checks correctly", () => {
    const run = buildRun("P1", [passReq("a"), failReq("b"), passOpt("c")]);
    expect(run.status).toBe("not_accepted");
    expect(run.failed_checks.map((c) => c.id)).toEqual(["b"]);
    expect(run.checks).toHaveLength(3);
    expect(run.pass_name).toBe("P1");
    expect(typeof run.generated_at).toBe("string");
  });

  it("failedChecks ignores optional failures", () => {
    const arr: AcceptanceCheck[] = [
      passReq("a"),
      { id: "x", label: "x", type: "sql_check", required: false, status: "failed" },
    ];
    expect(failedChecks(arr)).toEqual([]);
  });

  it("does not hide failed required checks in failed_checks", () => {
    const run = buildRun("P2_P3", [failReq("orphan_count"), passReq("canonical_resolves")]);
    expect(run.failed_checks).toHaveLength(1);
    expect(run.failed_checks[0].id).toBe("orphan_count");
  });
});
