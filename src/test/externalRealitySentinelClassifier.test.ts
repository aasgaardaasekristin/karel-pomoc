/**
 * P7: External Reality Sentinel — classifier patterns guard test
 *
 * Tento test NEspouští edge funkci. Drží referenční regex chování,
 * aby se nikdy omylem nepřestal chytat:
 *  - Tundrupek scénář: Timmy / velryba / týrání zvířat
 *  - Arthur scénář: Arthur Labinjo-Hughes / týrání dítěte
 *  - "real event" hint detekce (článek, zpráva, médi…)
 *
 * Pokud se regex v supabase/functions/karel-external-reality-sentinel/index.ts
 * změní, tento test musí být updatován vědomě.
 */

import { describe, expect, it } from "vitest";

// Mirror of patterns from the edge function (Czech via Unicode escapes)
const REAL_EVENT_HINTS = [
  /skute\u010Dn[\u00E9\u00FD]/i, /re\u00E1ln[\u00E9\u00FD]/i, /\u010Dl\u00E1nek/i,
  /zpr\u00E1va/i, /internet/i, /p\u0159\u00EDpad/i, /soud/i, /\bnews\b/i,
  /\bvideo\b/i, /\bm\u00E9di/i, /TV/i, /tisk/i,
];

const PATTERNS: Array<{ re: RegExp; event_type: string; term: string }> = [
  { re: /velryb/i, event_type: "animal_suffering", term: "velryba" },
  { re: /\bTimmy\b/i, event_type: "animal_suffering", term: "Timmy" },
  { re: /t[\u00FDy]r[\u00E1a]n[\u00ED] zv[\u00ED]\u0159at/i, event_type: "animal_suffering", term: "tyrání zvířat" },
  { re: /Arthur Labinjo-Hughes/i, event_type: "child_abuse", term: "Arthur Labinjo-Hughes" },
  { re: /t[\u00FDy]r[\u00E1a]n[\u00ED] d[\u00ED]t[\u011Be]/i, event_type: "child_abuse", term: "týrání dítěte" },
];

function classify(text: string) {
  const triggersReal = REAL_EVENT_HINTS.some((re) => re.test(text));
  const hits = PATTERNS.filter((p) => p.re.test(text));
  return { triggersReal, eventTypes: hits.map((h) => h.event_type), terms: hits.map((h) => h.term) };
}

describe("P7 classifier — Tundrupek scenarios", () => {
  it("matches Timmy by name", () => {
    const r = classify("Tundrupek dnes znovu mluvil o Timmym a chtěl vědět jak se má.");
    expect(r.eventTypes).toContain("animal_suffering");
    expect(r.terms).toContain("Timmy");
  });

  it("matches velryba", () => {
    const r = classify("Viděl video o velrybě v zajetí.");
    expect(r.eventTypes).toContain("animal_suffering");
    expect(r.terms).toContain("velryba");
  });

  it("matches tyranie zvirat with diacritics", () => {
    const r = classify("V médiích byl případ týrání zvířat.");
    expect(r.eventTypes).toContain("animal_suffering");
    expect(r.triggersReal).toBe(true);
  });
});

describe("P7 classifier — Arthur scenarios", () => {
  it("matches Arthur Labinjo-Hughes by full name", () => {
    const r = classify("Vyšel článek o případu Arthur Labinjo-Hughes na webu.");
    expect(r.eventTypes).toContain("child_abuse");
    expect(r.terms).toContain("Arthur Labinjo-Hughes");
    expect(r.triggersReal).toBe(true);
  });

  it("matches týrání dítěte", () => {
    const r = classify("Reálný případ týrání dítěte.");
    expect(r.eventTypes).toContain("child_abuse");
    expect(r.triggersReal).toBe(true);
  });
});

describe("P7 classifier — real-event hint detection", () => {
  it("detects 'článek'", () => expect(classify("nový článek").triggersReal).toBe(true));
  it("detects 'média'", () => expect(classify("v médiích").triggersReal).toBe(true));
  it("does NOT mark plain text as real event", () => {
    expect(classify("Tundrupek si hraje s plyšákem.").triggersReal).toBe(false);
  });
});

describe("P7 classifier — no false positives", () => {
  it("ignores unrelated text", () => {
    const r = classify("Dnes byla pohoda, šli jsme na procházku.");
    expect(r.eventTypes).toHaveLength(0);
  });

  it("does not match 'Tim' as Timmy (word boundary)", () => {
    const r = classify("Mluvili jsme o Timovi (kamarád).");
    expect(r.terms).not.toContain("Timmy");
  });
});
