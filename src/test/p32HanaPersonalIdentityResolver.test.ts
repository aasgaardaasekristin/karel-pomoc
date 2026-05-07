/**
 * P32 — Hana personal identity resolution tests.
 */
import { describe, it, expect } from "vitest";
import {
  resolveHanaPersonalIdentity,
  renderIdentityContextBlock,
  isHanaAlias,
  isLikelySamePartName,
} from "../../supabase/functions/_shared/hanaPersonalIdentityResolver.ts";

const knownParts = [
  { canonical_part_name: "Gustík", aliases: ["Gusti"] },
  { canonical_part_name: "Tundrupek" },
  { canonical_part_name: "Arthur", aliases: ["Artík"] },
];

function r(text: string) {
  return resolveHanaPersonalIdentity({ text, knownParts, surface: "hana_personal" });
}

describe("P32 hanaPersonalIdentityResolver — pure resolver", () => {
  it("Hana aliases are never DID parts", () => {
    for (const a of ["hana", "Hanka", "Hanička", "Hani", "Hanicka", "Haničko", "Hanko", "mamka", "Maminka"]) {
      expect(isHanaAlias(a)).toBe(true);
    }
  });

  it("speaker is always hana_therapist in hana_personal", () => {
    expect(r("Cokoliv tady").speaker_identity).toBe("hana_therapist");
    expect(r("").speaker_identity).toBe("hana_therapist");
  });

  it("hana_self: Já už nemůžu, Karle", () => {
    const x = r("Já už nemůžu, Karle");
    expect(x.resolution_kind).toBe("hana_self");
    expect(x.mentioned_parts).toEqual([]);
    expect(x.should_create_part_card_update).toBe(false);
    expect(x.should_create_hana_memory).toBe(true);
    expect(x.recommended_memory_targets.some((t) => t.includes("HANKA/SITUACNI_ANALYZA"))).toBe(true);
  });

  it("hana_self: Hanička se dnes bojí, že to nezvládne", () => {
    const x = r("Hanička se dnes bojí, že to nezvládne");
    expect(x.resolution_kind).toBe("hana_self");
    expect(x.mentioned_parts).toEqual([]);
  });

  it("hana_self: Mám pocit, že jsem špatná", () => {
    const x = r("Mám pocit, že jsem špatná");
    expect(x.resolution_kind).toBe("hana_self");
  });

  it("hana_mentions_part: Mluvila jsem s Gustíkem", () => {
    const x = r("Mluvila jsem s Gustíkem");
    expect(x.resolution_kind).toBe("hana_mentions_part");
    expect(x.mentioned_parts.map((p) => p.canonical_part_name)).toContain("Gustík");
    expect(x.speaker_identity).toBe("hana_therapist");
    expect(x.should_switch_speaker_to_part).toBe(false);
  });

  it("hana_mentions_part: Gustík se dnes bál (no speaker switch)", () => {
    const x = r("Gustík se dnes bál");
    expect(x.resolution_kind).toBe("hana_mentions_part");
    expect(x.mentioned_parts[0].canonical_part_name).toBe("Gustík");
    expect(x.should_switch_speaker_to_part).toBe(false);
  });

  it("Gustík inflections resolve (Gustíkem)", () => {
    expect(r("Gustíkem to dnes hodně pohnulo").mentioned_parts[0]?.canonical_part_name).toBe("Gustík");
  });

  it("Tundrupek inflections resolve", () => {
    expect(r("Tundrupkovi je dnes smutno").mentioned_parts[0]?.canonical_part_name).toBe("Tundrupek");
    expect(r("S Tundrupkem to bylo těžké").mentioned_parts[0]?.canonical_part_name).toBe("Tundrupek");
  });

  it("Arthur inflections resolve (Artíkem)", () => {
    expect(r("Artíkovi to nešlo").mentioned_parts[0]?.canonical_part_name).toBe("Arthur");
  });

  it("hana_mentions_group_kluci: Kluci dnes byli stažení", () => {
    const x = r("Kluci dnes byli hodně stažení");
    expect(x.resolution_kind).toBe("hana_mentions_group_kluci");
    expect(x.mentioned_groups).toContain("kluci");
    expect(x.mentioned_parts).toEqual([]);
    expect(x.should_create_part_card_update).toBe(false);
  });

  it("Hana je unavená → hana_self, not part", () => {
    const x = r("Hana je dnes unavená");
    expect(x.resolution_kind).toBe("hana_self");
    expect(x.mentioned_parts).toEqual([]);
  });

  it("\"část Hana\" → ambiguous, no write", () => {
    const x = r("Mluvili jsme o části Hana");
    expect(x.resolution_kind).toBe("ambiguous_needs_clarification");
    expect(x.should_create_part_card_update).toBe(false);
    expect(x.should_create_part_observation).toBe(false);
  });

  it("Haničko, mluv se mnou jinak → hana_self + strategy target", () => {
    const x = r("Haničko, mluv se mnou pomaleji");
    expect(x.resolution_kind).toBe("hana_self");
    expect(x.recommended_memory_targets.some((t) => t.includes("STRATEGIE_KOMUNIKACE"))).toBe(true);
  });

  it("hana_mentions_multiple_parts: Arthur a Gustík se střídali", () => {
    const x = r("Arthur a Gustík se dnes střídali");
    expect(x.resolution_kind).toBe("hana_mentions_multiple_parts");
    const names = x.mentioned_parts.map((p) => p.canonical_part_name).sort();
    expect(names).toEqual(["Arthur", "Gustík"]);
  });

  it("ambiguous: Nevím, jestli to říkám já nebo někdo z kluků", () => {
    const x = r("Nevím, jestli to říkám já nebo někdo z kluků");
    expect(x.resolution_kind).toBe("ambiguous_needs_clarification");
    expect(x.should_create_part_card_update).toBe(false);
    expect(x.should_create_part_observation).toBe(false);
  });

  it("short token false match prevented (Han / hra)", () => {
    expect(isLikelySamePartName("gustik", "han")).toBe(false);
    expect(isLikelySamePartName("gustik", "hra")).toBe(false);
    const x = r("Han hra dnes");
    expect(x.mentioned_parts).toEqual([]);
  });

  it("Hana aliases excluded before part matching even via registry", () => {
    const x = resolveHanaPersonalIdentity({
      text: "Hanička dnes",
      knownParts: [
        ...knownParts,
        // Bad registry row — must be filtered out
        { canonical_part_name: "hanička" },
      ],
      surface: "hana_personal",
    });
    expect(x.resolution_kind).toBe("hana_self");
    expect(x.mentioned_parts).toEqual([]);
    expect(x.warnings.some((w) => w.startsWith("registry_part_is_hana_alias_ignored"))).toBe(true);
  });

  it("non_hana_surface short-circuits", () => {
    const x = resolveHanaPersonalIdentity({ text: "x", knownParts, surface: "did" as any });
    expect(x.resolution_kind).toBe("non_hana_surface");
    expect(x.should_create_hana_memory).toBe(false);
  });

  it("renderIdentityContextBlock includes Karel-facing rules", () => {
    const block = renderIdentityContextBlock(r("Já dnes potřebuji klid"));
    expect(block).toMatch(/IDENTITY CONTEXT/);
    expect(block).toMatch(/lidská terapeutka/);
    expect(block).toMatch(/NE DID část/);
  });
});
