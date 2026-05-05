import { describe, it, expect } from "vitest";
import {
  CANONICAL_DRIVE_REGISTRY,
  TARGET_REROUTE_MAP,
  canonicalizeTarget,
  isGovernedTarget,
  routeBezpecnePoznamky,
  resolveCardPhysicalTitle,
  CARD_PHYSICAL_MAP,
  safeEnqueueDriveWrite,
  gateDriveWriteInsert,
  isAmbiguousPhysicalCardTarget,
  hasPhysicalCardMapping,
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

  it("2. Bezpecne_DID_poznamky_z_osobniho_vlakna reroutes to SITUACNI_ANALYZA.txt", () => {
    expect(isGovernedTarget("KARTOTEKA_DID/00_CENTRUM/Bezpecne_DID_poznamky_z_osobniho_vlakna")).toBe(false);
    const r = canonicalizeTarget("KARTOTEKA_DID/00_CENTRUM/Bezpecne_DID_poznamky_z_osobniho_vlakna");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target).toBe("PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA.txt");
      expect(r.rerouted).toBe(true);
    }
  });

  it("5. Hana emotional state default reroute → SITUACNI_ANALYZA.txt", () => {
    expect(TARGET_REROUTE_MAP["KARTOTEKA_DID/00_CENTRUM/Bezpecne_DID_poznamky_z_osobniho_vlakna"])
      .toBe("PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA.txt");
    expect(isGovernedTarget("PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA.txt")).toBe(true);
  });

  it("6. Hana communication strategy is a canonical target (.txt)", () => {
    expect(isGovernedTarget("PAMET_KAREL/DID/HANKA/STRATEGIE_KOMUNIKACE.txt")).toBe(true);
  });

  it("9. no write target outside governance registry is accepted", () => {
    for (const t of CANONICAL_DRIVE_REGISTRY) {
      expect(isGovernedTarget(t)).toBe(true);
    }
    expect(isGovernedTarget("RANDOM_TARGET")).toBe(false);
    expect(isGovernedTarget("PAMET_KAREL/UNKNOWN/PATH")).toBe(false);
    expect(isGovernedTarget("KARTOTEKA_DID/00_CENTRUM/UNKNOWN")).toBe(false);
  });

  it("10. registry does NOT contain 05C_SEZENI_LOG / 05D_HERNY_LOG / SUPERVIZNI_POZNATKY", () => {
    expect(CANONICAL_DRIVE_REGISTRY.has("KARTOTEKA_DID/00_CENTRUM/05C_SEZENI_LOG")).toBe(false);
    expect(CANONICAL_DRIVE_REGISTRY.has("KARTOTEKA_DID/00_CENTRUM/05D_HERNY_LOG")).toBe(false);
    expect(CANONICAL_DRIVE_REGISTRY.has("PAMET_KAREL/DID/KONTEXTY/SUPERVIZNI_POZNATKY")).toBe(false);
  });

  it("11. SUPERVIZNI_POZNATKY is blocked, NOT rerouted to KDO_JE_KDO", () => {
    expect(TARGET_REROUTE_MAP["PAMET_KAREL/DID/KONTEXTY/SUPERVIZNI_POZNATKY"]).toBeUndefined();
    const r = canonicalizeTarget("PAMET_KAREL/DID/KONTEXTY/SUPERVIZNI_POZNATKY");
    expect(r.ok).toBe(false);
  });

  it("12. HANKA/KATA memory docs require .txt suffix in registry", () => {
    expect(isGovernedTarget("PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA.txt")).toBe(true);
    expect(isGovernedTarget("PAMET_KAREL/DID/KATA/PROFIL_OSOBNOSTI.txt")).toBe(true);
    // KAREL stays bare
    expect(isGovernedTarget("PAMET_KAREL/DID/HANKA/KAREL")).toBe(true);
    expect(isGovernedTarget("PAMET_KAREL/DID/KATA/KAREL")).toBe(true);
  });

  it("13. CARD_PHYSICAL_MAP resolves logical KARTA_* to physical Drive titles", () => {
    expect(resolveCardPhysicalTitle("KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_TUNDRUPEK")).toBe("003_TUNDRUPEK");
    expect(resolveCardPhysicalTitle("KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_ARTHUR")).toBe("004_ARTHUR");
    expect(resolveCardPhysicalTitle("KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_GUSTIK")).toBe("002_GUSTIK");
    expect(resolveCardPhysicalTitle("KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_ANICKA")).toBe("001_ANICKA");
    expect(resolveCardPhysicalTitle("KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_UNKNOWN")).toBeNull();
    expect(Object.keys(CARD_PHYSICAL_MAP).length).toBeGreaterThanOrEqual(6);
  });

  it("14. safeEnqueueDriveWrite preserves all original row fields (dedupe_key, source_ref, metadata, rerouted_from_write_id)", async () => {
    let captured: any = null;
    const fakeSb: any = {
      from: (_t: string) => ({
        insert: (row: any) => {
          captured = row;
          return Promise.resolve({ data: null, error: null });
        },
      }),
    };
    const original = {
      target_document: "KARTOTEKA_DID/00_CENTRUM/05E_TEAM_DECISIONS_LOG",
      content: "x",
      write_type: "append",
      priority: "high",
      status: "pending",
      user_id: "u1",
      dedupe_key: "dk-1",
      semantic_dedupe_key: "sdk-1",
      source_ref: "sr-1",
      source_type: "test",
      content_type: "team_decision_log",
      retry_count: 0,
      rerouted_from_write_id: "prior-1",
      metadata: { foo: "bar" },
    };
    const r = await safeEnqueueDriveWrite(fakeSb, original, { source: "test" });
    expect(r.inserted).toBe(true);
    expect(captured.target_document).toBe("KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN");
    expect(captured.dedupe_key).toBe("dk-1");
    expect(captured.semantic_dedupe_key).toBe("sdk-1");
    expect(captured.source_ref).toBe("sr-1");
    expect(captured.source_type).toBe("test");
    expect(captured.content_type).toBe("team_decision_log");
    expect(captured.rerouted_from_write_id).toBe("prior-1");
    expect(captured.metadata).toEqual({ foo: "bar" });
    expect(captured.user_id).toBe("u1");
  });

  it("15. Bezpecne content-aware routing branches", () => {
    expect(routeBezpecnePoznamky("Naše dohody a hranice mezi námi").reason).toBe("KAREL_RELATIONAL");
    expect(routeBezpecnePoznamky("strategie komunikace s ní").reason).toBe("STRATEGIE_KOMUNIKACE");
    expect(routeBezpecnePoznamky("dlouhodobá osobnost a charakter").reason).toBe("PROFIL_OSOBNOSTI");
    expect(routeBezpecnePoznamky("za poslední 3 dny trend").reason).toBe("VLAKNA_3DNY");
    expect(routeBezpecnePoznamky("poslední vlákno z dneška").reason).toBe("VLAKNA_POSLEDNI");
    expect(routeBezpecnePoznamky("operativní plán na den, akce na den").reason).toBe("OPERATIVNI_PLAN");
    expect(routeBezpecnePoznamky("smutek a tíha", { partName: "TUNDRUPEK" }).reason).toBe("KARTA_PART");
    expect(routeBezpecnePoznamky("nějaký emoční stav vina vyhoření").reason).toBe("SITUACNI_ANALYZA");
  });

  it("16. gateDriveWriteInsert blocks invalid targets fail-closed", () => {
    const r = gateDriveWriteInsert({ target_document: "PAMET_KAREL/DID/KONTEXTY/SUPERVIZNI_POZNATKY" });
    expect(r.ok).toBe(false);
  });

  it("17. KARTA_GERHARDT is ambiguous and has NO physical card mapping (P29A subpass)", () => {
    const tgt = "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_GERHARDT";
    // Drive proof: only 022_GERHARDT exists, in 03_ARCHIV_SPICICH (not active fragments).
    // Registry has both active `001_gerhardt` (no physical file) and sleeping `GERHARDT`.
    // Therefore mapping must NOT be auto-added; processor must mark it manual_approval.
    expect(hasPhysicalCardMapping(tgt)).toBe(false);
    expect(resolveCardPhysicalTitle(tgt)).toBeNull();
    expect(isAmbiguousPhysicalCardTarget(tgt)).toBe(true);
    expect(CARD_PHYSICAL_MAP[tgt]).toBeUndefined();
  });
});
