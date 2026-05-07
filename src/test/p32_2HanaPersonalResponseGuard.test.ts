/**
 * P32.2 — Hana personal response guard unit tests.
 */
import { describe, it, expect } from "vitest";
import {
  validateHanaPersonalResponseIdentity,
  renderSafeHanaPersonalFallback,
} from "../../supabase/functions/_shared/hanaPersonalResponseGuard.ts";
import { resolveHanaPersonalIdentity } from "../../supabase/functions/_shared/hanaPersonalIdentityResolver.ts";

const knownParts = [
  { canonical_part_name: "Gustík", aliases: ["Gusti"] },
  { canonical_part_name: "Tundrupek" },
  { canonical_part_name: "Arthur", aliases: ["Artík"] },
];

const r = (text: string) =>
  resolveHanaPersonalIdentity({ text, knownParts, surface: "hana_personal" });

describe("P32.2 hanaPersonalResponseGuard", () => {
  it("blocks 'část Hanička' on hana_self", () => {
    const res = validateHanaPersonalResponseIdentity({
      responseText: "Část Hanička teď potřebuje bezpečí.",
      identityResolution: r("Já už nemůžu, Karle"),
    });
    expect(res.blocked).toBe(true);
    expect(res.safe_fallback_text).toBeTruthy();
  });

  it("allows 'Haničko, slyším tě...' on hana_self", () => {
    const res = validateHanaPersonalResponseIdentity({
      responseText: "Haničko, slyším tě a jsem tu s tebou.",
      identityResolution: r("Já už nemůžu"),
    });
    expect(res.blocked).toBe(false);
    expect(res.ok).toBe(true);
  });

  it("blocks 'Hana frontuje'", () => {
    const res = validateHanaPersonalResponseIdentity({
      responseText: "Hana frontuje a kluci se stahují.",
      identityResolution: r("Já dnes nevím"),
    });
    expect(res.blocked).toBe(true);
  });

  it("blocks 'Hana jako část'", () => {
    const res = validateHanaPersonalResponseIdentity({
      responseText: "Hana jako část teď potřebuje klid.",
      identityResolution: r("Mám pocit, že jsem špatná"),
    });
    expect(res.blocked).toBe(true);
  });

  it("blocks 'Gustíku, slyším tě' when Hana mentions Gustík", () => {
    const res = validateHanaPersonalResponseIdentity({
      responseText: "Gustíku, slyším tě.",
      identityResolution: r("Mluvila jsem dnes s Gustíkem"),
    });
    expect(res.blocked).toBe(true);
    expect(res.reason).toMatch(/part_addressed_directly/);
  });

  it("allows 'Haničko, slyším, že mluvíš o Gustíkovi'", () => {
    const res = validateHanaPersonalResponseIdentity({
      responseText: "Haničko, slyším, že mluvíš o Gustíkovi. Jak ti při tom bylo?",
      identityResolution: r("Mluvila jsem dnes s Gustíkem"),
    });
    expect(res.blocked).toBe(false);
  });

  it("blocks group response that picks specific part", () => {
    const res = validateHanaPersonalResponseIdentity({
      responseText: "U kluků to bude hlavně Gustík, kdo to teď nese.",
      identityResolution: r("Kluci dnes byli stažení"),
    });
    expect(res.blocked).toBe(true);
    expect(res.reason).toMatch(/group_response_picked_specific_part/);
  });

  it("blocks ambiguous + claim 'to je Gustík'", () => {
    const res = validateHanaPersonalResponseIdentity({
      responseText: "To je Gustík, určitě.",
      identityResolution: r("Nevím, jestli to říkám já nebo někdo z kluků"),
    });
    expect(res.blocked).toBe(true);
  });

  it("allows ambiguous when response asks clarifying question", () => {
    const res = validateHanaPersonalResponseIdentity({
      responseText: "Haničko, myslíš to teď za sebe, nebo máš pocit, že se ozývá někdo z kluků?",
      identityResolution: r("Nevím, jestli to říkám já nebo někdo z kluků"),
    });
    expect(res.blocked).toBe(false);
  });

  it("resolver failure → safe fallback text exists", () => {
    const res = validateHanaPersonalResponseIdentity({
      responseText: "Cokoli.",
      identityResolution: null,
    });
    expect(res.blocked).toBe(true);
    expect(res.safe_fallback_text).toBeTruthy();
    expect(res.safe_fallback_text!.length).toBeGreaterThan(20);
  });

  it("safe fallback never contains 'část Hana'", () => {
    for (const kind of ["hana_self", "hana_mentions_part", "hana_mentions_group_kluci", "ambiguous_needs_clarification"] as const) {
      const fb = renderSafeHanaPersonalFallback({
        surface: "hana_personal",
        speaker_identity: "hana_therapist",
        addressed_identity: "karel",
        resolution_kind: kind as any,
        self_reference_target: "hana_therapist",
        mentioned_parts: kind === "hana_mentions_part" ? [{ canonical_part_name: "Gustík", matched_text: "Gustík", match_type: "exact", confidence: "high" }] : [],
        mentioned_groups: [],
        should_switch_speaker_to_part: false,
        should_create_part_card_update: false,
        should_create_hana_memory: true,
        should_create_part_observation: false,
        recommended_memory_targets: [],
        response_instruction: "",
        confidence: "high",
        warnings: [],
      } as any);
      expect(/část\s+Han/i.test(fb)).toBe(false);
    }
  });

  it("safe fallback for hana_mentions_part does not start with 'Gustíku'", () => {
    const fb = renderSafeHanaPersonalFallback(r("Mluvila jsem s Gustíkem"));
    expect(/^Gust/i.test(fb.trim())).toBe(false);
    expect(/^Hani/i.test(fb.trim())).toBe(true);
  });

  it("guard normalizes diacritics (Hanicka vs Hanička)", () => {
    const a = validateHanaPersonalResponseIdentity({
      responseText: "Cast Hanicka teď potřebuje klid.",
      identityResolution: r("Já dnes"),
    });
    const b = validateHanaPersonalResponseIdentity({
      responseText: "Část Hanička teď potřebuje klid.",
      identityResolution: r("Já dnes"),
    });
    expect(a.blocked).toBe(true);
    expect(b.blocked).toBe(true);
  });

  it("does not block correct vocative 'Haničko'", () => {
    const res = validateHanaPersonalResponseIdentity({
      responseText: "Haničko, jsem tady. Co teď nejvíc potřebuješ?",
      identityResolution: r("Už nemůžu"),
    });
    expect(res.blocked).toBe(false);
  });

  it("guard is pure — no fetch, no AI (does not throw or hang)", () => {
    const start = Date.now();
    for (let i = 0; i < 200; i++) {
      validateHanaPersonalResponseIdentity({
        responseText: "Haničko, slyším tě.",
        identityResolution: r("Něco"),
      });
    }
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("empty response is blocked with safe fallback", () => {
    const res = validateHanaPersonalResponseIdentity({
      responseText: "",
      identityResolution: r("cokoliv"),
    });
    expect(res.blocked).toBe(true);
    expect(res.safe_fallback_text).toBeTruthy();
  });
});
