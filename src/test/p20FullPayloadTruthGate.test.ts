/**
 * P20.2 — Full payload clinical truth gate
 *
 * Skenuje VŠECHNY visible textové sekce, ne jen opening. Pokud zůstane
 * started-claim fráze i po sanitaci, gate musí selhat (ok=false).
 */
import { describe, it, expect } from "vitest";
import {
  classifyClinicalActivityEvidence,
} from "../../supabase/functions/_shared/clinicalActivityEvidence.ts";
import {
  collectVisibleBriefingTexts,
  runP20ClinicalTruthGate,
} from "../../supabase/functions/_shared/p20FullPayloadTruthGate.ts";

describe("P20.2 full payload truth gate", () => {
  const pendingEvidence = classifyClinicalActivityEvidence({
    plans: [{ selected_part: "ARTHUR", status: "pending", lifecycle_status: "planned", program_status: "draft" }],
  });

  it("collects visible texts across opening, last_3_days, daily_priority, proposed_*, yesterday_session_review", () => {
    const payload: any = {
      opening_monologue_text: "Dobré ráno.",
      opening_monologue: { greeting: "Dobré ráno.", for_hanka: "Haničko." },
      last_3_days: "Poslední dny.",
      daily_therapeutic_priority: "Priorita dne.",
      yesterday_session_review: { practical_report_text: "Report.", karel_summary: "Shrnutí." },
      proposed_session: { why_today: "Proč dnes.", first_draft: "Návrh." },
      proposed_playroom: { main_theme: "Téma.", goals: ["cíl 1"] },
      ask_hanka: [{ id: "1", text: "Otázka pro Haničku." }],
    };
    const refs = collectVisibleBriefingTexts(payload);
    const paths = refs.map((r) => r.path);
    expect(paths).toContain("opening_monologue_text");
    expect(paths).toContain("opening_monologue.greeting");
    expect(paths).toContain("last_3_days");
    expect(paths).toContain("daily_therapeutic_priority");
    expect(paths).toContain("yesterday_session_review.practical_report_text");
    expect(paths).toContain("yesterday_session_review.karel_summary");
    expect(paths).toContain("proposed_session.why_today");
    expect(paths).toContain("proposed_playroom.main_theme");
    expect(paths).toContain("proposed_playroom.goals[0]");
    expect(paths).toContain("ask_hanka[0].text");
  });

  it("ARTHUR pending + started-claim spread across multiple sections → all sanitized", () => {
    const payload: any = {
      opening_monologue_text: "Sezení s ARTHUR bylo otevřené nebo částečně rozpracované.",
      yesterday_session_review: {
        practical_report_text: "Práce byla zahájená a čeká na plné dovyhodnocení.",
        karel_summary: "Bylo otevřené nebo částečně rozpracované.",
      },
      proposed_session: { why_today: "Navazujeme na včerejší otevřené Sezení s ARTHUR." },
      last_3_days: "Klidný report bez problémů.",
    };
    const result = runP20ClinicalTruthGate(payload, pendingEvidence, "ARTHUR");
    expect(result.evidence_category).toBe("pending_generated_plan");
    expect(result.violations_before_repair.length).toBeGreaterThan(0);
    expect(result.sanitized_paths.length).toBeGreaterThan(0);
    expect(result.violations_after_repair).toEqual([]);
    expect(result.ok).toBe(true);
    // Forbidden phrases gone from all visible paths
    expect(payload.opening_monologue_text).not.toMatch(/otevřené nebo částečně/);
    expect(payload.yesterday_session_review.practical_report_text).not.toMatch(/práce byla zahájen|čeká na plné dovyhodnocení/i);
    expect(payload.yesterday_session_review.karel_summary).not.toMatch(/otevřené nebo částečně/);
    expect(payload.proposed_session.why_today).not.toMatch(/včerejší otevřené Sezení/);
    // Truthful replacement appears
    expect(payload.opening_monologue_text).toMatch(/automaticky vygenerovaný návrh|nebyl schválen ani spuštěn/);
  });

  it("completed_session evidence → no sanitization, gate ok", () => {
    const completedEvidence = classifyClinicalActivityEvidence({
      session_reviews: [{ status: "analyzed", part_name: "Tundrupek", session_date: "2026-04-27" }],
    });
    const payload: any = {
      opening_monologue_text: "Dnešní přehled navazuje na zahájené Sezení s Tundrupkem z 27. 4. 2026.",
    };
    const result = runP20ClinicalTruthGate(payload, completedEvidence, "Tundrupek");
    expect(result.ok).toBe(true);
    expect(result.sanitized_paths).toEqual([]);
    expect(payload.opening_monologue_text).toMatch(/zahájené Sezení s Tundrupkem/);
  });

  it("no evidence → ok=true, reason=no_evidence_provided", () => {
    const payload: any = { opening_monologue_text: "Dobré ráno." };
    const result = runP20ClinicalTruthGate(payload, null, undefined);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("no_evidence_provided");
  });
});
