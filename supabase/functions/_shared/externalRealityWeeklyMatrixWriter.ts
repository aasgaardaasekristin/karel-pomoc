/**
 * P30.3 — Weekly matrix writer.
 *
 * Upserts one row per (user_id, date_prague, part_name) into
 * public.part_external_reality_weekly_matrix.
 *
 * Hard rules:
 *   - never invent personal_triggers / biographical_anchors / source_refs
 *   - ignored_example_terms must be recorded when present
 *   - query_plan stores the slice of the unified plan for the part
 *   - source_refs must be source-backed (http(s) URL)
 */

import type { TodayRelevantPartContext } from "./todayRelevantParts.ts";
import type { PartPersonalTriggerProfile } from "./partPersonalTriggerProfile.ts";
import type { PartExternalAnchorFact } from "./partAnchorFactDiscovery.ts";
import type { PartDateRiskResult } from "./partAnchorDateRisk.ts";
import type { ExternalRealityQueryPlan } from "./externalRealityQueryPlan.ts";

// deno-lint-ignore no-explicit-any
type SB = any;

export interface WeeklyMatrixUpsertInput {
  userId: string;
  datePrague: string;
  relevantParts: TodayRelevantPartContext[];
  profiles: PartPersonalTriggerProfile[];
  anchorFactsByPart: Map<string, PartExternalAnchorFact[]>;
  dateRiskByPart: Map<string, PartDateRiskResult>;
  queryPlan: ExternalRealityQueryPlan;
  /** Source-backed external events keyed by part. */
  externalEventsByPart: Map<
    string,
    Array<{
      event_id: string;
      event_title: string;
      event_type: string;
      source_url: string | null;
      verification_status: string;
    }>
  >;
  providerStatus: string;
  eventsCountByPart: Map<string, number>;
  sourceBackedCountByPart: Map<string, number>;
}

export interface WeeklyMatrixUpsertResult {
  rows_upserted: number;
  matrix_ids_by_part: Map<string, string>;
  warnings: string[];
}

function weekBoundsPrague(datePrague: string): { weekStart: string; weekEnd: string } {
  // ISO week, Monday start
  const d = new Date(`${datePrague}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0=Mon
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - dow);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return {
    weekStart: start.toISOString().slice(0, 10),
    weekEnd: end.toISOString().slice(0, 10),
  };
}

export async function upsertExternalRealityWeeklyMatrix(
  sb: SB,
  input: WeeklyMatrixUpsertInput,
): Promise<WeeklyMatrixUpsertResult> {
  const result: WeeklyMatrixUpsertResult = {
    rows_upserted: 0,
    matrix_ids_by_part: new Map(),
    warnings: [],
  };
  const { weekStart, weekEnd } = weekBoundsPrague(input.datePrague);

  for (const rp of input.relevantParts) {
    const partName = rp.part_name;
    const profile = input.profiles.find((p) => p.part_name === partName);
    const anchorFacts = input.anchorFactsByPart.get(partName) ?? [];
    const dateRisk = input.dateRiskByPart.get(partName);
    const partQueries = input.queryPlan.queries.filter((q) => q.part_name === partName);

    const personalTriggers = profile?.personal_triggers ?? [];
    const biographicalAnchors = profile?.biographical_anchors ?? [];

    const anchorDateRisks = dateRisk && dateRisk.risk_level !== "none"
      ? [{
          risk_level: dateRisk.risk_level,
          matched_dates: dateRisk.matched_dates,
          recommended_guard: dateRisk.recommended_guard,
        }]
      : [];

    const ignoredExamples = Array.from(new Set(
      partQueries.flatMap((q) => q.ignored_example_terms),
    ));

    const events = input.externalEventsByPart.get(partName) ?? [];
    const sourceRefs = events
      .filter((e) => e.source_url && /^https?:\/\//i.test(e.source_url))
      .map((e) => ({
        url: e.source_url,
        title: e.event_title,
        verification_status: e.verification_status,
      }));

    const recommendedGuards = profile?.recommended_guards ?? [];

    const sensitivityTriggers = (profile?.personal_triggers ?? []).map((t) => ({
      trigger_label: t.trigger_label,
      trigger_category: t.trigger_category,
      source_ref: t.source_ref,
    }));

    const row = {
      user_id: input.userId,
      week_start: weekStart,
      week_end: weekEnd,
      date_prague: input.datePrague,
      part_name: partName,
      part_relevance_source: rp.source,
      part_relevance_reason: rp.reason,
      card_read_status: profile?.card_read_status ?? "card_missing",
      personal_triggers: personalTriggers as unknown as object[],
      biographical_anchors: biographicalAnchors as unknown as object[],
      anchor_date_risks: anchorDateRisks as unknown as object[],
      sensitivity_triggers: sensitivityTriggers as unknown as object[],
      query_plan: partQueries as unknown as object[],
      ignored_example_terms: ignoredExamples,
      external_events: events as unknown as object[],
      source_refs: sourceRefs as unknown as object[],
      recommended_guards: recommendedGuards as unknown as object[],
      provider_status: input.providerStatus,
      events_count: input.eventsCountByPart.get(partName) ?? events.length,
      source_backed_events_count:
        input.sourceBackedCountByPart.get(partName) ?? sourceRefs.length,
    };

    const { data, error } = await sb
      .from("part_external_reality_weekly_matrix")
      .upsert(row, { onConflict: "user_id,date_prague,part_name" })
      .select("id")
      .single();
    if (error) {
      result.warnings.push(`matrix_upsert_failed:${partName}:${error.message}`);
      continue;
    }
    result.rows_upserted++;
    if (data?.id) result.matrix_ids_by_part.set(partName, data.id);
  }

  return result;
}
