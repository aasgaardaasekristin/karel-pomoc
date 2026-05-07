import { describe, it, expect } from "vitest";
import {
  isFullRenderableBriefing,
  selectBestBriefing,
} from "@/lib/briefingSelection";
import {
  sanitizeKarelVisibleText,
  auditVisibleKarelText,
} from "@/lib/karelBriefingVisibleSanitizer";

const fullPayload = {
  briefing_truth_gate: { ok: true, source_cycle_id: "c1" },
  external_reality_watch: { provider_status: "configured", source_backed_events_count: 35 },
  karel_human_briefing: {
    ok: true,
    sections: Array.from({ length: 9 }, (_, i) => ({ section_id: `s${i}`, karel_text: "x" })),
    render_audit: { unsupported_claims_count: 0, robotic_phrase_count: 0 },
  },
};

const fullRow = {
  id: "full",
  generated_at: "2026-05-07T05:45:00.000Z",
  is_stale: false,
  generation_method: "sla_watchdog",
  payload: fullPayload,
};

const fallbackRow = {
  id: "fallback",
  generated_at: "2026-05-07T09:00:00.000Z",
  is_stale: false,
  generation_method: "truth_gate_blocked",
  payload: {
    briefing_truth_gate: { ok: false },
    karel_human_briefing: { ok: false, sections: [] },
  },
};

describe("P33.3 — briefing selection", () => {
  it("isFullRenderableBriefing returns true for valid sla_watchdog with truth_ok and clean audit", () => {
    expect(isFullRenderableBriefing(fullRow as any)).toBe(true);
  });

  it("isFullRenderableBriefing rejects truth_gate_blocked / fallback methods", () => {
    expect(isFullRenderableBriefing(fallbackRow as any)).toBe(false);
  });

  it("selectBestBriefing prefers older valid full row over newer fallback", () => {
    const picked = selectBestBriefing([fallbackRow, fullRow] as any);
    expect(picked?.id).toBe("full");
  });

  it("selectBestBriefing returns latest fallback only when no full row exists", () => {
    const picked = selectBestBriefing([fallbackRow] as any);
    expect(picked?.id).toBe("fallback");
  });

  it("selectBestBriefing returns null on empty input", () => {
    expect(selectBestBriefing([])).toBeNull();
  });
});

describe("P33.3 — visible language sanitizer", () => {
  it("strips raw ISO timestamp", () => {
    const out = sanitizeKarelVisibleText(
      "Ranní podklady jsou připravené a vázané na dokončený denní cyklus z 2026-05-07T08:35:28.791+00:00. Můžeme z nich dnes vycházet.",
    );
    expect(out).not.toMatch(/2026-05-07T/);
    expect(out).toMatch(/dnešní dokončený ranní cyklus/);
  });

  it("rewrites English evidence value 'low' in Czech sentence", () => {
    const out = sanitizeKarelVisibleText("Síla podkladů je low.");
    expect(out.toLowerCase()).not.toMatch(/\blow\b/);
    expect(out).toMatch(/Opora v podkladech je zatím nízká\./);
  });

  it("replaces 'Síla důkazu' with 'opora v podkladech'", () => {
    const out = sanitizeKarelVisibleText("Síla důkazu je nízká, takže návrh musí potvrdit Hanička s Káťou.");
    expect(out).not.toMatch(/Síla důkazu/i);
    expect(out).toMatch(/opora v podkladech|Opora v podkladech/i);
  });

  it("replaces 'doloženého Sezení nebo Herny' with 'ověřeného plánu …'", () => {
    const out = sanitizeKarelVisibleText("Vychází z pracovní hypotézy, ne z doloženého Sezení nebo Herny.");
    expect(out).toMatch(/ověřeného plánu Sezení nebo Herny/);
  });

  it("auditVisibleKarelText flags forbidden language", () => {
    const v = auditVisibleKarelText("Síla podkladů je low — payload říká truth gate ok.");
    expect(v.length).toBeGreaterThan(0);
  });

  it("auditVisibleKarelText returns empty on clean Czech text", () => {
    const cleaned = sanitizeKarelVisibleText(
      "Ranní podklady jsou vázané na dokončený denní cyklus z 2026-05-07T08:35:28.791+00:00. Síla podkladů je low.",
    );
    const v = auditVisibleKarelText(cleaned);
    expect(v).toEqual([]);
  });
});
