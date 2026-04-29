import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { liveStartStatusText, planApprovalSynced } from "@/lib/dailyPlanStartPolicy";

const migrations = [
  "supabase/migrations/20260429071725_24456f65-0a6c-4970-9a0d-a6512eb15d40.sql",
  "supabase/migrations/20260429071850_4c59eeb0-06d9-48e9-bb49-8d8330ed8a3e.sql",
].map((path) => readFileSync(path, "utf8")).join("\n");

describe("backend-authoritative daily plan start", () => {
  it("keeps start authority in RPC with fixed search_path and no direct trusted client user id", () => {
    expect(migrations).toContain("CREATE OR REPLACE FUNCTION public.sync_and_start_approved_daily_plan");
    expect(migrations).toContain("SECURITY DEFINER");
    expect(migrations).toContain("SET search_path TO 'public'");
    expect(migrations).toContain("AND user_id = p_user_id");
    expect(migrations).not.toMatch(/EXECUTE\s+[^;]*\|\|/i);
  });

  it("treats approved program as signed snapshot and blocks mismatches", () => {
    expect(migrations).toContain("approved_program_draft_hash");
    expect(migrations).toContain("approved_program_snapshot");
    expect(migrations).toContain("approved_program_changed_after_signoff");
    expect(migrations).toContain("program_hash_mismatch");
  });

  it("distinguishes missing sync repair from hash mismatch and audits starts", () => {
    expect(migrations).toContain("was_missing_sync");
    expect(migrations).toContain("plan_markdown_hash_mismatch");
    expect(migrations).toContain("did_daily_session_start_audit");
    expect(migrations).toContain("already_started");
    expect(migrations).toContain("approved_for_child_session_missing");
  });
});

describe("daily plan start UI preflight copy", () => {
  it("shows desync, syncing, failed, and ready states", () => {
    expect(liveStartStatusText({ signed: true, starting: false })).toBe("Schváleno v poradě, čeká na propsání schválení do denního plánu.");
    expect(liveStartStatusText({ signed: true, starting: true })).toBe("Synchronizuji schválení…");
    expect(liveStartStatusText({ signed: true, starting: false, lastErrorCode: "program_hash_mismatch" })).toBe("Porada je podepsaná, ale plán stále není bezpečně připravený ke spuštění.");
    expect(planApprovalSynced({
      program_status: "ready_to_start",
      approved_at: "2026-04-29T00:00:00.000Z",
      urgency_breakdown: { approval_sync: { status: "synced", program_draft_hash: "a", plan_markdown_hash: "b" } },
    })).toBe(true);
    expect(liveStartStatusText({
      signed: true,
      starting: false,
      plan: { program_status: "ready_to_start", approved_at: "x", urgency_breakdown: { approval_sync: { status: "synced", program_draft_hash: "a", plan_markdown_hash: "b" } } },
    })).toBe("Připraveno k zahájení");
  });
});
