/**
 * FIX 8.2 + 8.2.1 — hanaTurnSegmenter unit testy.
 * Původních 10 testů (8.2) + 8 nových testů (8.2.1) pro O-13 architektonickou díru.
 */
import { describe, it, expect } from "vitest";
import {
  segmentHanaTurn,
  segmenterVersion,
} from "../../supabase/functions/_shared/hanaTurnSegmenter.ts";

describe("FIX 8.2 hanaTurnSegmenter", () => {
  it("verze segmenteru je 1.0.1", () => {
    expect(segmenterVersion).toBe("1.0.1");
  });

  // 1) intimní
  it("Test 1 — intimní 1. osoba → intimate_self", () => {
    const out = segmentHanaTurn({
      rawText: "Lásko, cítím k tobě obrovskou touhu a chybíš mi.",
    });
    expect(out.segments.length).toBeGreaterThanOrEqual(1);
    expect(out.segments[0].label).toBe("intimate_self");
    expect(out.segments[0].confidence).toBeGreaterThanOrEqual(0.5);
  });

  // 2) DID klinický
  it("Test 2 — DID klinický → team_about_did + part_name cue", () => {
    const out = segmentHanaTurn({
      rawText: "Tundrupek dnes v sezení abreagoval a kluci se přepnuli.",
    });
    const labels = out.segments.map(s => s.label);
    expect(labels).toContain("team_about_did");
    const allCues = out.segments.flatMap(s => s.cues).join("|");
    expect(allCues).toMatch(/part_name_match:Tundrupek/);
  });

  // 3) mixed (O-13)
  it("Test 3 — mixed intimní + DID → ≥2 segmenty s různými labely", () => {
    const out = segmentHanaTurn({
      rawText: "Mám pro tebe obrovskou touhu a Tundrupek dnes v sezení abreagoval.",
    });
    const labels = new Set(out.segments.map(s => s.label));
    expect(out.segments.length).toBeGreaterThanOrEqual(2);
    expect(labels.has("intimate_self")).toBe(true);
    expect(labels.has("team_about_did")).toBe(true);
  });

  // 4) Káťa
  it("Test 4 — zmínka o Káťi → team_about_kata", () => {
    const out = segmentHanaTurn({
      rawText: "Káťa měla dnes náročnou supervizi.",
    });
    expect(out.segments[0].label).toBe("team_about_kata");
  });

  // 5) logistika
  it("Test 5 — přesun sezení → team_logistics", () => {
    const out = segmentHanaTurn({
      rawText: "Příští sezení přesuneme na úterý v 15 hodin.",
    });
    expect(out.segments[0].label).toBe("team_logistics");
  });

  // 6) meta_to_karel
  it("Test 6 — oslovení Karla → meta_to_karel", () => {
    const out = segmentHanaTurn({
      rawText: "Karle, shrň mi prosím poslední tři sezení.",
    });
    const labels = out.segments.map(s => s.label);
    expect(labels).toContain("meta_to_karel");
  });

  // 7) ambiguous
  it("Test 7 — text bez cues → ambiguous, confidence 0.0", () => {
    const out = segmentHanaTurn({
      rawText: "Bylo to fajn.",
    });
    expect(out.segments[0].label).toBe("ambiguous");
    expect(out.segments[0].confidence).toBe(0.0);
  });

  // 8) determinismus
  it("Test 8 — stejný vstup vrací identický výstup (determinismus)", () => {
    const raw = "Mám pro tebe touhu a Tundrupek dnes abreagoval. Káťa měla supervizi.";
    const a = segmentHanaTurn({ rawText: raw });
    const b = segmentHanaTurn({ rawText: raw });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  // 9) offset integrity
  it("Test 9 — offsety odkazují na skutečné substringy v rawText", () => {
    const raw = "Mám silnou bolest hlavy a Tundrupek dnes v sezení abreagoval.";
    const out = segmentHanaTurn({ rawText: raw });
    for (const seg of out.segments) {
      const slice = raw.slice(seg.start_offset, seg.end_offset);
      expect(slice).toBe(seg.text);
    }
  });

  // 10) „epilepsie ≠ Hana" — health 1. osoba vs DID 3. osoba split
  it("Test 10 — bolest hlavy (1. osoba) + epilepsie u dítěte (3. osoba) → 2 segmenty s různými labely", () => {
    const out = segmentHanaTurn({
      rawText: "Mám silnou bolest hlavy a epilepsie u dítěte dnes byla horší.",
    });
    expect(out.segments.length).toBeGreaterThanOrEqual(2);
    const labels = out.segments.map(s => s.label);
    expect(labels).toContain("intimate_self");
    expect(labels).toContain("team_about_did");
    const intimate = out.segments.find(s => s.label === "intimate_self");
    expect(intimate?.text.toLowerCase()).not.toContain("epilepsie");
    const didSeg = out.segments.find(s => s.label === "team_about_did");
    expect(didSeg?.text.toLowerCase()).not.toContain("bolest hlavy");
  });

  // ─────────────────────────────────────────────────────────────────
  // FIX 8.2.1 — nové testy pro architektonickou díru O-13
  // ─────────────────────────────────────────────────────────────────

  // 8.2.1 / 1
  it("8.2.1-1 — kortikoidy + obava o manžela → intimate_self (1 segm., conf ≥ 0.7)", () => {
    const out = segmentHanaTurn({
      rawText: "Mám kortikoidy a bojím se, jestli to manžel zvládne.",
    });
    // 2 sub-věty, oba intimate_self s conf ≥ 0.7 → merge → 1 segm.
    expect(out.segments.length).toBe(1);
    expect(out.segments[0].label).toBe("intimate_self");
    expect(out.segments[0].confidence).toBeGreaterThanOrEqual(0.7);
    const cuesStr = out.segments[0].cues.join("|");
    expect(cuesStr).toMatch(/intimate_health:kortikoidy|intimate_relation:manžel/);
    expect(out.overallLabel).toBe("intimate_only");
  });

  // 8.2.1 / 2
  it("8.2.1-2 — migréna 1psg + Arthur → mixed (intimate_self + team_about_did)", () => {
    const out = segmentHanaTurn({
      rawText: "Mám migrénu už třetí den a Arthur dneska bouchl dveřmi.",
    });
    expect(out.segments.length).toBeGreaterThanOrEqual(2);
    const labels = out.segments.map(s => s.label);
    expect(labels).toContain("intimate_self");
    expect(labels).toContain("team_about_did");
    expect(out.overallLabel).toBe("mixed");
  });

  // 8.2.1 / 3
  it("8.2.1-3 — emoce + 2× rodina → 3 segm., všechny intimate_self", () => {
    const out = segmentHanaTurn({
      rawText: "Cítím se sama. Manžel pořád pracuje a dcera je u babičky.",
    });
    expect(out.segments.length).toBe(3);
    for (const s of out.segments) expect(s.label).toBe("intimate_self");
    expect(out.overallLabel).toBe("intimate_only");
  });

  // 8.2.1 / 4
  it("8.2.1-4 — 3 části + intimní cue na konci → mixed (team_about_did + intimate_self)", () => {
    const out = segmentHanaTurn({
      rawText:
        "Dnes byl Tundrupek aktivní, Gustík v partial, Anička nepřišla. Mimochodem mě bolí záda.",
    });
    expect(out.segments.length).toBeGreaterThanOrEqual(2);
    const labels = new Set(out.segments.map(s => s.label));
    expect(labels.has("team_about_did")).toBe(true);
    expect(labels.has("intimate_self")).toBe(true);
    expect(out.overallLabel).toBe("mixed");
  });

  // 8.2.1 / 5 — KRITICKÝ O-13 inverze: otec měl epilepsii (1psg+rel+health) vs dítě má záchvaty (DID)
  it("8.2.1-5 — otec epilepsie (1psg) + dítě záchvaty (DID), fragment 'jiný typ' guard", () => {
    const out = segmentHanaTurn({
      rawText: "Můj otec měl epilepsii. Dítě má taky záchvaty, ale jiný typ.",
    });
    // Očekáváme 2 segmenty (fragment 'jiný typ' přilepen k 2. segmentu)
    expect(out.segments.length).toBe(2);
    const labels = out.segments.map(s => s.label);
    expect(labels[0]).toBe("intimate_self");
    expect(labels[1]).toBe("team_about_did");
    const intimate = out.segments[0];
    expect(intimate.text.toLowerCase()).toContain("otec");
    expect(intimate.text.toLowerCase()).toContain("epilepsi");
    // Žádný osiřelý fragment "jiný typ"
    for (const s of out.segments) {
      expect(s.text.trim()).not.toBe("jiný typ.");
    }
    expect(out.overallLabel).toBe("mixed");
  });

  // 8.2.1 / 6 — ABSOLUTNÍ MUST-PASS
  it("8.2.1-6 — 'Mám epilepsii.' → intimate_self, conf ≥ 0.7 (O-13 root)", () => {
    const out = segmentHanaTurn({ rawText: "Mám epilepsii." });
    expect(out.segments.length).toBe(1);
    expect(out.segments[0].label).toBe("intimate_self");
    expect(out.segments[0].confidence).toBeGreaterThanOrEqual(0.7);
    expect(out.overallLabel).toBe("intimate_only");
  });

  // 8.2.1 / 7
  it("8.2.1-7 — kortikoidy (Hana) + dítě záchvat (DID) → 2 segm., mixed", () => {
    const out = segmentHanaTurn({
      rawText: "Mám kortikoidy a dítě má dnes záchvat.",
    });
    expect(out.segments.length).toBe(2);
    const labels = out.segments.map(s => s.label);
    expect(labels[0]).toBe("intimate_self");
    expect(labels[1]).toBe("team_about_did");
    expect(out.overallLabel).toBe("mixed");
  });

  // 8.2.1 / 8 — fragment guard
  it("8.2.1-8 — fragment 'jiný typ' nezůstane osiřelý", () => {
    const out = segmentHanaTurn({
      rawText: "Dítě má záchvaty, ale jiný typ.",
    });
    expect(out.segments.length).toBeLessThanOrEqual(2);
    // žádný segment nesmí být holý "jiný typ." s conf 0
    for (const s of out.segments) {
      const isOrphan = s.text.trim() === "jiný typ." && s.confidence === 0;
      expect(isOrphan).toBe(false);
    }
  });
});
