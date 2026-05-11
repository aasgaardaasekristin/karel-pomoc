/**
 * P33.7B — Yesterday review source validation
 *
 * Locks: yesterday continuity in Karlův přehled may only mention a real
 * completed/reviewed yesterday Sezení or Herna. Pending plans, awaiting
 * signoff team proposals, technical tests, evidence-limited records, and
 * non-yesterday-dated reviews must NOT manifest as "Sezení s X: průběh
 * doložený…". Instead the controlled-missing message must appear.
 */

import { describe, it, expect } from "vitest";
import { renderKarelBriefingVoice } from "../../supabase/functions/_shared/karelBriefingVoiceRenderer";

const baseValid: any = {
  briefing_truth_gate: { ok: true, source_cycle_id: "cyc-1", reasons: [] },
  source_cycle_id: "cyc-1",
  source_cycle_completed_at: "2026-05-11T05:00:00Z",
  phase_jobs_snapshot: { total: 14, completed: 14, jobs: [] },
  today_part_proposal: null,
  today_part_relevance_decision: { ok_for_primary_suggestion: false, reason: "low_evidence" },
  ask_hanka: [],
  ask_kata: [],
  proposed_session: null,
  proposed_playroom: null,
  external_reality_watch: { provider_status: "configured", parts: [] },
  lingering: [],
};

function getYesterdaySection(payload: any) {
  const r = renderKarelBriefingVoice(payload);
  return r.sections.find((s) => s.section_id === "yesterday_review");
}

const CONTROLLED_MISSING = "Včera nemám doložené dokončené Sezení ani Hernu";

describe("P33.7B yesterday review source validation", () => {
  it("controlled-missing when no yesterday review exists at all", () => {
    const s = getYesterdaySection({
      ...baseValid,
      yesterday_session_review: { exists: false },
      yesterday_playroom_review: { exists: false },
    });
    expect(s?.karel_text).toContain(CONTROLLED_MISSING);
    expect(s?.warnings).toContain("no_yesterday_review_controlled_missing");
  });

  it("rejects pending generated plan masquerading as yesterday session", () => {
    const s = getYesterdaySection({
      ...baseValid,
      yesterday_session_review: {
        exists: true,
        held: false,
        is_yesterday: true,
        status: "pending_generated_plan",
        fallback_reason: "pending_generated_plan_only",
        part_name: "002_Anička",
      },
      yesterday_playroom_review: { exists: false },
    });
    expect(s?.karel_text).toContain(CONTROLLED_MISSING);
    expect(s?.karel_text).not.toContain("Sezení s");
    expect(s?.warnings).toContain("yesterday_review_present_but_not_clinically_completed");
  });

  it("rejects approved-not-started plan as yesterday continuity", () => {
    const s = getYesterdaySection({
      ...baseValid,
      yesterday_session_review: {
        exists: true,
        held: false,
        is_yesterday: true,
        status: "approved_not_started",
        fallback_reason: "approved_plan_not_started",
        part_name: "002_Anička",
      },
      yesterday_playroom_review: { exists: false },
    });
    expect(s?.karel_text).toContain(CONTROLLED_MISSING);
    expect(s?.karel_text).not.toContain("Anič");
  });

  it("rejects technical-test review as completed continuity", () => {
    const s = getYesterdaySection({
      ...baseValid,
      yesterday_session_review: {
        exists: true,
        held: false,
        is_yesterday: true,
        status: "technical_test",
        fallback_reason: "planned_session_not_clinically_held",
        review_id: "rev-1",
        part_name: "Tundrupek",
      },
      yesterday_playroom_review: { exists: false },
    });
    expect(s?.karel_text).toContain(CONTROLLED_MISSING);
  });

  it("rejects evidence_limited / pending_review as completed continuity", () => {
    const s = getYesterdaySection({
      ...baseValid,
      yesterday_session_review: {
        exists: true,
        held: false,
        is_yesterday: true,
        review_status: "pending_review",
        status: "pending_review",
        review_id: "rev-2",
        part_name: "Tundrupek",
      },
      yesterday_playroom_review: { exists: false },
    });
    expect(s?.karel_text).toContain(CONTROLLED_MISSING);
  });

  it("rejects non-yesterday review (older completed session) as yesterday continuity", () => {
    const s = getYesterdaySection({
      ...baseValid,
      yesterday_session_review: {
        exists: true,
        held: true,
        is_yesterday: false,
        days_since_today: 5,
        status: "analyzed",
        review_status: "analyzed",
        completion: "completed",
        review_id: "rev-3",
        part_name: "Tundrupek",
        karel_summary: "krátké ověření",
      },
      yesterday_playroom_review: { exists: false },
    });
    expect(s?.karel_text).toContain(CONTROLLED_MISSING);
  });

  it("accepts a true completed yesterday session review", () => {
    const s = getYesterdaySection({
      ...baseValid,
      yesterday_session_review: {
        exists: true,
        held: true,
        is_yesterday: true,
        review_status: "analyzed",
        status: "analyzed",
        completion: "completed",
        review_id: "rev-real",
        part_name: "Tundrupek",
        karel_summary: "krátké ověření kontaktu, beze změny tématu.",
      },
      yesterday_playroom_review: { exists: false },
    });
    expect(s?.karel_text).toContain("Sezení s Tundrupek");
    expect(s?.karel_text).not.toContain(CONTROLLED_MISSING);
    expect(s?.warnings ?? []).not.toContain("no_yesterday_review_controlled_missing");
  });

  it("rejects review without review_id (pending plan fallback shape)", () => {
    const s = getYesterdaySection({
      ...baseValid,
      yesterday_session_review: {
        exists: true,
        held: true,
        is_yesterday: true,
        status: "analyzed",
        part_name: "002_Anička",
        // no review_id present
      },
      yesterday_playroom_review: { exists: false },
    });
    expect(s?.karel_text).toContain(CONTROLLED_MISSING);
  });
});
