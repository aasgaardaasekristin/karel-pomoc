/**
 * P12 truth-status unit tests.
 */
import { describe, it, expect } from "vitest";
import {
  getBriefingTruthStatus,
  pluralizeDays,
  countForbiddenBriefingTerms,
  countBriefingContradictions,
} from "@/lib/briefingTruthStatus";

const TODAY = "2026-05-03";

describe("P12 getBriefingTruthStatus", () => {
  it("fresh full non-manual today → Aktuální", () => {
    const s = getBriefingTruthStatus(
      {
        briefing_date: TODAY,
        is_stale: false,
        generation_method: "auto",
        generation_duration_ms: 45000,
        payload: { limited: false, daily_cycle_status: "completed" },
      },
      TODAY,
    );
    expect(s.level).toBe("fresh_full");
    expect(s.canShowCurrent).toBe(true);
    expect(s.badgeLabel).toBe("Aktuální");
    expect(s.bannerText).toBe("Tento přehled je pro dnešek aktuální.");
  });

  it("today + limited repair → Náhradní omezený přehled, never Aktuální", () => {
    const s = getBriefingTruthStatus(
      {
        briefing_date: TODAY,
        is_stale: false,
        generation_method: "sla_watchdog_repair",
        generation_duration_ms: 45000,
        payload: { limited: true, limited_reason: "cycle_missing", daily_cycle_status: "missing" },
      },
      TODAY,
    );
    expect(s.level).toBe("fresh_limited");
    expect(s.canShowCurrent).toBe(false);
    expect(s.badgeLabel).toBe("Náhradní omezený přehled");
    expect(s.bannerText).toContain("náhradní a omezený");
    expect(s.badgeLabel).not.toMatch(/Aktuální/);
  });

  it("stale previous row → Poslední dostupný přehled", () => {
    const s = getBriefingTruthStatus(
      {
        briefing_date: "2026-05-02",
        is_stale: false,
        generation_method: "auto",
        generation_duration_ms: 45000,
        payload: { limited: false, daily_cycle_status: "completed" },
      },
      TODAY,
    );
    expect(s.level).toBe("stale_previous");
    expect(s.badgeLabel).toBe("Poslední dostupný přehled");
    expect(s.canShowCurrent).toBe(false);
    expect(s.bannerText).toContain("Dnešní plný přehled zatím nevznikl");
  });

  it("manual today row → Ruční přehled, not Aktuální", () => {
    const s = getBriefingTruthStatus(
      {
        briefing_date: TODAY,
        is_stale: false,
        generation_method: "manual",
        generation_duration_ms: 45000,
        payload: { limited: false, daily_cycle_status: "completed" },
      },
      TODAY,
    );
    expect(s.level).toBe("fresh_limited");
    expect(s.badgeLabel).toBe("Ruční přehled");
    expect(s.canShowCurrent).toBe(false);
  });

  it("today with daily_cycle_status=missing → limited, not Aktuální", () => {
    const s = getBriefingTruthStatus(
      {
        briefing_date: TODAY,
        is_stale: false,
        generation_method: "auto",
        generation_duration_ms: 45000,
        payload: { limited: false, daily_cycle_status: "missing" },
      },
      TODAY,
    );
    expect(s.level).toBe("fresh_limited");
    expect(s.canShowCurrent).toBe(false);
    expect(s.badgeLabel).toBe("Náhradní omezený přehled");
  });

  it("missing row → Dnešní přehled chybí", () => {
    const s = getBriefingTruthStatus(null, TODAY);
    expect(s.level).toBe("missing_today");
    expect(s.canShowCurrent).toBe(false);
    expect(s.bannerText).toContain("Dnešní přehled zatím nevznikl");
  });

  it("visible banner contains no technical terms (full)", () => {
    const s = getBriefingTruthStatus(
      {
        briefing_date: TODAY,
        is_stale: false,
        generation_method: "auto",
        generation_duration_ms: 45000,
        payload: { limited: false, daily_cycle_status: "completed" },
      },
      TODAY,
    );
    expect(countForbiddenBriefingTerms(`${s.badgeLabel} ${s.bannerText ?? ""}`)).toBe(0);
  });

  it("visible banner contains no technical terms (limited)", () => {
    const s = getBriefingTruthStatus(
      {
        briefing_date: TODAY,
        is_stale: false,
        generation_method: "sla_watchdog_repair",
        generation_duration_ms: 45000,
        payload: { limited: true, daily_cycle_status: "missing" },
      },
      TODAY,
    );
    expect(countForbiddenBriefingTerms(`${s.badgeLabel} ${s.bannerText ?? ""}`)).toBe(0);
  });
});

describe("P12 pluralizeDays", () => {
  it("1 → '1 den'", () => expect(pluralizeDays(1)).toBe("1 den"));
  it("2 → '2 dny'", () => expect(pluralizeDays(2)).toBe("2 dny"));
  it("4 → '4 dny'", () => expect(pluralizeDays(4)).toBe("4 dny"));
  it("5 → '5 dní'", () => expect(pluralizeDays(5)).toBe("5 dní"));
  it("11 → '11 dní'", () => expect(pluralizeDays(11)).toBe("11 dní"));
});

describe("P12 contradiction & forbidden detector (DOM regression)", () => {
  it("regression text from screenshot fails: forbidden + contradictions > 0", () => {
    const raw = [
      "Aktuální (SLA záplata)",
      "starý přehled · 1 dny",
      "Dnešní přehled zatím nevznikl",
      "Limitovaný ranní přehled: denní cyklus nedoběhl, proto používám dostupné DB/Pantry/Event-ingestion zdroje.",
    ].join("\n");
    expect(countForbiddenBriefingTerms(raw)).toBeGreaterThan(0);
    expect(countBriefingContradictions(raw)).toBeGreaterThan(0);
  });

  it("clean limited variant: 0 forbidden, 0 contradictions", () => {
    const clean = [
      "Náhradní omezený přehled",
      "Tento přehled je náhradní a omezený. Plný ranní cyklus dnes nedoběhl, proto Karel pracuje jen s bezpečně dostupnými podklady.",
    ].join("\n");
    expect(countForbiddenBriefingTerms(clean)).toBe(0);
    expect(countBriefingContradictions(clean)).toBe(0);
  });

  it("clean stale variant: 0 forbidden, 0 contradictions", () => {
    const clean = [
      "Poslední dostupný přehled",
      "Zobrazuji poslední dostupný přehled ze dne 2. května 2026. Dnešní plný přehled zatím nevznikl.",
    ].join("\n");
    expect(countForbiddenBriefingTerms(clean)).toBe(0);
    expect(countBriefingContradictions(clean)).toBe(0);
  });
});
