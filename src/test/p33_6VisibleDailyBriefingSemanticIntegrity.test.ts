/**
 * P33.6 — Visible daily briefing semantic integrity.
 *
 * Targeted unit tests for the new visible-text rules. Full UI/render
 * integration is exercised by the existing renderer tests; this file
 * locks the new contracts:
 *   1. Quality gate flags forbidden visible language.
 *   2. Part-relevance helper rejects dormant/low-support primary suggestions.
 *   3. normalizePartDisplayName strips technical prefixes.
 */

import { describe, it, expect } from "vitest";
import { auditVisibleKarelText, auditVisibleKarelSections } from "@/lib/karelVisibleTextQuality";
import {
  isPartTodayRelevantForPrimarySuggestion,
  normalizePartDisplayName,
} from "@/lib/partTodayRelevance";

describe("P33.6 — visible text quality gate", () => {
  it("flags double periods", () => {
    const r = auditVisibleKarelText("Něco jsem udělal.. a hotovo.");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("double_period"))).toBe(true);
  });

  it("flags 'doložený praktickou' kostrbatost", () => {
    const r = auditVisibleKarelText("doložený praktickou poznámku z dneška");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("dolozeny_praktickou"))).toBe(true);
  });

  it("flags 'Opora v podkladech je nízká'", () => {
    const r = auditVisibleKarelText("Opora v podkladech je nízká.");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("opora_je_nizka"))).toBe(true);
  });

  it("flags technical part prefix 002_Anička", () => {
    const r = auditVisibleKarelText("návrh na dnešní část je 002_Anička");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("technical_part_prefix"))).toBe(true);
  });

  it("flags internal terms (AI polish, audit, payload, source_cycle_id)", () => {
    expect(auditVisibleKarelText("AI polish náhled — pouze audit").ok).toBe(false);
    expect(auditVisibleKarelText("z payload se vygeneruje source_cycle_id").ok).toBe(false);
  });

  it("flags Technické podklady leak", () => {
    expect(auditVisibleKarelText("Technické podklady").ok).toBe(false);
  });

  it("flags false today-event language for tier2/3 ('může dnes zatížit')", () => {
    const r = auditVisibleKarelText("Téma může dnes zatížit Tundrupka.");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("muze_dnes_zatizit"))).toBe(true);
  });

  it("passes a clean Karel sentence", () => {
    const r = auditVisibleKarelText(
      "Pro dnešek se mi jako možná část pro práci nabízí Anička. Beru to jen jako pracovní rámec.",
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("aggregates per-section results", () => {
    const r = auditVisibleKarelSections([
      { section_id: "today_parts", karel_text: "Pro dnešek nemám dost opory." },
      { section_id: "external_reality", karel_text: "Téma může dnes zatížit." },
    ]);
    expect(r.ok).toBe(false);
    expect(r.per_section.external_reality.ok).toBe(false);
    expect(r.per_section.today_parts.ok).toBe(true);
  });
});

describe("P33.6 — part today-relevance gate", () => {
  const base = {
    briefing_date: "2026-05-11",
    source_cycle_id: "cyc-1",
    recent_thread_part_names: [] as string[],
    todays_session_part_names: [] as string[],
    live_progress_part_names: [] as string[],
    explicit_therapist_mentions: [] as string[],
  };

  it("rejects low-support hypothesis-only without current evidence", () => {
    const r = isPartTodayRelevantForPrimarySuggestion({
      ...base,
      proposed_part: "002_Anička",
      is_hypothesis_only: true,
      evidence_strength: "low",
    });
    expect(r.ok_for_primary_suggestion).toBe(false);
    expect(r.reason).toBe("low_support_hypothesis_without_current_evidence");
    expect(r.display_name).toBe("Anička");
  });

  it("rejects dormant part without current evidence", () => {
    const r = isPartTodayRelevantForPrimarySuggestion({
      ...base,
      proposed_part: "Anička",
      is_hypothesis_only: false,
      evidence_strength: "medium",
      registry_sleeping: true,
    });
    expect(r.ok_for_primary_suggestion).toBe(false);
    expect(r.reason).toBe("dormant_part_without_current_evidence");
  });

  it("accepts when current evidence is present (today's session)", () => {
    const r = isPartTodayRelevantForPrimarySuggestion({
      ...base,
      proposed_part: "002_Anička",
      is_hypothesis_only: true,
      evidence_strength: "low",
      todays_session_part_names: ["Anička"],
    });
    expect(r.ok_for_primary_suggestion).toBe(true);
    expect(r.confidence).toBe("high");
    expect(r.display_name).toBe("Anička");
  });

  it("accepts high-evidence non-hypothesis", () => {
    const r = isPartTodayRelevantForPrimarySuggestion({
      ...base,
      proposed_part: "Tundrupek",
      is_hypothesis_only: false,
      evidence_strength: "high",
    });
    expect(r.ok_for_primary_suggestion).toBe(true);
  });

  it("returns null display_name when proposed_part is empty", () => {
    const r = isPartTodayRelevantForPrimarySuggestion({
      ...base,
      proposed_part: "",
      is_hypothesis_only: false,
      evidence_strength: "low",
    });
    expect(r.ok_for_primary_suggestion).toBe(false);
    expect(r.display_name).toBeNull();
  });

  it("normalizePartDisplayName strips 00X_ prefixes", () => {
    expect(normalizePartDisplayName("002_Anička")).toBe("Anička");
    expect(normalizePartDisplayName("001_tundrupek")).toBe("Tundrupek");
    expect(normalizePartDisplayName("Arthur")).toBe("Arthur");
    expect(normalizePartDisplayName(null)).toBeNull();
    expect(normalizePartDisplayName("   ")).toBeNull();
  });
});
