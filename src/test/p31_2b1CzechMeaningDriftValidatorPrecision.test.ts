// P31.2B.1 — Czech meaning-drift validator precision.
// Verifies false-positive reductions for Czech inflection (Tundrupek →
// Tundrupka/Tundrupkovi/Tundrupkem) and ordinary capitalized non-part tokens
// (Herna/Hernu/Sezení/therapist names/sentence-initial words) while keeping
// hard guards for new unvalidated names, missing numbers, lost uncertainty,
// and provider-status flips.
import { describe, it, expect } from "vitest";
import {
  validateMeaningDrift,
  normalizeCzechToken,
  isLikelySameCzechName,
  isKnownNonPartCapitalizedToken,
  extractClinicalPartNamesFromPayload,
  generateKarelAiPolishCandidate,
} from "../../supabase/functions/_shared/karelBriefingVoiceAiPolish";
import { renderKarelBriefingVoice } from "../../supabase/functions/_shared/karelBriefingVoiceRenderer";

const known = (...names: string[]) => new Set(names);

describe("P31.2B.1 normalizeCzechToken / stem matcher", () => {
  it("normalizes diacritics and lowercases", () => {
    expect(normalizeCzechToken("Tundrupkovi")).toBe("tundrupkovi");
    expect(normalizeCzechToken("Gustík")).toBe("gustik");
  });

  it("accepts Tundrupek inflections as same name", () => {
    for (const v of ["Tundrupka", "Tundrupkovi", "Tundrupkem", "Tundrupek"]) {
      expect(isLikelySameCzechName("Tundrupek", v)).toBe(true);
    }
  });

  it("accepts Gustík inflections as same name", () => {
    for (const v of ["Gustíkem", "Gustíka", "Gustík"]) {
      expect(isLikelySameCzechName("Gustík", v)).toBe(true);
    }
  });

  it("prevents short-token false matches", () => {
    expect(isLikelySameCzechName("Han", "Hanka")).toBe(false);
    expect(isLikelySameCzechName("Kar", "Karel")).toBe(false);
    expect(isLikelySameCzechName("Tun", "Tundrupek")).toBe(false);
  });

  it("does not match completely different names sharing a 3-letter prefix", () => {
    expect(isLikelySameCzechName("Tundrupek", "Tunisko")).toBe(false);
    expect(isLikelySameCzechName("Gustík", "Gustav")).toBe(false);
  });
});

describe("P31.2B.1 non-part capitalized allowlist", () => {
  it("recognizes Herna family", () => {
    for (const t of ["Herna", "Hernu", "Herně", "Herny"]) {
      expect(isKnownNonPartCapitalizedToken(t)).toBe(true);
    }
  });
  it("recognizes Sezení family", () => {
    for (const t of ["Sezení", "Sezením"]) {
      expect(isKnownNonPartCapitalizedToken(t)).toBe(true);
    }
  });
  it("recognizes therapists / Karel as non-parts", () => {
    for (const t of ["Hanička", "Hanko", "Káťa", "Káťo", "Karel"]) {
      expect(isKnownNonPartCapitalizedToken(t)).toBe(true);
    }
  });
});

describe("P31.2B.1 validateMeaningDrift — false-positive reduction", () => {
  it("Tundrupek → Tundrupka does not flag missing_part_name", () => {
    const w = validateMeaningDrift(
      "Pro dnešek se nabízí Tundrupek.",
      "Dnes bych opatrně pracoval s Tundrupkou.",
      { knownPartNames: known("Tundrupek") },
    );
    expect(w.find((x) => x.startsWith("missing_part_name"))).toBeUndefined();
    expect(w.find((x) => x.startsWith("new_unvalidated"))).toBeUndefined();
  });

  it("Tundrupek → Tundrupkovi accepted", () => {
    const w = validateMeaningDrift(
      "Tundrupek dnes potřebuje klid.",
      "Tundrupkovi by dnes prospěl klid.",
      { knownPartNames: known("Tundrupek") },
    );
    expect(w).toEqual([]);
  });

  it("Gustík → Gustíkem accepted", () => {
    const w = validateMeaningDrift(
      "Gustík přichází opatrně.",
      "S Gustíkem postupuji opatrně.",
      { knownPartNames: known("Gustík") },
    );
    expect(w).toEqual([]);
  });

  it("Herna / Hernu do not trigger any warnings", () => {
    const w = validateMeaningDrift(
      "Pro Hernu mám připravený rámec.",
      "Hernu bych dnes držel jednoduše.",
      { knownPartNames: known("Tundrupek") },
    );
    expect(w).toEqual([]);
  });

  it("Sezení does not trigger missing_part_name", () => {
    const w = validateMeaningDrift(
      "Sezení proběhne v klidu.",
      "Sezením projdeme v klidu.",
      { knownPartNames: known() },
    );
    expect(w).toEqual([]);
  });

  it("Therapist names (Hanička/Káťa) do not trigger part-name warnings", () => {
    const w = validateMeaningDrift(
      "Hanička dnes vede sezení s Káťou.",
      "Haničko, dnes vedeš sezení s Káťou.",
      { knownPartNames: known() },
    );
    expect(w.find((x) => x.startsWith("missing_part_name"))).toBeUndefined();
    expect(w.find((x) => x.startsWith("new_unvalidated"))).toBeUndefined();
  });

  it("Sentence-initial generic words do not trigger entity warnings", () => {
    const w = validateMeaningDrift(
      "Pokud bude klid, pokračujeme.",
      "Dnes pokud bude klid, pokračujeme.",
      { knownPartNames: known() },
    );
    expect(w.find((x) => x.startsWith("new_unvalidated"))).toBeUndefined();
  });
});

describe("P31.2B.1 validateMeaningDrift — security preserved", () => {
  it("Tundrupek → Arthur rejected as missing + new entity", () => {
    const w = validateMeaningDrift(
      "Pro dnešek se nabízí Tundrupek.",
      "Pro dnešek se nabízí Arthur.",
      { knownPartNames: known("Tundrupek") },
    );
    expect(w).toContain("missing_part_name:Tundrupek");
    expect(w.some((x) => x.startsWith("new_unvalidated_capitalized_entity:Arthur"))).toBe(true);
  });

  it("Known part name removed entirely is rejected", () => {
    const w = validateMeaningDrift(
      "Tundrupek dnes potřebuje klid.",
      "Dnes potřebuje klid.",
      { knownPartNames: known("Tundrupek") },
    );
    expect(w).toContain("missing_part_name:Tundrupek");
  });

  it("Number preservation still works", () => {
    const w = validateMeaningDrift(
      "Dnes je 4 zdrojů.",
      "Dnes je X zdrojů.",
      {},
    );
    expect(w).toContain("missing_number:4");
  });

  it("Hypothesis marker preservation still works", () => {
    const w = validateMeaningDrift(
      "Toto je hypotéza založená na pozorování.",
      "Toto je založené na pozorování.",
      {},
    );
    expect(w).toContain("lost_hypothesis_marker");
  });

  it("Uncertainty → certainty still rejected", () => {
    const w = validateMeaningDrift(
      "Nemám dost podkladů.",
      "Vím to jistě.",
      {},
    );
    expect(w).toContain("turned_uncertainty_into_certainty");
  });

  it("Provider status flip still rejected", () => {
    const w = validateMeaningDrift(
      "Externí zdroj není zapnutý.",
      "Externí zdroj je dostupný.",
      {},
    );
    expect(w).toContain("flipped_provider_status");
  });

  it("Adding entirely unknown capitalized name flags new_unvalidated_capitalized_entity", () => {
    const w = validateMeaningDrift(
      "Dnes pracujeme.",
      "Dnes pracujeme s Belzebubem.",
      { knownPartNames: known() },
    );
    expect(w.some((x) => x.startsWith("new_unvalidated_capitalized_entity:Belzeb"))).toBe(true);
  });
});

describe("P31.2B.1 extractClinicalPartNamesFromPayload", () => {
  it("collects from today_part_proposal and external_reality_watch", () => {
    const set = extractClinicalPartNamesFromPayload({
      today_part_proposal: { proposed_part: "Tundrupek" },
      external_reality_watch: { parts: [{ part_name: "Gustík" }, { part_name: "Hanička" }] },
    });
    expect(set.has("Tundrupek")).toBe(true);
    expect(set.has("Gustík")).toBe(true);
    // Hanička is therapist — must be filtered out defensively.
    expect(set.has("Hanička")).toBe(false);
  });
});

describe("P31.2B.1 integration via generateKarelAiPolishCandidate", () => {
  const payload: any = {
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

  it("accepts polish that uses Tundrupkou and mentions Herna without flagging", async () => {
    const det = renderKarelBriefingVoice(payload);
    const r = await generateKarelAiPolishCandidate({
      payload,
      deterministic: det,
      forceEnableForCanary: true,
      __testFetcher: async (sections) => {
        const out: Record<string, string> = {};
        for (const s of sections) {
          // Inject Czech inflection of Tundrupek + an allowlisted word; otherwise keep original.
          const polished = s.original_text
            .replace(/Tundrupek/g, "Tundrupkou")
            .replace(/sezení/g, "Hernu");
          out[s.section_id] = polished;
        }
        return out;
      },
    });
    expect(r.attempted).toBe(true);
    // No section should be rejected purely due to Czech morphology / Herna.
    for (const s of r.sections) {
      // eslint-disable-next-line no-console
      console.log("DBG", s.section_id, s.polish_status, s.warnings, "ORIG=", s.original_text, "POL=", s.polished_text);
      const hasMorphologyFalsePositive =
        s.warnings.some((w) =>
          /missing_part_name:Tundrupek/.test(w) ||
          /new_unvalidated_capitalized_entity:(Hernu|Tundrupkou)/.test(w),
        );
      expect(hasMorphologyFalsePositive).toBe(false);
    }
  });

  it("still rejects polish that introduces a new unknown part name", async () => {
    const det = renderKarelBriefingVoice(payload);
    const r = await generateKarelAiPolishCandidate({
      payload,
      deterministic: det,
      forceEnableForCanary: true,
      __testFetcher: async (sections) => {
        const out: Record<string, string> = {};
        for (const s of sections) {
          out[s.section_id] = s.original_text.replace(/Tundrupek/g, "Belzebub");
        }
        return out;
      },
    });
    expect(r.attempted).toBe(true);
    // At least one section must be rejected due to drift.
    const rejected = r.sections.filter((s) => s.polish_status === "rejected_meaning_drift");
    expect(rejected.length).toBeGreaterThan(0);
  });
});
