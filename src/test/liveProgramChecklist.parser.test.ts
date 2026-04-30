import { describe, it, expect } from "vitest";
import { parseProgramBullets } from "@/lib/liveProgramParser";

describe("parseProgramBullets", () => {
  it("A. parses canonical markdown with ## Program sezení", () => {
    const md = `# Schválený plán z týmové porady

## Program sezení

1. **Bezpečný vstup** (8 min)
   Detail A

2. **Tělesné mapování** (10 min)
   Detail B
`;
    const bullets = parseProgramBullets(md);
    expect(bullets.length).toBe(2);
    expect(bullets[0]).toContain("Bezpečný vstup");
    expect(bullets[0]).toContain("Detail A");
    expect(bullets[1]).toContain("Tělesné mapování");
    expect(bullets[1]).toContain("Detail B");
  });

  it("B. JSON array fallback", () => {
    const md = `# Schválený plán z týmové porady

[{"block":"Bezpečný vstup","minutes":8,"detail":"Detail A"},{"block":"Tělesné mapování","minutes":10,"clinical_intent":"Detail B"}]`;
    const bullets = parseProgramBullets(md);
    expect(bullets.length).toBe(2);
    expect(bullets[0]).toContain("Bezpečný vstup");
    expect(bullets[0]).toContain("Detail A");
    expect(bullets[1]).toContain("Tělesné mapování");
    expect(bullets[1]).toContain("Detail B");
  });

  it("C. Old heading-per-block format", () => {
    const md = `### 1. **Bezpečný vstup**
Detail A
`;
    const bullets = parseProgramBullets(md);
    expect(bullets.length).toBe(1);
    expect(bullets[0]).toContain("Bezpečný vstup");
  });

  it("D. Empty/invalid plan returns 0 bullets", () => {
    const md = `# Schválený plán z týmové porady
[]`;
    const bullets = parseProgramBullets(md);
    expect(bullets.length).toBe(0);
  });

  it("D2. Garbage input returns 0 bullets", () => {
    expect(parseProgramBullets("")).toEqual([]);
    expect(parseProgramBullets("nic tu není")).toEqual([]);
  });

  it("E. Active production-like plan with 4 blocks", () => {
    const md = `# Schválený plán z týmové porady

## Program sezení

1. **Bezpečný vstup** (8 min)
   Otevření kontaktu, dech.

2. **Tělesné mapování** (10 min)
   Body scan po linii ramen.

3. **Opatrné otevření** (20 min)
   Práce s tématem z minulého týdne.

4. **Integrace** (10 min)
   Uzemnění, závěr.
`;
    const bullets = parseProgramBullets(md);
    expect(bullets.length).toBe(4);
    expect(bullets[0]).toMatch(/Bezpečný vstup/);
    expect(bullets[1]).toMatch(/Tělesné mapování/);
    expect(bullets[2]).toMatch(/Opatrné otevření/);
    expect(bullets[3]).toMatch(/Integrace/);
  });
});
