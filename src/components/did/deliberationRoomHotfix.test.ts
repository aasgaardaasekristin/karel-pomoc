/**
 * BLOK 1 hotfix — sanitizer fixture test pro stripRawReportArtifacts.
 * Vstup s ### markdown headers + raw report labels (Praktický report z Herny:,
 * Stav:) musí být očištěný na čistou prózu bez těchto artefaktů.
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
