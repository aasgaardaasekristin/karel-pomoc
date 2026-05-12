import { describe, it, expect } from "vitest";
import {
  buildDailyPartWorkabilityMatrix,
  deriveRelevanceDecisionFromMatrix,
} from "../../supabase/functions/_shared/partWorkabilityMatrix";
import type {
  CentrumPartMatrix,
  CentrumPartRow,
} from "../../supabase/functions/_shared/centrumPartMatrix";

const today = "2026-05-12";

function row(
  display: string,
  status: CentrumPartRow["registry_status"] = "active",
): CentrumPartRow {
  return {
    id: display,
    canonical_name: display,
    display_name: display,
    aliases: [],
    registry_status: status,
    raw_status: status,
    source: "drive_index",
  };
}

function centrum(rows: CentrumPartRow[], src: CentrumPartMatrix["source"] = "drive_primary"): CentrumPartMatrix {
  return {
    version: "p33.8",
    source: src,
    read_status: src,
    date_prague: today,
    rows,
    warnings: [],
  };
}

describe("P33.8 partWorkabilityMatrix", () => {
  it("registry-active alone (no fresh evidence) is NOT primary — becomes watch_only", () => {
    const m = buildDailyPartWorkabilityMatrix({
      datePrague: today,
      centrum: centrum([row("Arthur", "active")]),
    });
    expect(m.parts[0].workability).toBe("watch_only");
    expect(m.selected_primary_part).toBeNull();
    expect(m.overall_decision).toBe("no_primary_part_before_first_contact");
  });

  it("dormant part without fresh evidence is dormant_not_for_today, never primary", () => {
    const m = buildDailyPartWorkabilityMatrix({
      datePrague: today,
      centrum: centrum([row("Anička", "dormant")]),
      todayPartProposalPart: "Anička", // stale proposal must NOT promote dormant
    });
    expect(m.parts[0].workability).toBe("dormant_not_for_today");
    expect(m.selected_primary_part).toBeNull();
  });

  it("dormant part WITH fresh evidence becomes possible_after_first_contact (not auto-primary)", () => {
    const m = buildDailyPartWorkabilityMatrix({
      datePrague: today,
      centrum: centrum([row("Anička", "dormant")]),
      recentThreadPartNames: ["Anička"],
    });
    expect(m.parts[0].workability).toBe("possible_after_first_contact");
    expect(m.selected_primary_part).toBeNull();
  });

  it("external reality alone yields watch_only, never primary", () => {
    const m = buildDailyPartWorkabilityMatrix({
      datePrague: today,
      centrum: centrum([row("Tundrupek", "active")]),
      externalRealityParts: [{ part_name: "Tundrupek", activity_status: "watchlist" }],
    });
    expect(m.parts[0].workability).toBe("watch_only");
    expect(m.selected_primary_part).toBeNull();
  });

  it("old/stale team proposal alone cannot make a part primary", () => {
    const old = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const m = buildDailyPartWorkabilityMatrix({
      datePrague: today,
      centrum: centrum([row("Arthur", "active")]),
      freshTeamDeliberations: [
        { id: "d1", status: "approved", session_params: { selected_part: "Arthur" }, updated_at: old },
      ],
    });
    expect(m.parts[0].workability).toBe("watch_only");
    expect(m.selected_primary_part).toBeNull();
  });

  it("active part + today_session evidence = primary_candidate", () => {
    const m = buildDailyPartWorkabilityMatrix({
      datePrague: today,
      centrum: centrum([row("Arthur", "active")]),
      todaysSessionPartNames: ["Arthur"],
    });
    expect(m.parts[0].workability).toBe("primary_candidate");
    expect(m.selected_primary_part).toBe("Arthur");
    expect(m.overall_decision).toBe("primary_part_selected");
  });

  it("no qualifying part → overall_decision = no_primary_part_before_first_contact", () => {
    const m = buildDailyPartWorkabilityMatrix({
      datePrague: today,
      centrum: centrum([row("Arthur", "active"), row("Tundrupek", "active")]),
    });
    expect(m.overall_decision).toBe("no_primary_part_before_first_contact");
    expect(m.selected_primary_part).toBeNull();
  });

  it("missing CENTRUM → blocked_centrum_missing, no invented parts", () => {
    const m = buildDailyPartWorkabilityMatrix({
      datePrague: today,
      centrum: centrum([], "missing"),
      todayPartProposalPart: "Anička",
    });
    expect(m.overall_decision).toBe("blocked_centrum_missing");
    expect(m.parts).toHaveLength(0);
    expect(m.selected_primary_part).toBeNull();
  });

  it("Hana / Karel / Káťa are excluded even if mistakenly in centrum", () => {
    const m = buildDailyPartWorkabilityMatrix({
      datePrague: today,
      centrum: centrum([row("Hana", "active"), row("Karel", "active"), row("Káťa", "active"), row("Arthur", "active")]),
    });
    const excluded = m.parts.filter((p) => p.workability === "excluded").map((p) => p.display_name);
    expect(excluded).toEqual(expect.arrayContaining(["Hana", "Karel", "Káťa"]));
    const arthur = m.parts.find((p) => p.display_name === "Arthur");
    expect(arthur?.workability).not.toBe("excluded");
  });

  it("stale 002_Anička proposal + Arthur watchlist does NOT imply Anička primary", () => {
    const m = buildDailyPartWorkabilityMatrix({
      datePrague: today,
      centrum: centrum([row("Anička", "dormant"), row("Arthur", "active"), row("Tundrupek", "active")]),
      todayPartProposalPart: "002_Anička",
      externalRealityParts: [
        { part_name: "Arthur", activity_status: "watchlist" },
        { part_name: "Tundrupek", activity_status: "watchlist" },
      ],
    });
    const anicka = m.parts.find((p) => p.display_name === "Anička");
    expect(anicka?.workability).toBe("dormant_not_for_today");
    expect(m.selected_primary_part).toBeNull();
  });

  it("derived relevance decision matches matrix overall_decision", () => {
    const noPrimary = buildDailyPartWorkabilityMatrix({
      datePrague: today,
      centrum: centrum([row("Arthur", "active")]),
    });
    const d1 = deriveRelevanceDecisionFromMatrix(noPrimary);
    expect(d1.ok_for_primary_suggestion).toBe(false);
    expect(d1.derived_from).toBe("p33.8_matrix");

    const primary = buildDailyPartWorkabilityMatrix({
      datePrague: today,
      centrum: centrum([row("Arthur", "active")]),
      todaysSessionPartNames: ["Arthur"],
    });
    const d2 = deriveRelevanceDecisionFromMatrix(primary);
    expect(d2.ok_for_primary_suggestion).toBe(true);
    expect(d2.display_name).toBe("Arthur");
  });

  it("evidence flags expose registry_active / has_external_reality_signal / fresh_team_proposal", () => {
    const fresh = new Date().toISOString();
    const m = buildDailyPartWorkabilityMatrix({
      datePrague: today,
      centrum: centrum([row("Arthur", "active")]),
      externalRealityParts: [{ part_name: "Arthur" }],
      freshTeamDeliberations: [
        { id: "d1", status: "approved", session_params: { selected_part: "Arthur" }, updated_at: fresh },
      ],
    });
    const ev = m.parts[0].evidence;
    expect(ev.registry_active).toBe(true);
    expect(ev.has_external_reality_signal).toBe(true);
    expect(ev.has_fresh_team_proposal).toBe(true);
  });

  it("matrix.version is p33.8 and propagates centrum source", () => {
    const m = buildDailyPartWorkabilityMatrix({
      datePrague: today,
      centrum: centrum([row("Arthur", "active")], "profile_fallback"),
    });
    expect(m.version).toBe("p33.8");
    expect(m.source).toBe("profile_fallback");
  });

  it("watch-only parts coexist with primary candidate without overriding it", () => {
    const m = buildDailyPartWorkabilityMatrix({
      datePrague: today,
      centrum: centrum([row("Arthur", "active"), row("Tundrupek", "active")]),
      todaysSessionPartNames: ["Arthur"],
      externalRealityParts: [{ part_name: "Tundrupek" }],
    });
    expect(m.selected_primary_part).toBe("Arthur");
    const tundrupek = m.parts.find((p) => p.display_name === "Tundrupek");
    expect(tundrupek?.workability).toBe("watch_only");
  });

  it("recommended_route on primary candidate is session/first_contact", () => {
    const m = buildDailyPartWorkabilityMatrix({
      datePrague: today,
      centrum: centrum([row("Arthur", "active")]),
      todaysSessionPartNames: ["Arthur"],
    });
    expect(["session", "first_contact"]).toContain(m.parts[0].recommended_route);
  });
});
