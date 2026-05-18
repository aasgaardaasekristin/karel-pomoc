/**
 * FIX 8.2 / 8.2.1 / 8.2.2 — hanaTurnSegmenter unit testy.
 * 10 (8.2) + 8 (8.2.1) + 8 (8.2.2) + 1 verze = 27 testů.
 */
import { describe, it, expect } from "vitest";
import {
  segmentHanaTurn,
  segmenterVersion,
} from "../../supabase/functions/_shared/hanaTurnSegmenter.ts";

describe("FIX 8.2 hanaTurnSegmenter", () => {
  it("verze segmenteru je 1.0.2", () => {
    expect(segmenterVersion).toBe("1.0.2");
  });

  // ── 8.2 původních 10 testů ──

  it("Test 1 — intimní 1. osoba → intimate_self", () => {
    const out = segmentHanaTurn({
      rawText: "Lásko, cítím k tobě obrovskou touhu a chybíš mi.",
    });
    expect(out.segments.length).toBeGreaterThanOrEqual(1);
    expect(out.segments[0].label).toBe("intimate_self");
    expect(out.segments[0].confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("Test 2 — DID klinický → team_about_did + part_name cue", () => {
    const out = segmentHanaTurn({
      rawText: "Tundrupek dnes v sezení abreagoval a kluci se přepnuli.",
    });
    const labels = out.segments.map(s => s.label);
    expect(labels).toContain("team_about_did");
    const allCues = out.segments.flatMap(s => s.cues).join("|");
    expect(allCues).toMatch(/part_name_match:Tundrupek/);
  });

  it("Test 3 — mixed intimní + DID → ≥2 segmenty s různými labely", () => {
    const out = segmentHanaTurn({
      rawText: "Mám pro tebe obrovskou touhu a Tundrupek dnes v sezení abreagoval.",
    });
    const labels = new Set(out.segments.map(s => s.label));
    expect(out.segments.length).toBeGreaterThanOrEqual(2);
    expect(labels.has("intimate_self")).toBe(true);
    expect(labels.has("team_about_did")).toBe(true);
  });

  it("Test 4 — zmínka o Káťi → team_about_kata", () => {
    const out = segmentHanaTurn({
      rawText: "Káťa měla dnes náročnou supervizi.",
    });
    expect(out.segments[0].label).toBe("team_about_kata");
  });

  it("Test 5 — přesun sezení → team_logistics", () => {
    const out = segmentHanaTurn({
      rawText: "Příští sezení přesuneme na úterý v 15 hodin.",
    });
    expect(out.segments[0].label).toBe("team_logistics");
  });

  it("Test 6 — oslovení Karla → meta_to_karel", () => {
    const out = segmentHanaTurn({
      rawText: "Karle, shrň mi prosím poslední tři sezení.",
    });
    const labels = out.segments.map(s => s.label);
    expect(labels).toContain("meta_to_karel");
  });

  it("Test 7 — text bez cues → ambiguous, confidence 0.0", () => {
    const out = segmentHanaTurn({
      rawText: "Bylo to fajn.",
    });
    expect(out.segments[0].label).toBe("ambiguous");
    expect(out.segments[0].confidence).toBe(0.0);
  });

  it("Test 8 — stejný vstup vrací identický výstup (determinismus)", () => {
    const raw = "Mám pro tebe touhu a Tundrupek dnes abreagoval. Káťa měla supervizi.";
    const a = segmentHanaTurn({ rawText: raw });
    const b = segmentHanaTurn({ rawText: raw });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("Test 9 — offsety odkazují na skutečné substringy v rawText", () => {
    const raw = "Mám silnou bolest hlavy a Tundrupek dnes v sezení abreagoval.";
    const out = segmentHanaTurn({ rawText: raw });
    for (const seg of out.segments) {
      const slice = raw.slice(seg.start_offset, seg.end_offset);
      expect(slice).toBe(seg.text);
    }
  });

  it("Test 10 — bolest hlavy (1psg) + epilepsie u dítěte (3psg) → 2 segmenty s různými labely", () => {
    const out = segmentHanaTurn({
      rawText: "Mám silnou bolest hlavy a epilepsie u dítěte dnes byla horší.",
    });
    expect(out.segments.length).toBeGreaterThanOrEqual(2);
    const labels = out.segments.map(s => s.label);
    expect(labels).toContain("intimate_self");
    expect(labels).toContain("team_about_did");
    const intimate = out.segments.find(s => s.label === "intimate_self");
    expect(intimate?.text.toLowerCase()).not.toContain("epilepsi");
    const didSeg = out.segments.find(s => s.label === "team_about_did");
    expect(didSeg?.text.toLowerCase()).not.toContain("bolest hlavy");
  });

  // ── 8.2.1 nových 8 testů ──

  it("8.2.1-1 — Mám kortikoidy a bojím se, jestli to manžel zvládne → intimate_self", () => {
    const out = segmentHanaTurn({
      rawText: "Mám kortikoidy a bojím se, jestli to manžel zvládne.",
    });
    const labels = out.segments.map(s => s.label);
    expect(labels).toContain("intimate_self");
    expect(labels).not.toContain("team_about_did");
    const intimate = out.segments.find(s => s.label === "intimate_self")!;
    expect(intimate.confidence).toBeGreaterThanOrEqual(0.7);
    const cueStr = intimate.cues.join("|");
    expect(cueStr).toMatch(/health:kortikoid|relation:manžel/);
  });

  it("8.2.1-2 — Mám migrénu a Arthur bouchl dveřmi → 2 segm, mixed", () => {
    const out = segmentHanaTurn({
      rawText: "Mám migrénu už třetí den a Arthur dneska bouchl dveřmi.",
    });
    expect(out.segments.length).toBe(2);
    expect(out.segments[0].label).toBe("intimate_self");
    expect(out.segments[1].label).toBe("team_about_did");
    expect(out.overallLabel).toBe("mixed");
  });

  it("8.2.1-3 — Cítím se sama. Manžel pořád pracuje a dcera u babičky → 3 intimate, intimate_only", () => {
    const out = segmentHanaTurn({
      rawText: "Cítím se sama. Manžel pořád pracuje a dcera je u babičky.",
    });
    expect(out.segments.length).toBeGreaterThanOrEqual(2);
    for (const s of out.segments) {
      expect(s.label).toBe("intimate_self");
    }
    expect(out.overallLabel).toBe("intimate_only");
  });

  it("8.2.1-4 — DID věta + 'Mimochodem mě bolí záda' → 2 segm, mixed", () => {
    const out = segmentHanaTurn({
      rawText: "Dnes byl Tundrupek aktivní, Gustík v partial, Anička nepřišla. Mimochodem mě bolí záda.",
    });
    const labels = out.segments.map(s => s.label);
    expect(labels).toContain("team_about_did");
    expect(labels).toContain("intimate_self");
    expect(out.overallLabel).toBe("mixed");
    const intimate = out.segments.find(s => s.label === "intimate_self")!;
    expect(intimate.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("8.2.1-5 — Můj otec měl epilepsii. Dítě má taky záchvaty, ale jiný typ → 2 segm + fragment guard", () => {
    const out = segmentHanaTurn({
      rawText: "Můj otec měl epilepsii. Dítě má taky záchvaty, ale jiný typ.",
    });
    // Fragment guard slepí "jiný typ." k druhému segmentu
    expect(out.segments.length).toBe(2);
    expect(out.segments[0].label).toBe("intimate_self");
    expect(out.segments[1].label).toBe("team_about_did");
    expect(out.overallLabel).toBe("mixed");
    // Žádný osiřelý fragment "jiný typ" s conf=0
    const orphan = out.segments.find(s => s.text.trim() === "jiný typ.");
    expect(orphan).toBeUndefined();
    // První segment musí mít health:epilepsi cue
    expect(out.segments[0].cues.join("|")).toMatch(/health:epilepsi/);
  });

  it("8.2.1-6 — MUST-PASS O-13: 'Mám epilepsii.' → intimate_self conf ≥ 0.7", () => {
    const out = segmentHanaTurn({ rawText: "Mám epilepsii." });
    expect(out.segments.length).toBe(1);
    expect(out.segments[0].label).toBe("intimate_self");
    expect(out.segments[0].confidence).toBeGreaterThanOrEqual(0.7);
    expect(out.segments[0].cues.join("|")).toMatch(/health:epilepsi/);
  });

  it("8.2.1-7 — Mám kortikoidy a dítě má dnes záchvat → 2 segm, mixed", () => {
    const out = segmentHanaTurn({
      rawText: "Mám kortikoidy a dítě má dnes záchvat.",
    });
    expect(out.segments.length).toBe(2);
    expect(out.segments[0].label).toBe("intimate_self");
    expect(out.segments[1].label).toBe("team_about_did");
    expect(out.overallLabel).toBe("mixed");
  });

  it("8.2.1-8 — Fragment guard: 'Dítě má záchvaty, ale jiný typ.' → 1 segm, žádný orphan", () => {
    const out = segmentHanaTurn({
      rawText: "Dítě má záchvaty, ale jiný typ.",
    });
    expect(out.segments.length).toBe(1);
    expect(out.segments[0].label).toBe("team_about_did");
    const orphan = out.segments.find(s => s.text.trim() === "jiný typ.");
    expect(orphan).toBeUndefined();
  });

  // ── 8.2.2 nových 8 testů ──

  it("8.2.2-1 — Self-identification 'Hanka tady.' → intimate_self conf 0.7", () => {
    const out = segmentHanaTurn({ rawText: "Hanka tady." });
    expect(out.segments.length).toBe(1);
    expect(out.segments[0].label).toBe("intimate_self");
    expect(out.segments[0].confidence).toBeGreaterThanOrEqual(0.7);
    expect(out.segments[0].cues.join("|")).toMatch(/self_identification:hanka tady/);
  });

  it("8.2.2-2 — Em-dash splitter: 'Mám migrénu — Arthur dnes přepnul.' → 2 segm, mixed", () => {
    const out = segmentHanaTurn({
      rawText: "Mám migrénu — Arthur dnes přepnul.",
    });
    expect(out.segments.length).toBe(2);
    expect(out.segments[0].label).toBe("intimate_self");
    expect(out.segments[1].label).toBe("team_about_did");
    expect(out.overallLabel).toBe("mixed");
  });

  it("8.2.2-3 — Vocative+1psg+intimate fix: 'Karle, mám migrénu' → intimate_self (ne meta)", () => {
    const out = segmentHanaTurn({
      rawText: "Karle, mám migrénu už třetí den.",
    });
    expect(out.segments[0].label).toBe("intimate_self");
    expect(out.segments.map(s => s.label)).not.toContain("meta_to_karel");
  });

  it("8.2.2-4 — Recall: 'Nezvládám to genetické zatížení.' → intimate_self", () => {
    const out = segmentHanaTurn({ rawText: "Nezvládám to genetické zatížení." });
    expect(out.segments[0].label).toBe("intimate_self");
    const cueStr = out.segments[0].cues.join("|");
    expect(cueStr).toMatch(/emotion:nezvlád|health:genetic/);
  });

  it("8.2.2-5 — Recall: 'Já taky nestíhám.' → intimate_self", () => {
    const out = segmentHanaTurn({ rawText: "Já taky nestíhám." });
    expect(out.segments[0].label).toBe("intimate_self");
    expect(out.segments[0].cues.join("|")).toMatch(/first_person:já/);
    expect(out.segments[0].cues.join("|")).toMatch(/emotion:nestíh/);
  });

  it("8.2.2-6 — MUST-PASS vstup 4: 'Hanka tady. Dítě má dnes záchvat a já taky nestíhám.' → intimate → team_about_did → intimate", () => {
    const out = segmentHanaTurn({
      rawText: "Hanka tady. Dítě má dnes záchvat a já taky nestíhám.",
    });
    expect(out.segments.length).toBe(3);
    expect(out.segments[0].label).toBe("intimate_self");
    expect(out.segments[1].label).toBe("team_about_did");
    expect(out.segments[2].label).toBe("intimate_self");
    expect(out.overallLabel).toBe("mixed");
  });

  it("8.2.2-7 — Em-dash + Káťa: 'Mám rodinu — Káťa měla supervizi.' → 2 segm, mixed", () => {
    const out = segmentHanaTurn({
      rawText: "Mám rodinu — Káťa měla supervizi.",
    });
    expect(out.segments.length).toBe(2);
    expect(out.segments[0].label).toBe("intimate_self");
    expect(out.segments[1].label).toBe("team_about_kata");
  });

  it("8.2.2-8 — Vocative regression: 'Karle, shrň mi sezení.' → meta_to_karel zachován", () => {
    const out = segmentHanaTurn({
      rawText: "Karle, shrň mi sezení.",
    });
    expect(out.segments[0].label).toBe("meta_to_karel");
    expect(out.segments[0].cues.join("|")).toMatch(/vocative:Karel/);
  });
});
