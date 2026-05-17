/**
 * FIX 8.2 — hanaTurnSegmenter unit testy.
 * 10 testů dle briefu: pure deterministická segmentace Hančiných tahů.
 */
import { describe, it, expect } from "vitest";
import {
  segmentHanaTurn,
  segmenterVersion,
} from "../../supabase/functions/_shared/hanaTurnSegmenter.ts";

describe("FIX 8.2 hanaTurnSegmenter", () => {
  it("verze segmenteru je 1.0.0", () => {
    expect(segmenterVersion).toBe("1.0.0");
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
    // intimate_self segment NESMÍ obsahovat "epilepsie"
    const intimate = out.segments.find(s => s.label === "intimate_self");
    expect(intimate?.text.toLowerCase()).not.toContain("epilepsie");
    // team_about_did segment NESMÍ obsahovat "bolest hlavy"
    const didSeg = out.segments.find(s => s.label === "team_about_did");
    expect(didSeg?.text.toLowerCase()).not.toContain("bolest hlavy");
  });
});
