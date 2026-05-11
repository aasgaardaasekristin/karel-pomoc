import { describe, expect, it } from "vitest";
import { evaluateExternalRealityFreshness } from "../../supabase/functions/_shared/externalRealityFreshness.ts";

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

describe("P30.5 freshness predicate (legacy assertions kept as tier-aware)", () => {
  it("fresh published today + anchors → fresh_today_event", () => {
    const r = evaluateExternalRealityFreshness(base);
    expect(r.ok_for_today_display).toBe(true);
    expect(r.display_tier).toBe("fresh_today_event");
  });
  it("missing source_url → not_displayable", () => {
    expect(evaluateExternalRealityFreshness({ ...base, event: { ...base.event, source_url: null } }).display_tier).toBe("not_displayable");
  });
  it("source_published_at older than 48h → historical_sensitive_context", () => {
    const r = evaluateExternalRealityFreshness({ ...base, event: { ...base.event, source_published_at: "2026-05-08T08:00:00Z" } });
    expect(r.ok_for_today_display).toBe(false);
    expect(r.display_tier).toBe("historical_sensitive_context");
  });
  it("null source_published_at + fetched today + anchors → checked_today_unknown_publication_date", () => {
    const r = evaluateExternalRealityFreshness({ ...base, event: { ...base.event, source_published_at: null } });
    expect(r.ok_for_today_display).toBe(false);
    expect(r.ok_for_visible_checked_source).toBe(true);
    expect(r.display_tier).toBe("checked_today_unknown_publication_date");
  });
  it("wrong query_plan_version → not_displayable", () => {
    const r = evaluateExternalRealityFreshness({ ...base, event: { ...base.event, raw_payload: { query_plan_version: "legacy" } } });
    expect(r.display_tier).toBe("not_displayable");
  });
});
