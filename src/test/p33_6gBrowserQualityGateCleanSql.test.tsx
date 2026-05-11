/**
 * P33.6G — Browser quality gate must NOT block clean SQL briefings.
 *
 * Locks the regression: capitalized "Arthur" / "Tundrupek" are valid Czech
 * names and must pass the audit. Only lowercase leakage is dirty.
 */
import { describe, it, expect } from "vitest";
import {
  auditVisibleKarelText,
  auditVisibleKarelSections,
} from "@/lib/karelVisibleTextQuality";

describe("P33.6G — visible text gate accepts clean SQL briefing", () => {
  it("accepts capitalized Arthur in risks_sensitivities", () => {
    const text =
      "U těchto kluků je dnes čerstvě zachycený vnější okruh: Arthur. Není to predikce.";
    const r = auditVisibleKarelText(text);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("accepts capitalized Tundrupek", () => {
    const r = auditVisibleKarelText(
      "Dříve evidovaný citlivý okruh: Tundrupek. Smyslem je jen ověřit.",
    );
    expect(r.ok).toBe(true);
  });

  it("still rejects lowercase 'arthur'/'tundrupek' leakage", () => {
    expect(auditVisibleKarelText("dnes pracujeme s arthur").ok).toBe(false);
    expect(auditVisibleKarelText("part: tundrupek").ok).toBe(false);
  });

  it("aggregate over the real clean SQL briefing 9aba424c… is OK", () => {
    const sections = [
      { section_id: "system_morning_state", karel_text: "Ranní podklady jsou připravené a vázané na dnešní dokončený ranní cyklus. Můžeme z nich dnes vycházet." },
      { section_id: "daily_cycle_verified", karel_text: "Dnešní ranní příprava doběhla. Povinné kroky jsou uzavřené; část z nich byla dokončená a část bezpečně přeskočená, protože pro ni dnes nebyla práce." },
      { section_id: "today_parts", karel_text: "Dnes nemám dost opory vybrat konkrétní část před prvním kontaktem. Vybereme až podle toho, co kluci sami přinesou." },
      { section_id: "therapist_asks", karel_text: "Haničko, hlavní věc na dnes je prosím ověř, zda dnešní Herna má navázat na praktickou poznámku, nebo má zůstat jen stabilizační.\n\nKáťo, hlavní věc na dnes je prosím zkontroluj rizika a stop signály pro dnešní Hernu podle posledního doloženého záznamu." },
      { section_id: "session_plan", karel_text: "Pro dnešek nemám připravený konkrétní plán Sezení ani Herny. Doporučuji rozhodnout podle prvního kontaktu s kluky." },
      { section_id: "external_reality", karel_text: "Externí situační přehled jsem dnes ověřoval a přinesl čerstvě zdrojované okruhy. Pracuji s nimi jen jako s jemným hlídáním rámce, ne jako s diagnózou ani predikcí." },
      { section_id: "risks_sensitivities", karel_text: "U těchto kluků je dnes čerstvě zachycený vnější okruh: Arthur. Není to predikce, je to upozornění držet bezpečný rámec.\n\nU těchto kluků existuje dříve evidovaný citlivý okruh bez čerstvého zdrojovaného podkladu pro dnešek: Tundrupek. Smyslem je jen ověřit, zda se s tématem dnes setkali." },
      { section_id: "unknowns", karel_text: "Pro dnešek bych si nevyhrazoval žádné velké neznámé nad rámec běžné opatrnosti." },
      { section_id: "next_step", karel_text: "Konkrétní další krok pro dnešek si netroufám stanovit bez toho, abychom nejdřív viděli první kontakt s kluky." },
    ];
    const r = auditVisibleKarelSections(sections);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("still blocks dirty 002_ prefix in any section", () => {
    const r = auditVisibleKarelSections([
      { section_id: "today_parts", karel_text: "návrh na dnešní část je 002_Anička" },
    ]);
    expect(r.ok).toBe(false);
  });
});
