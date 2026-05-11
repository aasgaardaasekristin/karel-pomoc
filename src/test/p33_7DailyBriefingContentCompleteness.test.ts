/**
 * P33.7 — Daily Briefing Content Completeness & Professional Standard
 *
 * Locks the contract that every Karlův přehled must address 9 mandatory
 * sections (or mark them controlled_missing with a visible reason) and
 * that the renderer manifests the required content (yesterday review,
 * no-part operational fallback with three pathways and stop signals,
 * session/herna decision protocol, concrete therapist tasks, and
 * external-reality source/tier/domain manifestation).
 */

import { describe, it, expect } from "vitest";
import { evaluateBriefingContentCompleteness } from "@/lib/dailyBriefingContentCompleteness";
// Renderer is shared with the edge function — we import its UI mirror via
// the alias used in src/test for renderer assertions.
// karelBriefingVoiceRenderer.ts is not currently mirrored to src/lib in this
// project; the same logic is exercised through the contract module on the
// payload shape. We therefore validate behavior via the contract evaluator.

const TODAY = "2026-05-12";

function basePayload(over: Record<string, any> = {}) {
  return {
    briefing_date: TODAY,
    briefing_truth_gate: { ok: true, source_cycle_id: "cyc-1" },
    today_part_proposal: null,
    today_part_relevance_decision: {
      ok_for_primary_suggestion: false,
      reason: "low_evidence",
      display_name: null,
      confidence: "low",
      checked_at: new Date().toISOString(),
    },
    yesterday_session_review: { exists: false },
    yesterday_playroom_review: { exists: false },
    proposed_session: null,
    proposed_playroom: null,
    ask_hanka: [],
    ask_kata: [],
    external_reality_watch: { provider_status: "configured", parts: [] },
    lingering: [],
    daily_therapeutic_priority: "",
    ...over,
  };
}

describe("P33.7 — content completeness contract (9 mandatory sections)", () => {
  it("emits all 9 required section ids with statuses", () => {
    const c = evaluateBriefingContentCompleteness(basePayload());
    expect(c.version).toBe("p33.7");
    expect(Object.keys(c.sections).sort()).toEqual([
      "external_reality_context",
      "morning_readiness",
      "next_step",
      "risk_and_stop_signals",
      "therapist_tasks",
      "today_part_or_no_part_decision",
      "today_session_playroom_plan",
      "unknowns_and_limits",
      "yesterday_review",
    ]);
    for (const sec of Object.values(c.sections)) {
      expect(["complete", "controlled_missing", "blocked"]).toContain(sec.status);
      expect(sec.visible_summary_requirement.length).toBeGreaterThan(10);
    }
  });

  it("marks yesterday_review controlled_missing with a Karel-voice reason when nothing happened", () => {
    const c = evaluateBriefingContentCompleteness(basePayload());
    const y = c.sections.yesterday_review;
    expect(y.status).toBe("controlled_missing");
    expect(y.controlled_missing_reason).toMatch(/Včera nemám doložené/);
  });

  it("marks yesterday_review complete when a session review exists", () => {
    const c = evaluateBriefingContentCompleteness(basePayload({
      yesterday_session_review: { exists: true, part_name: "tundrupek", karel_summary: "Klidné sezení." },
    }));
    expect(c.sections.yesterday_review.status).toBe("complete");
  });

  it("marks today_part_or_no_part_decision controlled_missing when ok_for_primary_suggestion=false", () => {
    const c = evaluateBriefingContentCompleteness(basePayload());
    const d = c.sections.today_part_or_no_part_decision;
    expect(d.status).toBe("controlled_missing");
    expect(d.visible_summary_requirement).toMatch(/tři cesty/);
    expect(d.visible_summary_requirement).toMatch(/stop signály/);
  });

  it("marks today_session_playroom_plan controlled_missing when no approved plan exists", () => {
    const c = evaluateBriefingContentCompleteness(basePayload());
    const s = c.sections.today_session_playroom_plan;
    expect(s.status).toBe("controlled_missing");
    expect(s.visible_summary_requirement).toMatch(/rozhodovací protokol/);
  });

  it("marks therapist_tasks controlled_missing when no asks present and requires concrete defaults", () => {
    const c = evaluateBriefingContentCompleteness(basePayload());
    const t = c.sections.therapist_tasks;
    expect(t.status).toBe("controlled_missing");
    expect(t.visible_summary_requirement).toMatch(/first-contact/);
    expect(t.visible_summary_requirement).toMatch(/risk\/stop/);
  });

  it("marks therapist_tasks complete when asks are present", () => {
    const c = evaluateBriefingContentCompleteness(basePayload({
      ask_hanka: [{ text: "Ověř první kontakt s kluky." }],
      ask_kata: [{ text: "Projdi rizika a stop signály." }],
    }));
    expect(c.sections.therapist_tasks.status).toBe("complete");
    expect(c.sections.therapist_tasks.evidence_count).toBe(2);
  });

  it("marks external_reality_context complete when configured and emits per-part requirement", () => {
    const c = evaluateBriefingContentCompleteness(basePayload({
      external_reality_watch: { provider_status: "configured", parts: [{ part_name: "Arthur" }, { part_name: "Tundrupek" }] },
    }));
    const e = c.sections.external_reality_context;
    expect(e.status).toBe("complete");
    expect(e.visible_summary_requirement).toMatch(/kategorii/);
    expect(e.visible_summary_requirement).toMatch(/recency tier/);
    expect(e.visible_summary_requirement).toMatch(/dom[ée]nu/);
  });

  it("marks external_reality_context controlled_missing when provider not configured", () => {
    const c = evaluateBriefingContentCompleteness(basePayload({
      external_reality_watch: { provider_status: "provider_not_configured", parts: [] },
    }));
    expect(c.sections.external_reality_context.status).toBe("controlled_missing");
  });

  it("counts fresh tier parts in risk_and_stop_signals", () => {
    const c = evaluateBriefingContentCompleteness(basePayload({
      external_reality_watch: {
        provider_status: "configured",
        parts: [{
          part_name: "Arthur",
          internet_triggers_today: [{ freshness: { display_tier: "fresh_today_event", ok_for_today_display: true } }],
        }],
      },
    }));
    expect(c.sections.risk_and_stop_signals.status).toBe("complete");
    expect(c.sections.risk_and_stop_signals.evidence_count).toBeGreaterThan(0);
  });

  it("overall_status is complete_with_controlled_missing when sections are missing but visible", () => {
    const c = evaluateBriefingContentCompleteness(basePayload());
    expect(c.overall_status).toBe("complete_with_controlled_missing");
    expect(c.blocking_reasons).toEqual([]);
  });

  it("overall_status is complete when every section is complete", () => {
    const c = evaluateBriefingContentCompleteness(basePayload({
      yesterday_session_review: { exists: true, part_name: "tundrupek", karel_summary: "ok" },
      today_part_proposal: { proposed_part: "tundrupek" },
      today_part_relevance_decision: { ok_for_primary_suggestion: true, display_name: "Tundrupek", confidence: "high" },
      proposed_session: { title: "Krátké stabilizační Sezení" },
      ask_hanka: [{ text: "Ověř první kontakt." }],
      ask_kata: [{ text: "Projdi rizika." }],
      external_reality_watch: { provider_status: "configured", parts: [{ part_name: "Tundrupek" }] },
      lingering: [{ topic: "x" }],
      daily_therapeutic_priority: "Začít prvním kontaktem.",
    }));
    expect(c.overall_status).toBe("complete");
  });

  it("overall_status is blocked when today_part_relevance_decision is missing entirely", () => {
    const p = basePayload();
    delete (p as any).today_part_relevance_decision;
    const c = evaluateBriefingContentCompleteness(p);
    expect(c.overall_status).toBe("blocked");
    expect(c.blocking_reasons.length).toBeGreaterThan(0);
  });

  it("section ids are stable strings (no diacritics, no debug terms)", () => {
    const c = evaluateBriefingContentCompleteness(basePayload());
    for (const id of Object.keys(c.sections)) {
      expect(id).toMatch(/^[a-z_]+$/);
    }
    for (const sec of Object.values(c.sections)) {
      const blob = JSON.stringify(sec);
      expect(blob).not.toMatch(/\b00[0-9]_/);
      expect(blob).not.toMatch(/\bpayload\b/i);
      expect(blob).not.toMatch(/truth gate/i);
      expect(blob).not.toMatch(/job graph/i);
    }
  });
});
