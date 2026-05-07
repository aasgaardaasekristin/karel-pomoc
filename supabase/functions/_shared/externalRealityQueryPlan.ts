/**
 * P30.3 — Unified dynamic query plan combining personal anchors,
 * source-backed biographical anchors, date risk, sensitivity profiles
 * and a general category sweep.
 *
 * Hard rules:
 *   - never use part name itself as query
 *   - never use example_terms by default (only when reviewed + flagged)
 *   - external anchor only if source-backed
 *   - date risk only if source-backed
 *   - dedupe by (part_name, trigger_category, normalized_query)
 *   - record ignored_example_terms
 */

import type { TodayRelevantPartContext } from "./todayRelevantParts.ts";
import type { PartPersonalTriggerProfile } from "./partPersonalTriggerProfile.ts";
import type { PartExternalAnchorFact } from "./partAnchorFactDiscovery.ts";
import type { PartDateRiskResult } from "./partAnchorDateRisk.ts";
import { buildGeneralExternalTriggerSweepQueries } from "./externalRealityCategorySweep.ts";

export const QUERY_PLAN_VERSION = "p30.3_personal_anchor_general_trigger_weekly_matrix";

export interface PartExternalEventSensitivity {
  id: string;
  part_name: string;
  event_pattern: string;
  sensitivity_types: string[];
  query_terms?: string[];
  example_terms?: string[];
  negative_terms?: string[];
  query_enabled?: boolean;
  example_terms_query_enabled?: boolean;
  query_policy?: string;
  last_reviewed_at?: string | null;
}

export type TriggerSource =
  | "card_personal_trigger"
  | "biographical_anchor"
  | "date_risk"
  | "part_profile"
  | "sensitivity_profile"
  | "general_trigger_sweep"
  | "category_template";

export type QueryPolicy =
  | "category_template"
  | "explicit_query_terms"
  | "personal_trigger_terms"
  | "biographical_anchor_terms"
  | "date_risk_terms"
  | "manual_review_required";

export type QuerySource =
  | "personal_trigger_query_terms"
  | "sensitivity_query_terms"
  | "category_template"
  | "biographical_anchor_query_terms"
  | "date_risk_category"
  | "explicit_query_terms";

export interface ExternalRealityQuery {
  query: string;
  part_name: string;
  trigger_source: TriggerSource;
  anchor_label?: string;
  sensitivity_id?: string;
  personal_trigger_label?: string;
  sensitivity_type?: string;
  trigger_category: string;
  query_policy: QueryPolicy;
  query_source: QuerySource;
  used_terms: string[];
  ignored_example_terms: string[];
  negative_terms: string[];
  reason: string;
}

export interface QueryPlanInput {
  userId: string;
  datePrague: string;
  relevantParts: TodayRelevantPartContext[];
  personalTriggerProfiles: PartPersonalTriggerProfile[];
  anchorFacts: PartExternalAnchorFact[];
  dateRiskResults: PartDateRiskResult[];
  sensitivities: PartExternalEventSensitivity[];
  maxQueries?: number;
}

export interface ExternalRealityQueryPlan {
  query_plan_version: string;
  date_prague: string;
  queries: ExternalRealityQuery[];
  ignored_example_terms_global: string[];
  legacy_example_terms_blocked: string[];
  controlled_skips: string[];
}

const FORBIDDEN_DEFAULT_QUERIES = new Set(
  [
    "Arthur Labinjo-Hughes aktuální zpráva",
    "Timmy aktuální zpráva",
    "Arthur aktuální zpráva",
    "Tundrupek aktuální zpráva",
    "Gustík aktuální zpráva",
  ].map((s) => normalize(s)),
);

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function isPartNameQuery(q: string, partName: string): boolean {
  const n = normalize(q);
  const p = normalize(partName);
  return n === p || n.startsWith(p + " ") || n === `${p} aktuální zpráva`;
}

export function buildExternalRealityQueryPlan(
  input: QueryPlanInput,
): ExternalRealityQueryPlan {
  const max = Math.max(1, Math.min(20, input.maxQueries ?? 12));
  const queries: ExternalRealityQuery[] = [];
  const ignoredGlobal: string[] = [];
  const legacyBlocked: string[] = [];
  const controlledSkips: string[] = [];
  const dedupe = new Set<string>();

  function tryPush(q: ExternalRealityQuery): boolean {
    if (queries.length >= max) return false;
    const partLower = q.part_name.toLowerCase();
    if (isPartNameQuery(q.query, q.part_name)) {
      controlledSkips.push(`refused_part_name_query:${partLower}`);
      return false;
    }
    if (FORBIDDEN_DEFAULT_QUERIES.has(normalize(q.query)) && q.query_policy !== "explicit_query_terms") {
      legacyBlocked.push(q.query);
      return false;
    }
    const key = `${partLower}|${q.trigger_category}|${normalize(q.query)}`;
    if (dedupe.has(key)) return false;
    dedupe.add(key);
    queries.push(q);
    return true;
  }

  // 1) Personal triggers from cards/profiles (review-flagged query_terms only)
  for (const profile of input.personalTriggerProfiles) {
    for (const t of profile.personal_triggers) {
      const ignoredHere = (t.example_terms ?? []).filter((e) => e && e.trim());
      if (ignoredHere.length) ignoredGlobal.push(...ignoredHere);
      if (!t.query_terms || t.query_terms.length === 0) {
        // Fall back to category template — handled by sweep
        continue;
      }
      for (const term of t.query_terms) {
        const q: ExternalRealityQuery = {
          query: term,
          part_name: profile.part_name,
          trigger_source: "card_personal_trigger",
          personal_trigger_label: t.trigger_label,
          trigger_category: t.trigger_category,
          query_policy: "personal_trigger_terms",
          query_source: "personal_trigger_query_terms",
          used_terms: [term],
          ignored_example_terms: ignoredHere,
          negative_terms: t.negative_terms ?? [],
          reason: `personal trigger ${t.trigger_label} u ${profile.part_name}`,
        };
        tryPush(q);
      }
    }
  }

  // 2) Biographical anchors — only if source-backed (have known_dates with source_ref)
  for (const profile of input.personalTriggerProfiles) {
    for (const a of profile.biographical_anchors) {
      const ignored = (a.example_terms ?? []).filter(Boolean);
      if (ignored.length) ignoredGlobal.push(...ignored);
      const isSourceBacked = a.known_dates.some(
        (d) => d.source_ref && /^https?:\/\//i.test(d.source_ref),
      );
      if (!isSourceBacked) continue;
      for (const term of a.query_terms ?? []) {
        tryPush({
          query: term,
          part_name: profile.part_name,
          trigger_source: "biographical_anchor",
          anchor_label: a.anchor_label,
          trigger_category: a.anchor_type,
          query_policy: "biographical_anchor_terms",
          query_source: "biographical_anchor_query_terms",
          used_terms: [term],
          ignored_example_terms: ignored,
          negative_terms: [],
          reason: `source-backed anchor ${a.anchor_label}`,
        });
      }
    }
  }

  // 3) Date risk — only if source-backed
  for (const r of input.dateRiskResults) {
    if (r.risk_level === "none") continue;
    const sourceBacked = r.matched_dates.some(
      (m) => m.source_ref && /^https?:\/\//i.test(m.source_ref),
    );
    if (!sourceBacked) continue;
    const profile = input.personalTriggerProfiles.find((p) => p.part_name === r.part_name);
    const cats = profile
      ? Array.from(new Set(profile.personal_triggers.map((t) => t.trigger_category)))
      : [];
    for (const cat of cats) {
      tryPush({
        query: `${categoryToCzech(cat)} aktuální zprávy`,
        part_name: r.part_name,
        trigger_source: "date_risk",
        trigger_category: cat,
        query_policy: "date_risk_terms",
        query_source: "date_risk_category",
        used_terms: [cat],
        ignored_example_terms: [],
        negative_terms: [],
        reason: `citlivostní okno (${r.risk_level}) ±${Math.abs(r.matched_dates[0]?.days_from_today ?? 0)} dní`,
      });
    }
  }

  // 4) Reviewed sensitivity query_terms (explicit_query_terms policy)
  for (const s of input.sensitivities) {
    const reviewed = s.query_policy === "explicit_query_terms"
      && s.last_reviewed_at
      && s.example_terms_query_enabled === true;
    if (!reviewed) {
      // Record example_terms ignored
      for (const ex of s.example_terms ?? []) ignoredGlobal.push(ex);
      continue;
    }
    for (const term of s.query_terms ?? []) {
      tryPush({
        query: term,
        part_name: s.part_name,
        trigger_source: "sensitivity_profile",
        sensitivity_id: s.id,
        sensitivity_type: s.sensitivity_types?.[0],
        trigger_category: s.sensitivity_types?.[0] ?? "other",
        query_policy: "explicit_query_terms",
        query_source: "explicit_query_terms",
        used_terms: [term],
        ignored_example_terms: [],
        negative_terms: s.negative_terms ?? [],
        reason: `reviewed sensitivity ${s.id}`,
      });
    }
  }

  // 5) General category sweep (only when at least one relevant part has matching category)
  const sweep = buildGeneralExternalTriggerSweepQueries({
    datePrague: input.datePrague,
    relevantParts: input.relevantParts,
    profiles: input.personalTriggerProfiles,
    anchorFacts: input.anchorFacts,
    maxQueries: max - queries.length,
  });
  for (const sw of sweep) {
    for (const partName of sw.matched_part_names) {
      tryPush({
        query: sw.query,
        part_name: partName,
        trigger_source: "general_trigger_sweep",
        trigger_category: sw.trigger_category,
        query_policy: "category_template",
        query_source: "category_template",
        used_terms: [sw.trigger_category],
        ignored_example_terms: [],
        negative_terms: [],
        reason: `general sweep — kategorie ${sw.trigger_category} matchuje ${partName}`,
      });
    }
  }

  return {
    query_plan_version: QUERY_PLAN_VERSION,
    date_prague: input.datePrague,
    queries,
    ignored_example_terms_global: Array.from(new Set(ignoredGlobal)),
    legacy_example_terms_blocked: Array.from(new Set(legacyBlocked)),
    controlled_skips: controlledSkips,
  };
}

function categoryToCzech(cat: string): string {
  const map: Record<string, string> = {
    animal_suffering: "týrání zvířat",
    helpless_animal: "uvízlé zvíře záchrana",
    animal_rescue: "záchrana zvířete",
    animal_abuse: "týrání zvířat",
    child_abuse: "násilí na dětech",
    child_protection_failure: "selhání ochrany dítěte",
    public_trial: "soud",
    disaster: "katastrofa",
    war: "válka",
    death: "úmrtí",
    anniversary: "výročí",
    injustice: "nespravedlnost",
    identity_link: "identita",
  };
  return map[cat] ?? cat;
}
