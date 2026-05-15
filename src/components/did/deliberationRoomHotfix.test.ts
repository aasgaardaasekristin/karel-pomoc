/**
 * BLOK 1 hotfix + HOTFIX 1.5 — sanitizer fixture tests pro stripRawReportArtifacts.
 * Vstupy s ### markdown headers, raw report labels, **bold**, *italic* a
 * standalone labely (Stav:, Praktický report:, …) musí být očištěné na
 * čistou prózu BEZ těchto artefaktů. Markdown bullety (`* položka`) MUSÍ
 * zůstat zachované.
 */
import { describe, it, expect } from "vitest";
import { stripRawReportArtifacts } from "./DeliberationRoom";

describe("BLOK 1 hotfix — stripRawReportArtifacts", () => {
  it("strips raw markdown headers (### Heading) inline and at line start", () => {
    const input = "Karel řekl: ### Praktický report z Herny: tundrupek Stav: otevřeno";
    const out = stripRawReportArtifacts(input);
    expect(out).not.toMatch(/###/);
    expect(out).not.toMatch(/Praktick[ýy]\s+report\s+z\s+Herny/i);
  });

  it("strips line-anchored markdown headers", () => {
    const input = "Úvod\n### Praktický report z Herny: foo\nDalší řádek";
    const out = stripRawReportArtifacts(input);
    expect(out).not.toMatch(/###/);
    expect(out).not.toMatch(/Praktick[ýy]\s+report/i);
  });

  it("preserves legitimate prose without artifacts", () => {
    const input = "Bezpečný kontakt a otevřená pozornost.";
    expect(stripRawReportArtifacts(input)).toBe(input);
  });

  it("strips Detailní analýza and Playroom log labels", () => {
    expect(stripRawReportArtifacts("Detailní analýza z Herny: tundrupek a dál.")).not.toMatch(/Detailn[íi]\s+anal/i);
    expect(stripRawReportArtifacts("Playroom log: tundrupek 2026-05-15")).not.toMatch(/Playroom\s+log/i);
  });
});

describe("HOTFIX 1.5 — markdown bold/italic + standalone labels", () => {
  it("strips **bold** label at sentence start: **Stav:** Herna byla automaticky ukončena", () => {
    const out = stripRawReportArtifacts("**Stav:** Herna byla automaticky ukončena");
    expect(out).toBe("Herna byla automaticky ukončena");
    expect(out).not.toMatch(/\*\*/);
    expect(out).not.toMatch(/\bStav\s*:/);
  });

  it("strips **bold** label mid-sentence: odkryla, že **Stav:** Herna byla automaticky", () => {
    const out = stripRawReportArtifacts("odkryla, že **Stav:** Herna byla automaticky");
    expect(out).toBe("odkryla, že Herna byla automaticky");
    expect(out).not.toMatch(/\*/);
    expect(out).not.toMatch(/\bStav\s*:/);
  });

  it("strips standalone Stav: label without bold: Stav: Herna byla automaticky ukončena", () => {
    const out = stripRawReportArtifacts("Stav: Herna byla automaticky ukončena");
    expect(out).toBe("Herna byla automaticky ukončena");
  });

  it("does NOT eat markdown bullets (`* položka` at start of line)", () => {
    const input = "* položka jedna\n* položka dvě";
    const out = stripRawReportArtifacts(input);
    expect(out).toMatch(/\* položka jedna/);
    expect(out).toMatch(/\* položka dvě/);
  });

  it("strips inline *italic* without touching bullets", () => {
    const out = stripRawReportArtifacts("Toto je *kurzíva* uvnitř věty.");
    expect(out).toBe("Toto je kurzíva uvnitř věty.");
  });

  it("strips Doložený zdroj: a Závěr: labels", () => {
    expect(stripRawReportArtifacts("Doložený zdroj: pozorování z 12.5.")).toBe("pozorování z 12.5.");
    expect(stripRawReportArtifacts("Závěr: vše proběhlo bezpečně.")).toBe("vše proběhlo bezpečně.");
  });
});
