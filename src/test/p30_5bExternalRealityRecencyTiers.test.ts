import { describe, expect, it } from "vitest";
import { evaluateExternalRealityFreshness } from "../../supabase/functions/_shared/externalRealityFreshness.ts";
import { generateActivePartDailyBriefs } from "../../supabase/functions/_shared/activePartDailyBrief.ts";
import { clusterAndHumanizeExternalImpacts, type RawExternalImpact } from "@/lib/externalImpactHumanizer";
import { renderKarelBriefingVoice } from "../../supabase/functions/_shared/karelBriefingVoiceRenderer";

const QPV = "p30.3_personal_anchor_general_trigger_weekly_matrix";
const today = "2026-05-11";
const baseAnchors = {
  watchRun: { ran_at: `${today}T09:05:00Z`, query_plan_version: QPV, provider_status: "configured" },
  matrixRow: { id: "matrix-x", date_prague: today },
  activePartBrief: { brief_date: today, evidence_summary: { weekly_matrix_ref: "matrix-x", query_plan_version: QPV } },
};

function ev(overrides: Partial<{ source_url: string | null; source_published_at: string | null; fetched_at: string | null; last_seen_at: string | null; query_plan_version: string }>) {
  const raw: any = { query_plan_version: overrides.query_plan_version ?? QPV };
  return {
    source_url: overrides.source_url ?? "https://example.cz/x",
    source_published_at: overrides.source_published_at ?? null,
    fetched_at: overrides.fetched_at ?? `${today}T09:00:00Z`,
    last_seen_at: overrides.last_seen_at ?? `${today}T10:00:00Z`,
    raw_payload: raw,
  };
}

describe("P30.5B recency tiers — predicate", () => {
  it("tier 1 fresh: source_published_at today + anchors", () => {
    const r = evaluateExternalRealityFreshness({ datePrague: today, event: ev({ source_published_at: `${today}T08:00:00Z` }), ...baseAnchors });
    expect(r.display_tier).toBe("fresh_today_event");
    expect(r.ok_for_today_display).toBe(true);
    expect(r.ok_for_visible_checked_source).toBe(true);
    expect(r.language_policy.may_say_today_event).toBe(true);
  });
  it("tier 2 checked-today unknown date: null published + fetched today + anchors", () => {
    const r = evaluateExternalRealityFreshness({ datePrague: today, event: ev({ source_published_at: null }), ...baseAnchors });
    expect(r.display_tier).toBe("checked_today_unknown_publication_date");
    expect(r.ok_for_today_display).toBe(false);
    expect(r.ok_for_visible_checked_source).toBe(true);
    expect(r.language_policy.may_say_today_event).toBe(false);
    expect(r.language_policy.must_say_publication_date_unknown).toBe(true);
  });
  it("tier 2 not granted when no watch run today even if last_seen_at today", () => {
    const r = evaluateExternalRealityFreshness({
      datePrague: today,
      event: ev({ source_published_at: null, fetched_at: null, last_seen_at: `${today}T10:00:00Z` }),
      watchRun: { ran_at: "2026-05-09T10:00:00Z", query_plan_version: QPV, provider_status: "configured" },
      matrixRow: baseAnchors.matrixRow,
      activePartBrief: baseAnchors.activePartBrief,
    });
    expect(r.display_tier).toBe("not_displayable");
  });
  it("tier 3 historical: old source_published_at", () => {
    const r = evaluateExternalRealityFreshness({ datePrague: today, event: ev({ source_published_at: "2026-05-01T08:00:00Z" }), ...baseAnchors });
    expect(r.display_tier).toBe("historical_sensitive_context");
    expect(r.ok_for_visible_checked_source).toBe(true);
    expect(r.language_policy.must_say_historical_only).toBe(true);
  });
  it("not displayable: no source_url", () => {
    const r = evaluateExternalRealityFreshness({ datePrague: today, event: ev({ source_url: null, source_published_at: `${today}T08:00:00Z` }), ...baseAnchors });
    expect(r.display_tier).toBe("not_displayable");
  });
  it("not displayable: wrong query_plan_version", () => {
    const r = evaluateExternalRealityFreshness({ datePrague: today, event: ev({ source_published_at: `${today}T08:00:00Z`, query_plan_version: "legacy" }), ...baseAnchors });
    expect(r.display_tier).toBe("not_displayable");
  });
  it("not displayable: missing weekly_matrix_ref in active brief", () => {
    const r = evaluateExternalRealityFreshness({
      datePrague: today,
      event: ev({ source_published_at: `${today}T08:00:00Z` }),
      watchRun: baseAnchors.watchRun,
      matrixRow: baseAnchors.matrixRow,
      activePartBrief: { brief_date: today, evidence_summary: { query_plan_version: QPV } },
    });
    expect(r.display_tier).toBe("not_displayable");
  });
});

function makeMockSb(events: any[]) {
  const captured: any[] = [];
  const registry = [{ part_name: "Tundrupek", status: "active" }];
  const sensitivities = [{ id: "s1", part_name: "Tundrupek", event_pattern: "Timmy", sensitivity_types: [], recommended_guard: null, safe_opening_style: null, active: true }];
  const builder = (table: string) => {
    const api: any = {
      select: () => api, eq: () => api, gte: () => api, lte: () => api, in: () => api, order: () => api, limit: () => api,
      maybeSingle: async () => ({ data: table === "external_event_watch_runs" ? { id: "run", ran_at: `${today}T09:00:00Z`, internet_watch_status: "configured", payload: { query_plan_version: QPV } } : null, error: null }),
      upsert: async (row: any) => { captured.push({ table, row }); return { data: row, error: null }; },
    };
    api.then = (resolve: any) => Promise.resolve({ data: table === "did_part_registry" ? registry : table === "part_external_event_sensitivities" ? sensitivities : table === "external_reality_events" ? events : [], error: null }).then(resolve);
    return api;
  };
  return { from: builder, captured };
}

describe("P30.5B active part daily brief: tier-2 sources stay visible", () => {
  it("null published + fetched today goes to checked_external_sources_today, not internet_triggers_today", async () => {
    const sb = makeMockSb([{
      id: "e-checked", event_title: "Timmy téma", event_type: "animal_suffering",
      source_url: "https://example.cz/timmy", source_domain: "example.cz",
      verification_status: "single_source",
      created_at: `${today}T08:00:00Z`, last_seen_at: `${today}T09:00:00Z`,
      raw_payload: { related_part_name: "Tundrupek", query_plan_version: QPV, source_published_at: null, fetched_at: `${today}T09:00:00Z` },
    }]);
    await generateActivePartDailyBriefs(sb as any, { userId: "u", datePrague: today, matrixIdsByPart: { Tundrupek: "matrix-x" }, queryPlanVersion: QPV });
    const row = sb.captured.find((c) => c.table === "did_active_part_daily_brief")!.row;
    expect(row.internet_triggers_today).toEqual([]);
    const checked = row.evidence_summary.checked_external_sources_today;
    expect(Array.isArray(checked)).toBe(true);
    expect(checked).toHaveLength(1);
    expect(row.evidence_summary.checked_today_unknown_date_count).toBe(1);
    expect(row.evidence_summary.fresh_today_event_count).toBe(0);
    expect(row.evidence_summary.visible_checked_source_count).toBe(1);
  });

  it("old published goes to historical_external_triggers", async () => {
    const sb = makeMockSb([{
      id: "e-old", event_title: "Timmy staré", event_type: "animal_suffering",
      source_url: "https://example.cz/old", source_domain: "example.cz",
      verification_status: "single_source",
      created_at: "2026-05-01T08:00:00Z", last_seen_at: `${today}T09:00:00Z`,
      raw_payload: { related_part_name: "Tundrupek", query_plan_version: QPV, source_published_at: "2026-05-01T08:00:00Z", fetched_at: `${today}T09:00:00Z` },
    }]);
    await generateActivePartDailyBriefs(sb as any, { userId: "u", datePrague: today, matrixIdsByPart: { Tundrupek: "matrix-x" }, queryPlanVersion: QPV });
    const row = sb.captured.find((c) => c.table === "did_active_part_daily_brief")!.row;
    expect(row.evidence_summary.historical_external_triggers).toHaveLength(1);
    expect(row.evidence_summary.historical_source_backed_count).toBe(1);
  });
});

function mkImpact(tier: "fresh_today_event" | "checked_today_unknown_publication_date" | "historical_sensitive_context" | "not_displayable", id?: string): RawExternalImpact {
  id = id ?? tier;
  return {
    id, event_id: "e", part_name: "Tundrupek", risk_level: "red", reason: "Timmy", recommended_action: null,
    external_reality_events: {
      event_title: "Timmy", event_type: "animal_suffering", source_type: "internet_news",
      verification_status: "single_source", graphic_content_risk: "medium", summary_for_therapists: "",
      source_domain: "example.cz",
      source_published_at: tier === "fresh_today_event" ? today : tier === "historical_sensitive_context" ? "2026-05-01" : null,
      fetched_at: today,
      freshness: {
        display_tier: tier,
        ok_for_today_display: tier === "fresh_today_event",
        ok_for_visible_checked_source: tier !== "not_displayable",
      } as any,
    },
  };
}

describe("P30.5B humanizer renders 3 tiers with correct language", () => {
  it("renders tier-2 with 'datum publikace' caution and no 'může dnes zatížit'", () => {
    const cards = clusterAndHumanizeExternalImpacts([mkImpact("checked_today_unknown_publication_date")]);
    expect(cards).toHaveLength(1);
    expect(cards[0].display_tier).toBe("checked_today_unknown_publication_date");
    expect(cards[0].body + " " + (cards[0].caution_label ?? "")).toMatch(/datum publikace/i);
    expect(cards[0].body).not.toMatch(/může dnes zatížit|dnešní událost|dnes se objevilo/i);
  });
  it("renders tier-3 with historical wording", () => {
    const cards = clusterAndHumanizeExternalImpacts([mkImpact("historical_sensitive_context")]);
    expect(cards[0].display_tier).toBe("historical_sensitive_context");
    expect(cards[0].body).toMatch(/dříve evidovaný|bez čerstvého zdrojovaného/i);
  });
  it("hides not_displayable", () => {
    const cards = clusterAndHumanizeExternalImpacts([mkImpact("not_displayable")]);
    expect(cards).toHaveLength(0);
  });
  it("renders all tiers when mixed and sorts fresh first", () => {
    const cards = clusterAndHumanizeExternalImpacts([
      { ...mkImpact("historical_sensitive_context", "h"), part_name: "A" },
      { ...mkImpact("checked_today_unknown_publication_date", "c"), part_name: "B" },
      { ...mkImpact("fresh_today_event", "f"), part_name: "C" },
    ]);
    expect(cards.map((c) => c.display_tier)).toEqual([
      "fresh_today_event", "checked_today_unknown_publication_date", "historical_sensitive_context",
    ]);
  });
});

describe("P30.5B voice renderer mentions tier-2 cautiously", () => {
  it("uses cautious checked-today wording without claiming today event", () => {
    const payload: any = {
      briefing_truth_gate: { ok: true, source_cycle_id: "cyc" },
      phase_jobs_snapshot: { total: 14, completed: 14 },
      today_part_proposal: { proposed_part: "Tundrupek" }, ask_hanka: [], ask_kata: [], proposed_session: null, proposed_playroom: null, lingering: [],
      external_reality_watch: { provider_status: "configured", active_part_daily_brief_count: 1, source_backed_events_count: 0, internet_events_used_count: 0,
        parts: [{ part_name: "Tundrupek", internet_triggers_today: [],
          evidence_summary: { checked_external_sources_today: [{ title: "Timmy", source_url: "https://x" }] } }] },
    };
    const r = renderKarelBriefingVoice(payload);
    const risk = r.sections.find((s) => s.section_id === "risks_sensitivities")!.karel_text;
    expect(risk).toMatch(/dnes znovu ověřil|datum publikace zdroje není jasné/i);
    expect(risk).not.toMatch(/dnes se objevilo|dnešní událost|čerstvá událost/i);
  });
});
