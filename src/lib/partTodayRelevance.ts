/**
 * P33.6 — Mirror of supabase/functions/_shared/partTodayRelevance.ts (1:1).
 * Front-end copy so React/Vitest tests don't pull Deno files.
 */

export interface PartTodayRelevanceInput {
  proposed_part: string | null | undefined;
  briefing_date: string;
  source_cycle_id: string | null | undefined;
  is_hypothesis_only: boolean;
  evidence_strength: "low" | "medium" | "high" | string | null | undefined;
  recent_thread_part_names: string[];
  todays_session_part_names: string[];
  live_progress_part_names: string[];
  explicit_therapist_mentions: string[];
  registry_sleeping?: boolean;
}

export interface PartTodayRelevanceResult {
  ok_for_primary_suggestion: boolean;
  reason: string;
  display_name: string | null;
  confidence: "high" | "medium" | "low";
}

const TECHNICAL_PREFIX_RE = /^00[0-9]_/;
const CANONICAL_PART_NAMES: Record<string, string> = {
  arthur: "Arthur",
  tundrupek: "Tundrupek",
  gustik: "Gustík",
  gustík: "Gustík",
};

export function normalizePartDisplayName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(TECHNICAL_PREFIX_RE, "").trim();
  if (!s) return null;
  return s.charAt(0).toLocaleUpperCase("cs") + s.slice(1);
}

export function canonicalizePartDisplayName(raw: string | null | undefined): string | null {
  const display = normalizePartDisplayName(raw);
  if (!display) return null;
  const key = display.toLocaleLowerCase("cs");
  if (key === "hana" || key === "hanka" || key === "hanička" || key === "karel" || key === "káťa" || key === "kata") return null;
  return CANONICAL_PART_NAMES[key] ?? display;
}

function eqCi(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase("cs") === b.trim().toLocaleLowerCase("cs");
}

function nameInList(needle: string, list: string[]): boolean {
  if (!needle) return false;
  for (const x of list) {
    if (!x) continue;
    if (eqCi(needle, x)) return true;
    const a = normalizePartDisplayName(needle);
    const b = normalizePartDisplayName(x);
    if (a && b && eqCi(a, b)) return true;
  }
  return false;
}

export function isPartTodayRelevantForPrimarySuggestion(
  input: PartTodayRelevanceInput,
): PartTodayRelevanceResult {
  const raw = (input.proposed_part || "").trim();
  const display = normalizePartDisplayName(raw);
  if (!raw || !display) {
    return { ok_for_primary_suggestion: false, reason: "no_proposed_part", display_name: null, confidence: "low" };
  }
  const evidence = String(input.evidence_strength || "").toLowerCase();
  const inSession = nameInList(raw, input.todays_session_part_names);
  const inThreads = nameInList(raw, input.recent_thread_part_names);
  const inLive = nameInList(raw, input.live_progress_part_names);
  const inMentions = nameInList(raw, input.explicit_therapist_mentions);
  const hasCurrentEvidence = inSession || inThreads || inLive || inMentions;

  if (input.is_hypothesis_only && evidence === "low" && !hasCurrentEvidence) {
    return { ok_for_primary_suggestion: false, reason: "low_support_hypothesis_without_current_evidence", display_name: display, confidence: "low" };
  }
  if (input.registry_sleeping === true && !hasCurrentEvidence) {
    return { ok_for_primary_suggestion: false, reason: "dormant_part_without_current_evidence", display_name: display, confidence: "low" };
  }
  let confidence: "high" | "medium" | "low" = "medium";
  if (evidence === "high" || inSession || inLive) confidence = "high";
  else if (evidence === "low" && !hasCurrentEvidence) confidence = "low";
  return {
    ok_for_primary_suggestion: true,
    reason: hasCurrentEvidence ? "current_evidence_present" : "evidence_strength_sufficient",
    display_name: display,
    confidence,
  };
}
