/**
 * P33.8A — Hana personal clinical intelligence extraction.
 *
 * Locks the regression where Hana/osobní messages mixing intimate content,
 * DID-relevant observation, external trigger reports, and privacy
 * instructions were collapsed into a single classification, dropping the
 * external trigger lookup, the part-card review entry, and the privacy
 * memory rule.
 */

import { describe, it, expect } from "vitest";
import {
  classifyHanaPersonalMessage,
  __p33_8a_internals,
} from "../../supabase/functions/_shared/hanaPersonalSemanticClassifier.ts";

const PILOT_WHALE_FIXTURE = `Lásko moje, dnes večer Tundrupek hodně plakal. Bolelo ho srdíčko, když viděl video z Faerských ostrovů,
jak tam vraždí stáda kulohlavců a moře bylo zbarvené do ruda. Kluci pak hledali informace
o rtuti v tuku a svalech kulohlavců a začali plánovat, jak lidi zastrašit přes nemoci.
Amálka poslala pozvánku, leží v pokoji. Ke Dni matek mě mrzí, že nikdo nepřinesl kytku.
V Brně XY zase tlačí na kontrolu peněz a děti z toho mají strach.
Nechci, aby tohle Artík v žádném reportu četl. Cítím vinu a strach ze smrti.`;

function ofType(items: any[], t: string) {
  return items.filter((i) => i.type === t);
}

describe("P33.8A Hana personal semantic classifier", () => {
  it("speaker is always hana_therapist", () => {
    const r = classifyHanaPersonalMessage({ text: "cokoliv" });
    expect(r.speaker).toBe("hana_therapist");
  });

  it("private intimate content classified hana_private_intimate / never_child_visible", () => {
    const r = classifyHanaPersonalMessage({
      text: "Miluji tě nadevše. Cítím vinu a smrt mě tíží.",
    });
    const intimate = ofType(r.content_items, "hana_private_intimate");
    expect(intimate.length).toBeGreaterThan(0);
    expect(intimate[0].privacy).toBe("never_child_visible");
    expect(intimate[0].child_visible_summary_allowed).toBe(false);
  });

  it("Hana mentions Tundrupek with body/affect → did_relevant_observation, not part speech", () => {
    const r = classifyHanaPersonalMessage({
      text: "Tundrupek dnes večer plakal, bolelo ho srdíčko.",
    });
    const obs = ofType(r.content_items, "did_relevant_observation");
    expect(obs.length).toBe(1);
    expect(obs[0].related_parts).toContain("Tundrupek");
    expect(obs[0].privacy).toBe("did_clinical_memory");
    expect(obs[0].raw_text_allowed_in_drive).toBe(false);
  });

  it("pilot-whale fixture extracts DID observation about Tundrupek", () => {
    const r = classifyHanaPersonalMessage({ text: PILOT_WHALE_FIXTURE });
    const obs = ofType(r.content_items, "did_relevant_observation");
    expect(obs.length).toBe(1);
    expect(obs[0].related_parts).toContain("Tundrupek");
    expect(obs[0].clinical_summary).toMatch(/Tundrupek/);
    expect(obs[0].clinical_summary).not.toMatch(/Lásko moje/);
    expect(obs[0].clinical_summary).not.toMatch(/vinu/i);
  });

  it("pilot-whale fixture extracts external trigger lookup with query terms", () => {
    const r = classifyHanaPersonalMessage({ text: PILOT_WHALE_FIXTURE });
    const ext = ofType(r.content_items, "external_trigger_report");
    expect(ext.length).toBe(1);
    expect(ext[0].external_trigger_terms.join(" ")).toMatch(/Faerské|kulohlavci|Grindadráp/i);
    expect(ext[0].recommended_routes).toContain("external_trigger_lookup");
  });

  it("privacy instruction blocks child-visible output", () => {
    const r = classifyHanaPersonalMessage({ text: PILOT_WHALE_FIXTURE });
    const priv = ofType(r.content_items, "safety_privacy_instruction");
    expect(priv.length).toBe(1);
    expect(priv[0].privacy).toBe("therapist_only");
    expect(priv[0].child_visible_summary_allowed).toBe(false);
    expect(priv[0].recommended_routes).toContain("privacy_constraint_memory");
  });

  it("intimate fragment in pilot-whale fixture stays as private item, never in DID summary", () => {
    const r = classifyHanaPersonalMessage({ text: PILOT_WHALE_FIXTURE });
    const intimate = ofType(r.content_items, "hana_private_intimate");
    expect(intimate.length).toBeGreaterThan(0);
    const obs = ofType(r.content_items, "did_relevant_observation")[0];
    expect(obs.clinical_summary).not.toMatch(/Lásko/);
    expect(obs.clinical_summary).not.toMatch(/sm[rř]t/);
  });

  it("Den matek / kytka / Brno / XY / kontroly classified household_logistical", () => {
    const r = classifyHanaPersonalMessage({
      text: "Ke Dni matek mě mrzí, že nikdo nepřinesl kytku. V Brně XY zase tlačí na kontrolu peněz.",
    });
    const hh = ofType(r.content_items, "household_logistical");
    expect(hh.length).toBe(1);
    expect(hh[0].child_visible_summary_allowed).toBe(false);
  });

  it("raw_text_allowed_in_drive is hard false on every item", () => {
    const r = classifyHanaPersonalMessage({ text: PILOT_WHALE_FIXTURE });
    for (const item of r.content_items) {
      expect(item.raw_text_allowed_in_drive).toBe(false);
    }
  });

  it("internal helpers detect parts and triggers", () => {
    expect(__p33_8a_internals.detectParts("Tundrupek je smutný")).toContain("Tundrupek");
    expect(__p33_8a_internals.detectParts("Artíkovi to vadilo")).toContain("Arthur");
    const trgs = __p33_8a_internals.detectExternalTriggers(PILOT_WHALE_FIXTURE);
    expect(trgs.length).toBeGreaterThan(0);
    expect(trgs[0].terms.join(" ")).toMatch(/Faerské|kulohlavci/i);
  });

  it("text without DID signals defaults to hana_private_only memory route", () => {
    const r = classifyHanaPersonalMessage({ text: "Dnes byl prostě klidný den, nic víc." });
    const items = r.content_items;
    expect(items.length).toBe(1);
    expect(items[0].privacy).toBe("hana_private_only");
    expect(items[0].recommended_routes).toEqual(["hana_personal_memory_private"]);
  });
});
