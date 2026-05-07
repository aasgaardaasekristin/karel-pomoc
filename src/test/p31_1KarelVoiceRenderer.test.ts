// P31.1 — truth-locked Karel voice renderer (vitest mirror).
import { describe, it, expect, vi } from "vitest";
import { renderKarelBriefingVoice } from "../../supabase/functions/_shared/karelBriefingVoiceRenderer";

const validPayload: any = {
  briefing_truth_gate: { ok: true, source_cycle_id: "cyc-1", reasons: [] },
  source_cycle_id: "cyc-1",
  source_cycle_completed_at: "2026-05-07T05:00:00Z",
  phase_jobs_snapshot: { total: 14, completed: 14, jobs: [] },
  today_part_proposal: {
    proposed_part: "Tundrupek",
    rationale_text: "návaznost na včerejší upřesnění od Hany.",
    is_hypothesis_only: true,
    evidence_strength: "low",
  },
  ask_hanka: [{ text: "Krátce ověřit tělesný stav před sezením." }],
  ask_kata: [{ text: "Hlídat hranice návaznosti." }],
  proposed_session: { title: "Bezpečné ověření kontaktu" },
  proposed_playroom: null,
  external_reality_watch: {
    provider_status: "configured",
    active_part_daily_brief_count: 14,
    source_backed_events_count: 4,
    internet_events_used_count: 4,
    parts: [{ part_name: "Tundrupek", internet_triggers_today: ["x"] }],
  },
  lingering: [],
  daily_therapeutic_priority: "Krátké ověření aktuálního stavu.",
};

describe("P31.1 karelBriefingVoiceRenderer (truth-locked)", () => {
  it("renders >=6 sections for valid payload, ok=true, zero unsupported claims", () => {
    const r = renderKarelBriefingVoice(validPayload);
    expect(r.ok).toBe(true);
    expect(r.sections.length).toBeGreaterThanOrEqual(6);
    expect(r.render_audit.unsupported_claims_count).toBe(0);
    expect(r.render_audit.robotic_phrase_count).toBe(0);
    expect(r.render_audit.empty_sections_count).toBe(0);
  });

  it("every section has non-empty source_fields or explicit warning", () => {
    const r = renderKarelBriefingVoice(validPayload);
    for (const s of r.sections) {
      expect(s.source_fields.length).toBeGreaterThan(0);
    }
  });

  it("missing external_reality_watch renders 'nemám externí situační podklady', no fake events", () => {
    const r = renderKarelBriefingVoice({ ...validPayload, external_reality_watch: null });
    const ext = r.sections.find((s) => s.section_id === "external_reality")!;
    expect(ext.karel_text.toLowerCase()).toContain("nemám externí situační podklady");
    expect(ext.unsupported_claims_count).toBe(0);
  });

  it("provider_not_configured renders honest 'není zapnutý' message", () => {
    const p = JSON.parse(JSON.stringify(validPayload));
    p.external_reality_watch.provider_status = "provider_not_configured";
    p.external_reality_watch.source_backed_events_count = 0;
    p.external_reality_watch.internet_events_used_count = 0;
    p.external_reality_watch.active_part_daily_brief_count = 0;
    const r = renderKarelBriefingVoice(p);
    const ext = r.sections.find((s) => s.section_id === "external_reality")!;
    expect(ext.karel_text).toMatch(/není zapnutý/i);
  });

  it("renderer makes no fetch / no AI call", () => {
    const fetchSpy = vi.spyOn(globalThis as any, "fetch").mockImplementation(() => {
      throw new Error("renderer must not call fetch");
    });
    expect(() => renderKarelBriefingVoice(validPayload)).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("preserves structured payload (no mutation)", () => {
    const before = JSON.stringify(validPayload);
    renderKarelBriefingVoice(validPayload);
    expect(JSON.stringify(validPayload)).toBe(before);
  });

  it("truth_gate_not_ok lowers system_morning_state confidence and warns", () => {
    const p = JSON.parse(JSON.stringify(validPayload));
    p.briefing_truth_gate.ok = false;
    p.briefing_truth_gate.reasons = ["jobs_pending"];
    const r = renderKarelBriefingVoice(p);
    expect(r.briefing_truth_gate_ok).toBe(false);
    const sys = r.sections.find((s) => s.section_id === "system_morning_state")!;
    expect(sys.confidence).toBe("low");
    expect(sys.warnings).toContain("truth_gate_not_ok");
  });

  it("human text contains no internal pipeline terms", () => {
    const r = renderKarelBriefingVoice(validPayload);
    for (const s of r.sections) {
      expect(s.karel_text).not.toMatch(/\bpayload\b/i);
      expect(s.karel_text).not.toMatch(/truth gate/i);
      expect(s.karel_text).not.toMatch(/job graph/i);
      expect(s.karel_text).not.toMatch(/pipeline/i);
    }
  });

  it("forbidden robotic phrases produce zero hits in valid render", () => {
    const r = renderKarelBriefingVoice(validPayload);
    expect(r.render_audit.forbidden_phrase_hits).toEqual([]);
  });

  it("external reality section uses provider_status and counts from payload only", () => {
    const r = renderKarelBriefingVoice(validPayload);
    const ext = r.sections.find((s) => s.section_id === "external_reality")!;
    expect(ext.source_fields).toContain("external_reality_watch.provider_status");
    expect(ext.unsupported_claims_count).toBe(0);
  });

  it("missing payload returns ok=false with explicit error", () => {
    const r = renderKarelBriefingVoice(null as any);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("payload_missing_or_invalid");
  });

  it("today_parts section is honest when no proposed part exists", () => {
    const p = JSON.parse(JSON.stringify(validPayload));
    p.today_part_proposal = null;
    const r = renderKarelBriefingVoice(p);
    const tp = r.sections.find((s) => s.section_id === "today_parts")!;
    expect(tp.karel_text).toMatch(/nemám dost podkladů/i);
    expect(tp.confidence).toBe("low");
  });

  it("section ids cover full briefing body (system, cycle, parts, asks, plan, external, risks, unknowns, next)", () => {
    const r = renderKarelBriefingVoice(validPayload);
    const ids = r.sections.map((s) => s.section_id);
    for (const id of [
      "system_morning_state",
      "daily_cycle_verified",
      "today_parts",
      "therapist_asks",
      "session_plan",
      "external_reality",
      "risks_sensitivities",
      "unknowns",
      "next_step",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("ranní stav uses cycle completed_at when available", () => {
    const r = renderKarelBriefingVoice(validPayload);
    const sys = r.sections.find((s) => s.section_id === "system_morning_state")!;
    expect(sys.karel_text).toContain("2026-05-07T05:00:00Z");
  });
});
