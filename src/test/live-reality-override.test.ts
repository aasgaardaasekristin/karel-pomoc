import { describe, expect, it } from "vitest";
import { detectsLiveRealityOverride, hasRealityOverrideBannedPhrase } from "@/lib/liveRealityOverrideGuards";

describe("live reality override guard", () => {
  it("detects Timmy factual correction with URL", () => {
    const input = "Karle, Timmy je skutečné zvíře, posílala jsem ti odkaz. Dnes se reálně rozhoduje, jestli záchranáři velrybu zachrání. Nejde o fiktivní postavu. URL: https://example.com/timmy";
    expect(detectsLiveRealityOverride(input)).toBe(true);
  });

  it("blocks forbidden pseudo-diagnostic phrases", () => {
    expect(hasRealityOverrideBannedPhrase("Vůbec to nemění plán, je to diagnostický signál. Nakresli člověka.")).toBe(true);
  });

  it("accepts safe real-event micro-plan language", () => {
    const safe = "Hani, máš pravdu. Původní bod zastavuju. Zůstaň u reality, emocí, potřeby a bezpečí; zapiš jeho vlastní slova.";
    expect(hasRealityOverrideBannedPhrase(safe)).toBe(false);
  });
});