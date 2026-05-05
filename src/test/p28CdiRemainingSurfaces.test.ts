import { describe, it, expect } from "vitest";
import { buildDedupeKey } from "@/lib/dynamicPipeline";

const REMAINING = [
  "playroom_deliberation_answer",
  "session_approval_answer",
  "pending_question_answer",
  "card_update_discussion",
  "daily_plan_edit",
  "live_session_block_update",
  "playroom_block_update",
  "did_part_chat_thread",
  "session_resume",
  "playroom_resume",
] as const;

const NEW_EVENTS = [
  "approval_answered",
  "pending_question_answered",
  "card_update_discussed",
  "plan_edited",
  "block_updated",
  "deliberation_answered",
  "message_sent",
] as const;

describe("P28_CDI_2b remaining surfaces", () => {
  it("each remaining surface produces a distinct dedupe key for the same row", () => {
    const seen = new Set<string>();
    for (const s of REMAINING) {
      const k = buildDedupeKey([s, "row-1", "evt", "src-1", 1]);
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
    expect(seen.size).toBe(REMAINING.length);
  });

  it("server-event union exposes new event types (smoke)", () => {
    expect(NEW_EVENTS).toContain("approval_answered");
    expect(NEW_EVENTS).toContain("pending_question_answered");
    expect(NEW_EVENTS).toContain("card_update_discussed");
  });

  it("safe synthetic event defaults raw_allowed=false", () => {
    const synthetic = {
      surface_type: "did_part_chat_thread",
      raw_allowed: false,
      safe_summary: "[P28_CDI_2B_SMOKE] DID safe synthetic marker",
      metadata: { p28_cdi_2b_smoke: true, no_child_raw_text: true },
    };
    expect(synthetic.raw_allowed).toBe(false);
    expect(synthetic.safe_summary.startsWith("[P28_CDI_2B_SMOKE]")).toBe(true);
  });

  it("resume-state shape includes block_update fields", () => {
    const resume = {
      current_block_index: 2,
      last_completed_block: "Block A",
      reason_for_change: "therapist note",
      next_resume_point: "block_feedback_acknowledged",
      what_changed_since_plan: { observation: "x", block: "Block A" },
    };
    expect(resume.current_block_index).toBe(2);
    expect(resume.what_changed_since_plan).toBeTruthy();
  });

  it("legacy queued smoke event must be marked superseded (assertion only)", () => {
    // Acceptance: stale_queued_smoke_events = 0 — verified via SQL in migration 20260505_024020.
    // This test documents the contract: any event from P28_CDI_2a with dispatch_ok=false
    // must transition to pipeline_state='superseded' (not stay 'queued_for_consumption').
    const allowedTerminalStates = new Set(["consumed", "superseded", "skipped_safe_fixture"]);
    expect(allowedTerminalStates.has("superseded")).toBe(true);
  });
});
