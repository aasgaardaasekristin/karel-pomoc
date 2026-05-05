import { describe, it, expect } from "vitest";
import {
  CANONICAL_DRIVE_REGISTRY,
  TARGET_REROUTE_MAP,
  canonicalizeTarget,
  isGovernedTarget,
} from "../../supabase/functions/_shared/documentGovernance.ts";

/**
 * P29A — Drive governance hard gate.
 * Fail-closed routing tests: every invalid legacy target must be rejected
 * or rerouted onto a target inside CANONICAL_DRIVE_REGISTRY.
 */
describe("P29A drive governance hard gate", () => {
  it("1. 05E_TEAM_DECISIONS_LOG is not in canonical registry", () => {
    expect(CANONICAL_DRIVE_REGISTRY.has("KARTOTEKA_DID/00_CENTRUM/05E_TEAM_DECISIONS_LOG")).toBe(false);
    expect(isGovernedTarget("KARTOTEKA_DID/00_CENTRUM/05E_TEAM_DECISIONS_LOG")).toBe(false);
    const r = canonicalizeTarget("KARTOTEKA_DID/00_CENTRUM/05E_TEAM_DECISIONS_LOG");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target).toBe("KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN");
      expect(r.rerouted).toBe(true);
    }
  });

  it("2. Bezpecne_DID_poznamky_z_osobniho_vlakna is not in canonical registry", () => {
    expect(CANONICAL_DRIVE_REGISTRY.has("KARTOTEKA_DID/00_CENTRUM/Bezpecne_DID_poznamky_z_osobniho_vlakna")).toBe(false);
    expect(isGovernedTarget("KARTOTEKA_DID/00_CENTRUM/Bezpecne_DID_poznamky_z_osobniho_vlakna")).toBe(false);
    const r = canonicalizeTarget("KARTOTEKA_DID/00_CENTRUM/Bezpecne_DID_poznamky_z_osobniho_vlakna");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target).toBe("PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA");
      expect(r.rerouted).toBe(true);
    }
  });

  it("3. KARTA_TUNDRUPEK canonicalizes under 01_AKTIVNI_FRAGMENTY", () => {
    const r = canonicalizeTarget("KARTA_TUNDRUPEK");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toBe("KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_TUNDRUPEK");
  });

  it("3b. KARTA_ARTHUR (ARTUR, ARTÍK) — parenthetical aliases are stripped", () => {
    const r = canonicalizeTarget("KARTA_ARTHUR (ARTUR, ARTÍK)");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toBe("KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_ARTHUR");
  });

  it("4. invalid target outside governance is rejected (not silently retried)", () => {
    const r = canonicalizeTarget("SOMETHING/RANDOM/UNKNOWN_DOC");
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toMatch(/not in canonical registry/i);
  });

  it("4b. archive folder targets are rejected", () => {
    const r = canonicalizeTarget("KARTOTEKA_DID/03_ARCHIV_SPICICH/KARTA_TUNDRUPEK");
    expect(r.ok).toBe(false);
  });

  it("5. Hana emotional state routes to PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA", () => {
    expect(TARGET_REROUTE_MAP["KARTOTEKA_DID/00_CENTRUM/Bezpecne_DID_poznamky_z_osobniho_vlakna"])
      .toBe("PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA");
    expect(isGovernedTarget("PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA")).toBe(true);
  });

  it("6. Hana communication strategy is a canonical target", () => {
    expect(isGovernedTarget("PAMET_KAREL/DID/HANKA/STRATEGIE_KOMUNIKACE")).toBe(true);
  });

  it("7. part implication routes to canonical KARTA_<NAME>", () => {
    const r = canonicalizeTarget("KARTA_GUSTIK");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toBe("KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_GUSTIK");
  });

  it("8. team_decision_log / operational implication routes to 05A", () => {
    expect(TARGET_REROUTE_MAP["KARTOTEKA_DID/00_CENTRUM/05E_TEAM_DECISIONS_LOG"])
      .toBe("KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN");
    expect(isGovernedTarget("KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN")).toBe(true);
  });

  it("9. no write target outside governance registry is accepted", () => {
    for (const t of CANONICAL_DRIVE_REGISTRY) {
      expect(isGovernedTarget(t)).toBe(true);
    }
    expect(isGovernedTarget("RANDOM_TARGET")).toBe(false);
    expect(isGovernedTarget("PAMET_KAREL/UNKNOWN/PATH")).toBe(false);
    expect(isGovernedTarget("KARTOTEKA_DID/00_CENTRUM/UNKNOWN")).toBe(false);
  });
});
