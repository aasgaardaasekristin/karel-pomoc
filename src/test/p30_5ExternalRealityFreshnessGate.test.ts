import { describe, expect, it } from "vitest";
import { evaluateExternalRealityFreshness } from "../../supabase/functions/_shared/externalRealityFreshness.ts";
import { generateActivePartDailyBriefs } from "../../supabase/functions/_shared/activePartDailyBrief.ts";
import { clusterAndHumanizeExternalImpacts, type RawExternalImpact } from "@/lib/externalImpactHumanizer";
import { renderKarelBriefingVoice } from "../../supabase/functions/_shared/karelBriefingVoiceRenderer";

const QPV = "p30.3_personal_anchor_general_trigger_weekly_matrix";
const base = {
  datePrague: "2026-05-11",
  event: {
    source_url: "https://zpravy.example.cz/timmy",
    source_published_at: "2026-05-11T08:00:00Z",
    fetched_at: "2026-05-11T09:00:00Z",
    last_seen_at: "2026-05-11T10:00:00Z",
    raw_payload: { query_plan_version: QPV },
  },
  watchRun: { ran_at: "2026-05-11T09:05:00Z", query_plan_version: QPV, provider_status: "configured" },
  matrixRow: { id: "matrix-tundrupek", date_prague: "2026-05-11" },
  activePartBrief: { brief_date: "2026-05-11", evidence_summary: { weekly_matrix_ref: "matrix-tundrupek", query_plan_version: QPV } },
};

describe("P30.5 external reality freshness predicate", () => {
  it("allows fresh source URL published today with today's watch/matrix links", () => {
    expect(evaluateExternalRealityFreshness(base).ok_for_today_display).toBe(true);
  });

  it("rejects missing source_url", () => {
    expect(evaluateExternalRealityFreshness({ ...base, event: { ...base.event, source_url: null } }).ok_for_today_display).toBe(false);
  });

  it("rejects source_published_at older than 48h", () => {
    const r = evaluateExternalRealityFreshness({ ...base, event: { ...base.event, source_published_at: "2026-05-08T08:00:00Z" } });
    expect(r.ok_for_today_display).toBe(false);
    expect(r.status).toBe("stale");
  });

  it("rejects null source_published_at even when fetched_at is today", () => {
    const r = evaluateExternalRealityFreshness({ ...base, event: { ...base.event, source_published_at: null, fetched_at: "2026-05-11T09:00:00Z" } });
    expect(r.ok_for_today_display).toBe(false);
    expect(r.status).toBe("unknown_recency");
  });

  it("rejects last_seen_at today when source is old or unknown", () => {
    expect(evaluateExternalRealityFreshness({ ...base, event: { ...base.event, source_published_at: "2026-05-01", last_seen_at: "2026-05-11T10:00:00Z" } }).ok_for_today_display).toBe(false);
    expect(evaluateExternalRealityFreshness({ ...base, event: { ...base.event, source_published_at: null, last_seen_at: "2026-05-11T10:00:00Z" } }).ok_for_today_display).toBe(false);
  });

  it("requires query plan, weekly matrix ref, active brief date, and matrix date", () => {
    expect(evaluateExternalRealityFreshness({ ...base, event: { ...base.event, raw_payload: { query_plan_version: "legacy" } } }).ok_for_today_display).toBe(false);
    expect(evaluateExternalRealityFreshness({ ...base, activePartBrief: { brief_date: "2026-05-11", evidence_summary: { query_plan_version: QPV } } }).ok_for_today_display).toBe(false);
    expect(evaluateExternalRealityFreshness({ ...base, activePartBrief: { brief_date: "2026-05-10", evidence_summary: { weekly_matrix_ref: "m", query_plan_version: QPV } } }).ok_for_today_display).toBe(false);
    expect(evaluateExternalRealityFreshness({ ...base, matrixRow: { id: "m", date_prague: "2026-05-10" } }).ok_for_today_display).toBe(false);
  });
});

function makeMockSb(events: any[]) {
  const captured: any[] = [];
  const registry = [{ part_name: "Tundrupek", status: "active" }];
  const sensitivities = [{ id: "s1", part_name: "Tundrupek", event_pattern: "Timmy", sensitivity_types: [], recommended_guard: null, safe_opening_style: null, active: true }];
  const builder = (table: string) => {
    const api: any = {
      select: () => api, eq: () => api, gte: () => api, lte: () => api, in: () => api, order: () => api, limit: () => api,
      maybeSingle: async () => ({ data: table === "external_event_watch_runs" ? { id: "run", ran_at: "2026-05-11T09:00:00Z", internet_watch_status: "configured", payload: { query_plan_version: QPV } } : null, error: null }),
      upsert: async (row: any) => { captured.push({ table, row }); return { data: row, error: null }; },
    };
    api.then = (resolve: any) => Promise.resolve({ data: table === "did_part_registry" ? registry : table === "part_external_event_sensitivities" ? sensitivities : table === "external_reality_events" ? events : [], error: null }).then(resolve);
    return api;
  };
  return { from: builder, captured };
}

describe("P30.5 active part brief + visible panel + renderer", () => {
  it("excludes stale Timmy from internet_triggers_today and moves it to historical", async () => {
    const sb = makeMockSb([{ id: "e-old", event_title: "Timmy staré téma", event_type: "animal_suffering", source_url: "https://example.cz/timmy", source_domain: "example.cz", verification_status: "single_source", created_at: "2026-05-07T08:00:00Z", last_seen_at: "2026-05-11T09:00:00Z", raw_payload: { related_part_name: "Tundrupek", query_plan_version: QPV, source_published_at: null, fetched_at: "2026-05-11T09:00:00Z" } }]);
    await generateActivePartDailyBriefs(sb as any, { userId: "u", datePrague: "2026-05-11", matrixIdsByPart: { Tundrupek: "matrix-tundrupek" }, queryPlanVersion: QPV });
    const row = sb.captured.find((c) => c.table === "did_active_part_daily_brief")!.row;
    expect(row.internet_triggers_today).toEqual([]);
    expect(row.evidence_summary.historical_external_triggers).toHaveLength(1);
    expect(row.evidence_summary.source_backed_event_count).toBe(0);
    expect(row.evidence_summary.historical_source_backed_count).toBe(1);
  });

  it("visible panel humanizer drops stale events and never exposes internal terms", () => {
    const impacts: RawExternalImpact[] = [mkImpact(false), mkImpact(true)];
    const cards = clusterAndHumanizeExternalImpacts(impacts);
    expect(cards).toHaveLength(1);
    expect(cards[0].freshness_ok).toBe(true);
    const visible = `${cards[0].theme_label} ${cards[0].body}`;
    expect(visible).not.toMatch(/provider_status|query_plan_version|weekly_matrix_ref/);
  });

  it("renderer separates historical context and does not call stale events today's trigger", () => {
    const payload: any = {
      briefing_truth_gate: { ok: true, source_cycle_id: "cyc" },
      phase_jobs_snapshot: { total: 14, completed: 14 },
      today_part_proposal: { proposed_part: "Tundrupek" }, ask_hanka: [], ask_kata: [], proposed_session: null, proposed_playroom: null, lingering: [],
      external_reality_watch: { provider_status: "configured", active_part_daily_brief_count: 1, source_backed_events_count: 0, internet_events_used_count: 0, parts: [{ part_name: "Tundrupek", internet_triggers_today: [], evidence_summary: { historical_external_triggers: [{ title: "Timmy" }] } }] },
    };
    const r = renderKarelBriefingVoice(payload);
    const risk = r.sections.find((s) => s.section_id === "risks_sensitivities")!.karel_text;
    expect(risk).toMatch(/dříve evidovaný citlivý okruh|bez čerstvého zdrojovaného podkladu/);
    expect(risk).not.toMatch(/dnes vidím možný spouštěč zvenku|může dnes zatížit|dnes se objevilo/);
  });
});

function mkImpact(fresh: boolean): RawExternalImpact {
  return { id: fresh ? "fresh" : "stale", event_id: "e", part_name: "Tundrupek", risk_level: "red", reason: "Timmy", recommended_action: null, external_reality_events: { event_title: "Timmy", event_type: "animal_suffering", source_type: "internet_news", verification_status: "single_source", graphic_content_risk: "medium", summary_for_therapists: "", source_domain: "example.cz", source_published_at: fresh ? "2026-05-11" : null, fetched_at: "2026-05-11", freshness: { ok_for_today_display: fresh } } };
}
