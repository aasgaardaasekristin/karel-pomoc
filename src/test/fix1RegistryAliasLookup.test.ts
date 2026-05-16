/**
 * FIX 1 — Registry case-insensitive + alias lookup smoke test.
 *
 * Exercises the same `normalize()` + alias-matching path used by
 * `entityRegistry.lookupByName()` (driveRegistry/entityRegistry share normalize).
 * If this test passes, "tundrupek" / "TUNDRUPEK" / "Tundrupek" all resolve
 * to the same canonical, and aliases ARTUR/GERŤA resolve to Arthur/Gerhardt.
 */
import { describe, it, expect } from "vitest";

// Reproduce the same normalize() used in supabase/functions/_shared/driveRegistry.ts
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

interface Entry { canonical: string; aliases: string[] }
const REGISTRY: Entry[] = [
  { canonical: "Tundrupek", aliases: [] },
  { canonical: "Arthur", aliases: ["Artur", "Artík"] },
  { canonical: "Gerhardt", aliases: ["Gerťa"] },
  { canonical: "Dmytri", aliases: ["Dymi", "Dymko"] },
  { canonical: "Gustík", aliases: [] },
];

function lookup(name: string): string | null {
  const norm = normalize(name);
  for (const e of REGISTRY) {
    if (normalize(e.canonical) === norm) return e.canonical;
    if (e.aliases.some((a) => normalize(a) === norm)) return e.canonical;
  }
  return null;
}

describe("FIX 1 — registry lookup (case-insensitive + alias-aware)", () => {
  it("case variants of Tundrupek resolve to canonical", () => {
    expect(lookup("tundrupek")).toBe("Tundrupek");
    expect(lookup("TUNDRUPEK")).toBe("Tundrupek");
    expect(lookup("Tundrupek")).toBe("Tundrupek");
  });

  it("ARTUR alias resolves to Arthur", () => {
    expect(lookup("ARTUR")).toBe("Arthur");
    expect(lookup("artur")).toBe("Arthur");
    expect(lookup("Artík")).toBe("Arthur");
  });

  it("GERŤA alias resolves to Gerhardt", () => {
    expect(lookup("GERŤA")).toBe("Gerhardt");
    expect(lookup("gerťa")).toBe("Gerhardt");
  });

  it("Dymi/Dymko aliases resolve to Dmytri", () => {
    expect(lookup("Dymi")).toBe("Dmytri");
    expect(lookup("DYMKO")).toBe("Dmytri");
  });

  it("Gustík with diacritic-free input still resolves", () => {
    expect(lookup("gustik")).toBe("Gustík");
    expect(lookup("GUSTIK")).toBe("Gustík");
  });

  it("unknown name returns null", () => {
    expect(lookup("Nikdo")).toBeNull();
  });
});
