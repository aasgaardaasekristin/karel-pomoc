// P31.2A — claim-checked AI polish CANDIDATE-only layer.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  generateKarelAiPolishCandidate,
  validateMeaningDrift,
} from "../../supabase/functions/_shared/karelBriefingVoiceAiPolish";
import { renderKarelBriefingVoice } from "../../supabase/functions/_shared/karelBriefingVoiceRenderer";

const basePayload: any = {
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

function det() {
  return renderKarelBriefingVoice(basePayload);
}

describe("P31.2A AI polish candidate-only", () => {
  let envBackup: string | undefined;
  beforeEach(() => {
    envBackup = (globalThis as any).Deno?.env?.get?.("P31_2_ENABLE_AI_POLISH");
  });
  afterEach(() => {
    // no-op; tests use __testFetcher to enable.
  });

  it("disabled by default → attempted=false, ok=false, ai_polish_disabled_by_default", async () => {
    const r = await generateKarelAiPolishCandidate({ payload: basePayload, deterministic: det() });
    expect(r.attempted).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("ai_polish_disabled_by_default");
  });

  it("never runs when deterministic.ok=false", async () => {
    const bad = { ...det(), ok: false };
    const r = await generateKarelAiPolishCandidate({
      payload: basePayload,
      deterministic: bad as any,
      __testFetcher: async () => ({}),
    });
    expect(r.attempted).toBe(false);
    expect(r.errors).toContain("deterministic_not_ok");
  });

  it("AI input does not include the raw payload", async () => {
    let captured: any = null;
    await generateKarelAiPolishCandidate({
      payload: basePayload,
      deterministic: det(),
      __testFetcher: async (sections) => {
        captured = sections;
        return Object.fromEntries(sections.map((s) => [s.section_id, s.original_text]));
      },
    });
    const serialized = JSON.stringify(captured);
    // Must NOT contain raw payload values (rationale text, deep payload structures)
    expect(serialized).not.toContain("rationale_text\":");
    expect(serialized).not.toContain("phase_jobs_snapshot\":");
    expect(serialized).not.toContain("today_part_proposal\":");
    // Must contain only allowed keys per section
    for (const s of captured) {
      expect(Object.keys(s).sort()).toEqual(
        ["original_text", "section_id", "source_fields", "source_summary"].sort(),
      );
    }
  });

  it("rejects extra section_id from AI", async () => {
    const r = await generateKarelAiPolishCandidate({
      payload: basePayload,
      deterministic: det(),
      __testFetcher: async (sections) => {
        const m: Record<string, string> = {};
        for (const s of sections) m[s.section_id] = s.original_text;
        m["fake_section"] = "Halucinovaná sekce.";
        return m;
      },
    });
    expect(r.audit.preserved_section_ids).toBe(false);
    expect(r.errors.some((e) => e.startsWith("extra_section_ids:"))).toBe(true);
  });

  it("rejects missing section_id with rejected_schema_error", async () => {
    const r = await generateKarelAiPolishCandidate({
      payload: basePayload,
      deterministic: det(),
      __testFetcher: async () => ({}), // empty mapping
    });
    expect(r.sections.every((s) => s.polish_status === "rejected_schema_error")).toBe(true);
  });

  it("rejects polished text that drops a number from original", async () => {
    const d = det();
    const r = await generateKarelAiPolishCandidate({
      payload: basePayload,
      deterministic: d,
      __testFetcher: async (sections) => {
        const m: Record<string, string> = {};
        for (const s of sections) {
          if (s.section_id === "daily_cycle_verified") {
            m[s.section_id] = "Dnešní příprava je hotová celá.";
          } else {
            m[s.section_id] = s.original_text;
          }
        }
        return m;
      },
    });
    const sec = r.sections.find((s) => s.section_id === "daily_cycle_verified")!;
    expect(sec.polish_status).toBe("rejected_meaning_drift");
    expect(sec.polished_text).toBe(sec.original_text);
  });

  it("rejects polished text that removes 'hypotéza' marker", async () => {
    const d = det();
    const r = await generateKarelAiPolishCandidate({
      payload: basePayload,
      deterministic: d,
      __testFetcher: async (sections) => {
        const m: Record<string, string> = {};
        for (const s of sections) {
          if (s.section_id === "today_parts") {
            m[s.section_id] = "Dnes pracujeme s Tundrupek a je to potvrzené.";
          } else m[s.section_id] = s.original_text;
        }
        return m;
      },
    });
    const sec = r.sections.find((s) => s.section_id === "today_parts")!;
    expect(sec.polish_status).toBe("rejected_meaning_drift");
  });

  it("rejects polished text that turns uncertainty into certainty", async () => {
    const payload = { ...basePayload, daily_therapeutic_priority: "" };
    const d = renderKarelBriefingVoice(payload);
    const r = await generateKarelAiPolishCandidate({
      payload,
      deterministic: d,
      __testFetcher: async (sections) => {
        const m: Record<string, string> = {};
        for (const s of sections) {
          if (s.section_id === "next_step") {
            m[s.section_id] = "Určitě si pro dnešek stanovíme jistě další krok.";
          } else m[s.section_id] = s.original_text;
        }
        return m;
      },
    });
    const sec = r.sections.find((s) => s.section_id === "next_step")!;
    expect(sec.polish_status).toBe("rejected_meaning_drift");
  });

  it("rejects forbidden robotic phrase", async () => {
    const d = det();
    const r = await generateKarelAiPolishCandidate({
      payload: basePayload,
      deterministic: d,
      __testFetcher: async (sections) => {
        const m: Record<string, string> = {};
        for (const s of sections) {
          if (s.section_id === "system_morning_state") {
            m[s.section_id] = "Na základě dat jsou ranní podklady připravené z " + (s.original_text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/)?.[0] ?? "rána") + ".";
          } else m[s.section_id] = s.original_text;
        }
        return m;
      },
    });
    const sec = r.sections.find((s) => s.section_id === "system_morning_state")!;
    expect(sec.polish_status).toBe("rejected_forbidden_phrase");
  });

  it("rejects internal term leak", async () => {
    const d = det();
    const r = await generateKarelAiPolishCandidate({
      payload: basePayload,
      deterministic: d,
      __testFetcher: async (sections) => {
        const m: Record<string, string> = {};
        for (const s of sections) {
          if (s.section_id === "therapist_asks") {
            m[s.section_id] = s.original_text + " (payload)";
          } else m[s.section_id] = s.original_text;
        }
        return m;
      },
    });
    const sec = r.sections.find((s) => s.section_id === "therapist_asks")!;
    expect(sec.polish_status).toBe("rejected_forbidden_phrase");
  });

  it("rejected candidate keeps original_text as polished_text fallback", async () => {
    const d = det();
    const r = await generateKarelAiPolishCandidate({
      payload: basePayload,
      deterministic: d,
      __testFetcher: async (sections) => {
        const m: Record<string, string> = {};
        for (const s of sections) m[s.section_id] = "(payload) " + s.original_text;
        return m;
      },
    });
    for (const sec of r.sections) {
      expect(sec.polished_text).toBe(sec.original_text);
    }
  });

  it("accepted candidate preserves section_id and source_fields", async () => {
    const d = det();
    const r = await generateKarelAiPolishCandidate({
      payload: basePayload,
      deterministic: d,
      __testFetcher: async (sections) => {
        const m: Record<string, string> = {};
        for (const s of sections) m[s.section_id] = s.original_text; // identity = always passes
        return m;
      },
    });
    expect(r.accepted_candidate_count).toBe(d.sections.length);
    for (const sec of r.sections) {
      const orig = d.sections.find((x) => x.section_id === sec.section_id)!;
      expect(sec.source_fields).toEqual(orig.source_fields);
    }
  });

  it("validateMeaningDrift detects flipped provider status", () => {
    const w = validateMeaningDrift(
      "Externí situační přehled dnes není zapnutý.",
      "Externí přehled je dnes dostupný.",
    );
    expect(w).toContain("flipped_provider_status");
  });

  it("audit counters reflect rejection reasons", async () => {
    const d = det();
    const r = await generateKarelAiPolishCandidate({
      payload: basePayload,
      deterministic: d,
      __testFetcher: async (sections) => {
        const m: Record<string, string> = {};
        for (const s of sections) m[s.section_id] = "Dle pipeline " + s.original_text;
        return m;
      },
    });
    expect(r.audit.robotic_phrase_count).toBeGreaterThan(0);
    expect(r.audit.forbidden_phrase_hits.length).toBeGreaterThan(0);
  });
});
