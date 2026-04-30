import { describe, it, expect } from "vitest";
import { sanitizeRecencyText, hasForbiddenRecencyPattern } from "@/lib/recencySanitizer";

describe("sanitizeRecencyText — workspace planning artifacts", () => {
  const hint = {
    last_playroom_date_iso: "2026-04-27",
    last_playroom_recency_label: "před 3 dny",
    playroom_days_since_today: 3,
  };

  it("rewrites 'POUŽITÝ VČEREJŠÍ KONTEXT' heading", () => {
    const out = sanitizeRecencyText("POUŽITÝ VČEREJŠÍ KONTEXT", hint);
    expect(out).toBe("POUŽITÝ KONTEXT Z POSLEDNÍCH DNÍ");
    expect(hasForbiddenRecencyPattern(out)).toBe(false);
  });

  it("rewrites 'navázat na včerejší Hernu' to absolute-date form", () => {
    const out = sanitizeRecencyText("Plán: navázat na včerejší Hernu klidně.", hint);
    expect(out).toContain("27. 4. 2026");
    expect(out).toContain("poslední doložené Herny");
    expect(out).not.toMatch(/navázat na včerejší Hernu/i);
  });

  it("rewrites 'Symboly z včerejška' to absolute-date form", () => {
    const out = sanitizeRecencyText("Symboly z včerejška používat opatrně.", hint);
    expect(out).toContain("Symboly z poslední doložené Herny");
    expect(out).toContain("27. 4. 2026");
    expect(out).not.toMatch(/Symboly z včerejška/i);
  });

  it("rewrites 'včerejší Hernu' standalone", () => {
    const out = sanitizeRecencyText("Pokračujeme na včerejší Hernu.", hint);
    expect(out).not.toMatch(/včerejší Hernu/i);
    expect(out).toContain("27. 4. 2026");
  });

  it("rewrites 'včerejší kontext' phrase always (even without hint)", () => {
    const out = sanitizeRecencyText("Používá včerejší kontext bezpečně.", {});
    expect(out).toContain("kontext z posledních dní");
    expect(out).not.toMatch(/včerejší kontext/i);
  });

  it("does NOT touch text when source IS actually yesterday (days=1)", () => {
    const out = sanitizeRecencyText("navázat na včerejší Hernu", {
      playroom_days_since_today: 1,
      last_playroom_date_iso: "2026-04-29",
    });
    // Phrase is technically true, sanitizer leaves play-specific phrases alone.
    expect(out).toMatch(/navázat na včerejší Hernu/i);
  });

  it("works without hint — uses date-free safe label", () => {
    const out = sanitizeRecencyText("navázat na včerejší Hernu", {});
    expect(out).toContain("poslední doložené Herny");
    expect(out).not.toMatch(/navázat na včerejší Hernu/i);
  });

  it("rewrites halucinated session reference to neutral form", () => {
    const out = sanitizeRecencyText("Jak se cítíš po našem včerejším sezení s Hankou?", {});
    expect(out).toContain("po našem poslední doložené Sezení");
    expect(out).not.toMatch(/po našem včerejším sezení/i);
  });

  it("hasForbiddenRecencyPattern detects all forbidden patterns", () => {
    expect(hasForbiddenRecencyPattern("POUŽITÝ VČEREJŠÍ KONTEXT")).toBe(true);
    expect(hasForbiddenRecencyPattern("navázat na včerejší Hernu")).toBe(true);
    expect(hasForbiddenRecencyPattern("Symboly z včerejška")).toBe(true);
    expect(hasForbiddenRecencyPattern("včerejší kontext")).toBe(true);
    expect(hasForbiddenRecencyPattern("Včerejší Herna byla bezpečná")).toBe(true);
    expect(hasForbiddenRecencyPattern("Vše v pořádku, bez problémů.")).toBe(false);
    expect(hasForbiddenRecencyPattern("Poslední doložená Herna z 27. 4. 2026.")).toBe(false);
  });
});
