/**
 * P21 — Hana/Personal cross-surface DID ingestion classifier.
 *
 * Locks the regression seen in incident 2026-05-04:
 *   Hana/Personal messages mentioning kluci, Tundrupa, Arthur, Timmy/velryba
 *   were classified as personal_context_not_for_DID and never reached the
 *   operational pipeline.
 */

import { describe, it, expect } from "vitest";
import {
  classifyDidRelevance,
  normalizeEvent,
  __p21_internals,
} from "../../supabase/functions/_shared/didEventIngestion.ts";

const baseHana = {
  user_id: "00000000-0000-0000-0000-000000000001",
  source_table: "karel_hana_conversations",
  source_kind: "hana_personal_ingestion" as const,
  source_ref: "test:hana:1",
  occurred_at: "2026-05-03T20:00:00Z",
  author_role: "hanka",
  author_name: "Hanička",
  source_surface: "Hana/Osobní",
};

function classify(text: string, ref = "test:hana:" + Math.random()) {
  const ev = normalizeEvent({ ...baseHana, source_ref: ref, raw_excerpt: text });
  return { ev, c: classifyDidRelevance(ev) };
}

describe("P21 Hana/Personal DID ingestion", () => {
  it("pure intimate text without DID keywords is skipped (personal_context_not_for_DID)", () => {
    const { c } = classify("Lásko moje, moc mi chybíš a večer jsem byla venku s Locikem.");
    expect(c.entry_kind).toBe("skip");
    expect(c.evidence_level).toBe("personal_context_not_for_DID");
    expect(c.clinical_relevance).toBe(false);
    expect(c.operational_relevance).toBe(false);
  });

  it("Tundrupek mention → DID relevant, related_part_name=Tundrupek", () => {
    const { c } = classify("Tundrupek dnes večer ztichl a stáhl ramena.");
    expect(c.evidence_level).toBe("hana_personal_did_relevant");
    expect(c.related_part_name).toBe("Tundrupek");
    expect(c.clinical_relevance).toBe(true);
    expect(c.operational_relevance).toBe(true);
    expect(c.include_in_daily_briefing).toBe(true);
  });

  it("Tundrupa form is normalized to Tundrupek", () => {
    const { c } = classify("Hvězdy jsou K.G. a Tundrupa, vzpomínám na ně.");
    expect(c.related_part_name).toBe("Tundrupek");
    expect(c.evidence_level).toBe("hana_personal_did_relevant");
  });

  it("Artikovi / Arthur → related_part_name=Arthur", () => {
    const { c } = classify("Artikovi se to dnes nelíbilo, nechtěl mluvit.");
    expect(c.related_part_name).toBe("Arthur");
    expect(c.evidence_level).toBe("hana_personal_did_relevant");
  });

  it("kluci + Timmy/velryba → external reality emotional load, part fallback Tundrupek", () => {
    const { c } = classify(
      "Kluci jsou traumatizovaní díky transportu velryby Timmiho. Několik dní nemohou pořádně spinkat.",
    );
    expect(c.evidence_level).toBe("hana_personal_did_relevant");
    expect(c.clinical_relevance).toBe(true);
    expect(c.operational_relevance).toBe(true);
    // safe summary mentions Timmy/velryba as external reality, not raw intimate text
    expect(c.clinical_implication).toMatch(/velryby Timmy|vněj/i);
  });

  it("DID context word alone (kluci) → DID relevant", () => {
    const { c } = classify("Kluci dnes byli klidnější než včera, zvládli to.");
    expect(c.evidence_level).toBe("hana_personal_did_relevant");
    expect(c.clinical_relevance).toBe(true);
  });

  it("safe summary never echoes raw intimate text", () => {
    const intimate = "Miluji Tě nadevše a Tundrupek mě dnes překvapil.";
    const { c } = classify(intimate);
    expect(c.clinical_implication).not.toContain("Miluji");
    expect(c.clinical_implication).not.toContain("nadevše");
    expect(c.related_part_name).toBe("Tundrupek");
  });

  it("internal helper detectHanaPart matches all required forms", () => {
    expect(__p21_internals.detectHanaPart("Tundrupek")).toBe("Tundrupek");
    expect(__p21_internals.detectHanaPart("tundrupa")).toBe("Tundrupek");
    expect(__p21_internals.detectHanaPart("Artikovi")).toBe("Arthur");
    expect(__p21_internals.detectHanaPart("Arthur")).toBe("Arthur");
    expect(__p21_internals.detectHanaPart("Gustík")).toBe("gustik");
    expect(__p21_internals.detectHanaPart("Timmy")).toBe("Tundrupek");
    expect(__p21_internals.detectHanaPart("velryba")).toBe("Tundrupek");
    expect(__p21_internals.detectHanaPart("nic")).toBe(null);
  });
});
