/**
 * P30.3 — End-to-end orchestrator.
 *
 *   1. detect today-relevant parts
 *   2. load each part's personal trigger profile (DB-only)
 *   3. read source-backed anchor fact cache
 *   4. evaluate anchor date risk (Prague-local, ±7 days)
 *   5. load reviewed sensitivities
 *   6. build unified query plan (rejects forbidden defaults)
 *   7. run search provider with planned queries (skipping forbidden)
 *   8. dedupe + insert resulting events (source-backed only)
 *   9. log external_event_watch_runs with query_plan_version + metadata
 *  10. upsert part_external_reality_weekly_matrix per relevant part
 *
 * Returns matrix_ids_by_part so the active-part brief writer can record
 * `weekly_matrix_ref` per row.
 */

import { detectTodayRelevantParts } from "./todayRelevantParts.ts";
import {
  loadPartPersonalTriggerProfile,
  type PartPersonalTriggerProfile,
} from "./partPersonalTriggerProfile.ts";
import {
  discoverAndCacheMissingPartAnchorFacts,
  type PartExternalAnchorFact,
} from "./partAnchorFactDiscovery.ts";
import {
  evaluatePartAnchorDateRisk,
  type PartDateRiskResult,
} from "./partAnchorDateRisk.ts";
import {
  buildExternalRealityQueryPlan,
  QUERY_PLAN_VERSION,
  type ExternalRealityQueryPlan,
  type PartExternalEventSensitivity,
} from "./externalRealityQueryPlan.ts";
import { upsertExternalRealityWeeklyMatrix } from "./externalRealityWeeklyMatrixWriter.ts";
import {
  detectProviderFromEnv,
  runExternalRealitySearchProvider,
} from "./externalRealitySearchProvider.ts";
import { normalizeExternalSearchResultToEvent } from "./externalRealityEvents.ts";

// deno-lint-ignore no-explicit-any
type SB = any;

export interface OrchestratorInput {
  userId: string;
  datePrague: string;
  maxQueries?: number;
  maxResultsPerQuery?: number;
  recencyDays?: number;
  dryRun?: boolean;
}

export interface OrchestratorResult {
  ok: boolean;
  query_plan_version: string;
  date_prague: string;
  relevant_parts: Array<{ part_name: string; source: string; reason: string }>;
  card_reads: Array<{ part_name: string; card_read_status: string }>;
  query_plan: ExternalRealityQueryPlan;
  legacy_example_terms_blocked: string[];
  provider_status: string;
  watch_run_id: string | null;
  events_created: number;
  events_deduped: number;
  matrix_rows_upserted: number;
  matrix_ids_by_part: Record<string, string>;
  warnings: string[];
}

export async function runP303ExternalRealityPipeline(
  sb: SB,
  input: OrchestratorInput,
): Promise<OrchestratorResult> {
  const warnings: string[] = [];
  const datePrague = input.datePrague;
  const maxQueries = Math.max(1, Math.min(20, input.maxQueries ?? 12));
  const maxResultsPerQuery = Math.max(1, Math.min(10, input.maxResultsPerQuery ?? 5));
  const recencyDays = Math.max(1, Math.min(30, input.recencyDays ?? 7));

  // 1) relevant parts
  const relevantParts = await detectTodayRelevantParts(sb, {
    userId: input.userId,
    datePrague,
  });

  // 2) profiles
  const profiles: PartPersonalTriggerProfile[] = [];
  for (const rp of relevantParts) {
    const profile = await loadPartPersonalTriggerProfile(sb, {
      userId: input.userId,
      partName: rp.part_name,
      datePrague,
    });
    profiles.push(profile);
  }

  // 3) anchor fact cache
  const anchorFactsByPart = new Map<string, PartExternalAnchorFact[]>();
  for (const profile of profiles) {
    const hints = Array.from(new Set(
      profile.biographical_anchors
        .map((a) => a.anchor_label)
        .filter((s) => s && s.trim() && s.toLowerCase() !== profile.part_name.toLowerCase()),
    ));
    const disc = await discoverAndCacheMissingPartAnchorFacts(sb, {
      userId: input.userId,
      partName: profile.part_name,
      profile,
      allowedLookupHints: hints,
    });
    anchorFactsByPart.set(profile.part_name, disc.facts);
    if (disc.warnings.length) warnings.push(...disc.warnings);
  }

  // 4) date risk
  const dateRiskByPart = new Map<string, PartDateRiskResult>();
  for (const profile of profiles) {
    const risk = evaluatePartAnchorDateRisk({
      datePrague,
      profile,
      anchorFacts: anchorFactsByPart.get(profile.part_name) ?? [],
    });
    dateRiskByPart.set(profile.part_name, risk);
  }

  // 5) reviewed sensitivities
  const partNames = relevantParts.map((r) => r.part_name);
  let sensitivities: PartExternalEventSensitivity[] = [];
  if (partNames.length > 0) {
    const { data: sensRows } = await sb
      .from("part_external_event_sensitivities")
      .select(
        "id, part_name, event_pattern, sensitivity_types, query_terms, " +
          "example_terms, negative_terms, query_enabled, " +
          "example_terms_query_enabled, query_policy, last_reviewed_at",
      )
      .eq("user_id", input.userId)
      .eq("active", true)
      .in("part_name", partNames);
    sensitivities = (sensRows ?? []) as PartExternalEventSensitivity[];
  }

  // 6) query plan
  const queryPlan = buildExternalRealityQueryPlan({
    userId: input.userId,
    datePrague,
    relevantParts,
    personalTriggerProfiles: profiles,
    anchorFacts: Array.from(anchorFactsByPart.values()).flat(),
    dateRiskResults: Array.from(dateRiskByPart.values()),
    sensitivities,
    maxQueries,
  });

  // 7) provider
  const providerInfo = detectProviderFromEnv();
  let providerStatus: "configured" | "provider_not_configured" | "provider_error" =
    providerInfo.provider ? "configured" : "provider_not_configured";
  const externalEventsByPart = new Map<
    string,
    Array<{
      event_id: string;
      event_title: string;
      event_type: string;
      source_url: string | null;
      verification_status: string;
    }>
  >();
  let eventsCreated = 0;
  let eventsDeduped = 0;
  let rawResultsCount = 0;

  // Build per-query metadata so we can map result→part
  const queryMeta = new Map<
    string,
    { partName: string; trigger_category: string; sensitivity_type: string }
  >();
  for (const q of queryPlan.queries) {
    queryMeta.set(q.query, {
      partName: q.part_name,
      trigger_category: q.trigger_category,
      sensitivity_type: q.sensitivity_type ?? q.trigger_category,
    });
  }

  if (queryPlan.queries.length > 0 && providerInfo.provider) {
    const providerResp = await runExternalRealitySearchProvider({
      queries: queryPlan.queries.map((q) => q.query),
      maxResultsPerQuery,
      recencyDays,
    });
    if (!providerResp.ok || providerResp.status === "error") {
      providerStatus = "provider_error";
      warnings.push(
        `provider_error:${providerResp.raw_error ?? providerResp.reason ?? "unknown"}`
          .slice(0, 240),
      );
    } else if (providerResp.status === "not_configured") {
      providerStatus = "provider_not_configured";
    } else {
      rawResultsCount = providerResp.results.length;
      for (const result of providerResp.results) {
        const meta = queryMeta.get(result.query);
        if (!meta) continue;
        const allowedTypes = new Set([
          "animal_suffering",
          "child_abuse",
          "public_trial",
          "disaster",
          "war",
          "rescue_failure",
          "death",
          "anniversary",
          "other",
        ]);
        const safeType = allowedTypes.has(meta.sensitivity_type)
          ? meta.sensitivity_type
          : "other";
        const normalized = await normalizeExternalSearchResultToEvent(result, {
          partName: meta.partName,
          sensitivityId: "p30.3-plan",
          sensitivityKind: meta.trigger_category,
          inferredEventType: safeType,
          childExposureRisk: "high",
          graphicContentRisk: "medium",
          aiSummarized: providerResp.provider === "perplexity",
        });
        const { data: existing } = await sb
          .from("external_reality_events")
          .select("id, event_title, event_type, source_url, verification_status")
          .eq("user_id", input.userId)
          .eq("source_url", normalized.source_url)
          .limit(1);
        let evRow:
          | {
              id: string;
              event_title: string;
              event_type: string;
              source_url: string;
              verification_status: string;
            }
          | null = null;
        if (existing && existing.length > 0) {
          eventsDeduped++;
          evRow = existing[0] as never;
          if (!input.dryRun) {
            await sb
              .from("external_reality_events")
              .update({ last_seen_at: new Date().toISOString() })
              .eq("id", existing[0].id);
          }
        } else if (!input.dryRun) {
          const { data: ins, error: insErr } = await sb
            .from("external_reality_events")
            .insert({
              user_id: input.userId,
              event_title: normalized.event_title,
              event_type: normalized.event_type,
              source_type: "internet_news",
              source_url: normalized.source_url,
              source_domain: normalized.source_name,
              source_reliability: "unknown",
              verification_status: "single_source",
              graphic_content_risk: normalized.graphic_content_risk,
              child_exposure_risk: normalized.child_exposure_risk,
              summary_for_therapists: normalized.event_summary,
              do_not_show_child_text: true,
              raw_payload: {
                provider: normalized.provider,
                search_query: normalized.search_query,
                related_part_name: meta.partName,
                trigger_category: meta.trigger_category,
                query_plan_version: QUERY_PLAN_VERSION,
                fetched_at: normalized.fetched_at,
              },
            })
            .select("id, event_title, event_type, source_url, verification_status")
            .single();
          if (insErr) {
            warnings.push(`insert_event_failed:${insErr.message?.slice(0, 120)}`);
            continue;
          }
          eventsCreated++;
          evRow = ins as never;
        }
        if (evRow) {
          const arr = externalEventsByPart.get(meta.partName) ?? [];
          arr.push({
            event_id: evRow.id,
            event_title: evRow.event_title,
            event_type: evRow.event_type,
            source_url: evRow.source_url,
            verification_status: evRow.verification_status,
          });
          externalEventsByPart.set(meta.partName, arr);
        }
      }
    }
  }

  // 9) log run
  let watchRunId: string | null = null;
  const runPayload = {
    query_plan_version: QUERY_PLAN_VERSION,
    relevant_parts: relevantParts,
    card_reads: profiles.map((p) => ({
      part_name: p.part_name,
      card_read_status: p.card_read_status,
      controlled_skips: p.controlled_skips,
    })),
    query_plan: queryPlan.queries,
    ignored_example_terms_global: queryPlan.ignored_example_terms_global,
    legacy_example_terms_blocked: queryPlan.legacy_example_terms_blocked,
    raw_results_count: rawResultsCount,
    events_deduped: eventsDeduped,
    warnings,
  };
  try {
    const { data: runRow } = await sb
      .from("external_event_watch_runs")
      .insert({
        user_id: input.userId,
        source_type: "internet_news",
        sources_checked: queryPlan.queries.length,
        new_events: eventsCreated,
        matched_events: eventsCreated,
        warnings_created: 0,
        failures: warnings.length,
        internet_watch_status: providerStatus,
        notes: `p30.3 plan_version=${QUERY_PLAN_VERSION} parts=${relevantParts.length} queries=${queryPlan.queries.length}`,
        payload: runPayload,
      })
      .select("id")
      .single();
    watchRunId = runRow?.id ?? null;
  } catch (e) {
    warnings.push(`watch_run_insert_failed:${(e as Error).message}`);
  }

  // 10) weekly matrix
  const eventsCountByPart = new Map<string, number>();
  const sourceBackedCountByPart = new Map<string, number>();
  for (const [name, evs] of externalEventsByPart) {
    eventsCountByPart.set(name, evs.length);
    sourceBackedCountByPart.set(
      name,
      evs.filter((e) => e.source_url && /^https?:\/\//i.test(e.source_url)).length,
    );
  }
  const matrixRes = await upsertExternalRealityWeeklyMatrix(sb, {
    userId: input.userId,
    datePrague,
    relevantParts,
    profiles,
    anchorFactsByPart,
    dateRiskByPart,
    queryPlan,
    externalEventsByPart,
    providerStatus,
    eventsCountByPart,
    sourceBackedCountByPart,
  });
  if (matrixRes.warnings.length) warnings.push(...matrixRes.warnings);

  return {
    ok: providerStatus !== "provider_error",
    query_plan_version: QUERY_PLAN_VERSION,
    date_prague: datePrague,
    relevant_parts: relevantParts.map((r) => ({
      part_name: r.part_name,
      source: r.source,
      reason: r.reason,
    })),
    card_reads: profiles.map((p) => ({
      part_name: p.part_name,
      card_read_status: p.card_read_status,
    })),
    query_plan: queryPlan,
    legacy_example_terms_blocked: queryPlan.legacy_example_terms_blocked,
    provider_status: providerStatus,
    watch_run_id: watchRunId,
    events_created: eventsCreated,
    events_deduped: eventsDeduped,
    matrix_rows_upserted: matrixRes.rows_upserted,
    matrix_ids_by_part: Object.fromEntries(matrixRes.matrix_ids_by_part),
    warnings,
  };
}
