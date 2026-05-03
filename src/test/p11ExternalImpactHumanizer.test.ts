import { describe, it, expect } from "vitest";
import {
  stripInternalMarkers,
  inferThemeCluster,
  clusterAndHumanizeExternalImpacts,
  type RawExternalImpact,
} from "@/lib/externalImpactHumanizer";
import {
  countVisibleForbiddenTerms,
  detectClinicalTextViolations,
  FORBIDDEN_TECHNICAL_TERMS,
} from "@/lib/visibleClinicalTextGuard";

describe("P11: externalImpactHumanizer + guard expansion", () => {
  it("FORBIDDEN_TECHNICAL_TERMS contains P11 classifier tokens", () => {
    for (const t of [
      "animal_suffering",
      "rescue_failure",
      "broken_promise",
      "child_abuse",
      "identity_link",
      "injustice",
      "external_event_impacts",
      "(typy:",
      "(types:",
    ]) {
      expect(FORBIDDEN_TECHNICAL_TERMS).toContain(t);
    }
  });

  it("strips P11 dedup audit prefix, (typy: ...) blocks, and bare underscore tokens", () => {
    const raw =
      '[p11_dedup_acknowledged] Část Tundrupek má citlivost na vzor "Timmy" (typy: animal_suffering, rescue_failure, broken_promise).';
    const cleaned = stripInternalMarkers(raw);
    expect(cleaned).not.toMatch(/animal_suffering|rescue_failure|broken_promise/);
    expect(cleaned).not.toMatch(/\(typy:/i);
    expect(cleaned).not.toMatch(/p11_dedup/);
    expect(cleaned).toMatch(/Tundrupek/);
  });

  it("detects classifier tokens in arbitrary visible text", () => {
    const t =
      "Část Tundrupek má citlivost na vzor (typy: animal_suffering, rescue_failure).";
    expect(countVisibleForbiddenTerms(t, { surface: "briefing" })).toBeGreaterThan(0);
    const v = detectClinicalTextViolations(t, { surface: "briefing" });
    expect(v.some((x) => /animal_suffering/.test(x.match))).toBe(true);
    expect(v.some((x) => /\(typy:/i.test(x.match))).toBe(true);
  });

  it("clusters Tundrupek/Timmy/whale/animal-cruelty into ONE display card", () => {
    const impacts: RawExternalImpact[] = [
      mkImpact("1", "Tundrupek", "red", "Timmy", "animal_suffering"),
      mkImpact("2", "Tundrupek", "red", "velryba", "animal_suffering"),
      mkImpact("3", "Tundrupek", "red", "týrání zvířat", "animal_suffering"),
      mkImpact("4", "Tundrupek", "red", "Timmy", "animal_suffering"),
      mkImpact("5", "Tundrupek", "red", "velryba", "animal_suffering"),
      mkImpact("6", "Tundrupek", "red", "týrání zvířat", "animal_suffering"),
    ];
    const cards = clusterAndHumanizeExternalImpacts(impacts);
    expect(cards).toHaveLength(1);
    expect(cards[0].part_name).toBe("Tundrupek");
    expect(cards[0].risk_level).toBe("red");
    expect(cards[0].source_impact_ids).toHaveLength(6);
    expect(cards[0].body).toMatch(/velryby Timmy/);
    expect(cards[0].body).not.toMatch(/animal_suffering|rescue_failure|broken_promise/);
    expect(cards[0].recommendation ?? "").not.toMatch(/animal_suffering|rescue_failure|broken_promise/);
  });

  it("inferThemeCluster: Tundrupek + animal_suffering → Timmy/whale cluster", () => {
    const a = inferThemeCluster("Timmy", "animal_suffering", "Tundrupek");
    const b = inferThemeCluster("velryba", "animal_suffering", "Tundrupek");
    const c = inferThemeCluster("týrání zvířat", "animal_suffering", "Tundrupek");
    expect(a.cluster).toBe(b.cluster);
    expect(b.cluster).toBe(c.cluster);
    expect(a.label).toMatch(/Timmy/);
  });

  it("rendered cluster body+reco contain zero forbidden terms (P1+P11 guard)", () => {
    const impacts: RawExternalImpact[] = [
      mkImpact("x", "Tundrupek", "red", "Timmy", "animal_suffering"),
    ];
    const [card] = clusterAndHumanizeExternalImpacts(impacts);
    const body = `${card.theme_label} ${card.body} ${card.recommendation ?? ""}`;
    expect(countVisibleForbiddenTerms(body, { surface: "briefing" })).toBe(0);
  });

  it("returns empty array for empty input", () => {
    expect(clusterAndHumanizeExternalImpacts([])).toEqual([]);
  });
});

function mkImpact(
  id: string,
  part: string,
  risk: "watch" | "amber" | "red",
  eventTitle: string,
  eventType: string,
): RawExternalImpact {
  return {
    id,
    event_id: `event-${eventTitle}`,
    part_name: part,
    risk_level: risk,
    reason: `Část ${part} má citlivost na vzor "${eventTitle}" (typy: ${eventType}, rescue_failure, broken_promise).`,
    recommended_action:
      "[p11_dedup_acknowledged] Stabilizace; nepředkládat grafické detaily.",
    external_reality_events: {
      event_title: eventTitle,
      event_type: eventType,
      source_type: "therapist_report",
      verification_status: "therapist_confirmed",
      graphic_content_risk: "medium",
      summary_for_therapists: "",
    },
  };
}
