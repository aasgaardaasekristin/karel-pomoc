/**
 * P32.1 — End-to-end Hana/Karel identity guard tests.
 */
import { describe, it, expect } from "vitest";
import {
  isForbiddenHanaPartName,
  blockHanaAliasPartWrite,
  normalizeCzechIdentityToken,
} from "../../supabase/functions/_shared/hanaPersonalIdentityResolver.ts";

describe("P32.1 forbidden Hana/Karel part identity guard", () => {
  it("isForbiddenHanaPartName detects Hana aliases", () => {
    for (const n of ["Hana", "hanka", "Hanička", "Hani", "Hanicka", "Mamka", "Maminka"]) {
      expect(isForbiddenHanaPartName(n)).toBe(true);
    }
  });

  it("isForbiddenHanaPartName detects Karel aliases", () => {
    for (const n of ["Karel", "karle", "Karla", "KAREL"]) {
      expect(isForbiddenHanaPartName(n)).toBe(true);
    }
  });

  it("does not flag real DID parts", () => {
    for (const n of ["Gustík", "Tundrupek", "Arthur", "Anička", "Gerhardt"]) {
      expect(isForbiddenHanaPartName(n)).toBe(false);
    }
  });

  it("blocks KARTA_HANA target", () => {
    const r = blockHanaAliasPartWrite({ target_kind: "did_pending_drive_writes", target_document: "KARTA_HANA" });
    expect(r.blocked).toBe(true);
  });

  it("blocks full path KARTA_KAREL target", () => {
    const r = blockHanaAliasPartWrite({
      target_kind: "did_pending_drive_writes",
      target_document: "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_KAREL",
    });
    expect(r.blocked).toBe(true);
  });

  it("blocks KARTA_HANIČKA with diacritics", () => {
    const r = blockHanaAliasPartWrite({ target_kind: "did_pending_drive_writes", target_document: "KARTA_HANIČKA" });
    expect(r.blocked).toBe(true);
  });

  it("blocks part_name=Hanka", () => {
    const r = blockHanaAliasPartWrite({ target_kind: "card_update_queue", part_name: "Hanka" });
    expect(r.blocked).toBe(true);
  });

  it("blocks part_id=Karel", () => {
    const r = blockHanaAliasPartWrite({ target_kind: "card_update_queue", part_id: "Karel" });
    expect(r.blocked).toBe(true);
  });

  it("does NOT block part_name=Gustík", () => {
    const r = blockHanaAliasPartWrite({ target_kind: "card_update_queue", part_name: "Gustík" });
    expect(r.blocked).toBe(false);
  });

  it("does NOT block KARTA_GUSTIK target", () => {
    const r = blockHanaAliasPartWrite({
      target_kind: "did_pending_drive_writes",
      target_document: "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_GUSTIK",
    });
    expect(r.blocked).toBe(false);
  });

  it("does NOT block KARTA_TUNDRUPEK target", () => {
    const r = blockHanaAliasPartWrite({
      target_kind: "did_pending_drive_writes",
      target_document: "KARTA_TUNDRUPEK",
    });
    expect(r.blocked).toBe(false);
  });

  it("normalizeCzechIdentityToken strips diacritics and casing", () => {
    expect(normalizeCzechIdentityToken("Hanička")).toBe("hanicka");
    expect(normalizeCzechIdentityToken("KARTA_HANIČKA")).toBe("karta_hanicka");
  });

  it("returns reason and normalized_hits when blocked", () => {
    const r = blockHanaAliasPartWrite({ target_kind: "did_observations", part_name: "Hanka", source: "test" });
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("blocked_by_identity_guard");
    expect(r.normalized_hits.length).toBeGreaterThan(0);
  });

  it("returns blocked=false with empty hits for safe input", () => {
    const r = blockHanaAliasPartWrite({ target_kind: "did_observations", part_name: "Arthur" });
    expect(r.blocked).toBe(false);
    expect(r.normalized_hits).toEqual([]);
  });

  it("handles null/undefined input safely", () => {
    expect(isForbiddenHanaPartName(null)).toBe(false);
    expect(isForbiddenHanaPartName(undefined)).toBe(false);
    expect(isForbiddenHanaPartName("")).toBe(false);
    const r = blockHanaAliasPartWrite({ target_kind: "unknown" });
    expect(r.blocked).toBe(false);
  });
});
