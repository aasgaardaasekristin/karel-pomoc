/**
 * P33.8.C — Daily part workability matrix.
 *
 * Builds the upstream decision: which parts are realistically workable today,
 * which are watch-only, dormant, or excluded — and whether a primary part can
 * be selected before first contact.
 *
 * The renderer MUST NOT decide workability. It must consume this matrix.
 */

import type { CentrumPartMatrix, CentrumPartRow } from "./centrumPartMatrix.ts";
import { canonicalizePartDisplayName, normalizePartDisplayName } from "./partTodayRelevance.ts";

// deno-lint-ignore no-explicit-any
type AnyObj = Record<string, any>;

export type Workability =
  | "primary_candidate"
  | "possible_after_first_contact"
  | "watch_only"
  | "dormant_not_for_today"
  | "excluded";

export interface MatrixEvidenceFlags {
  registry_active: boolean;
  in_recent_thread: boolean;
  in_today_session: boolean;
  in_live_progress: boolean;
  in_explicit_mention: boolean;
  in_today_part_proposal: boolean;
  has_external_reality_signal: boolean;
  has_fresh_team_proposal: boolean;
  registry_dormant_or_sleeping: boolean;
  excluded_non_part: boolean;
}

export interface MatrixFreshEvidenceSource {
  source: "recent_thread" | "today_session_approved" | "live_progress" | "explicit_therapist_mention" | "hana_personal_review";
  label: string;
}

export interface MatrixPart {
  id: string;
  canonical_name: string;
  display_name: string;
  registry_status: "active" | "dormant" | "sleeping" | "unknown";
  status_source: "drive_index" | "db_mirror" | "db_mirror_stale" | "unknown";
  status_last_verified_at: string | null;
  fresh_evidence_sources: MatrixFreshEvidenceSource[];
  dedupe_key: string;
  display_allowed_today: boolean;
  primary_allowed: boolean;
  workability: Workability;
  reason: string;
  evidence: MatrixEvidenceFlags;
  recommended_route: "session" | "playroom" | "first_contact" | "watch_only" | "none";
}

export interface PartWorkabilityMatrix {
  version: "p33.8";
  date_prague: string;
  source: "drive_primary" | "profile_fallback" | "missing";
  selected_primary_part: string | null;
  overall_decision:
    | "primary_part_selected"
    | "no_primary_part_before_first_contact"
    | "blocked_centrum_missing";
  parts: MatrixPart[];
  warnings: string[];
}

const NON_PART = new Set([
  "hana", "hanka", "hanicka", "karel", "kata", "katia", "katka",
]);

function norm(s: string | null | undefined): string {
  return String(s ?? "").trim().toLocaleLowerCase("cs").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function listHas(list: Array<string | null | undefined>, name: string): boolean {
  const target = norm(name);
  if (!target) return false;
  for (const x of list) {
    const n = norm(normalizePartDisplayName(x ?? "") ?? x ?? "");
    if (n && n === target) return true;
  }
  return false;
}

function isFreshTeamProposal(row: AnyObj | null | undefined, datePrague: string): boolean {
  if (!row) return false;
  const status = String(row?.status ?? "").toLowerCase();
  if (status === "approved" || status === "signed_off" || status === "active") {
    const upd = row?.updated_at ?? row?.created_at;
    if (!upd) return false;
    try {
      const ageHours = (Date.now() - new Date(upd).getTime()) / 3_600_000;
      return ageHours <= 36; // fresh = ≤36h
    } catch { return false; }
  }
  return false;
}

export interface BuildMatrixInput {
  datePrague: string;
  centrum: CentrumPartMatrix;
  todayPartProposalPart?: string | null;
  todaysSessionPartNames?: string[];
  recentThreadPartNames?: string[];
  livePartNames?: string[];
  explicitTherapistMentions?: string[];
  externalRealityParts?: Array<{ part_name: string; activity_status?: string }>;
  freshTeamDeliberations?: AnyObj[];
  hanaPersonalReviewPartNames?: string[];
}

const RECENT_ACTIVITY_WINDOW_DAYS = 14;

function canonicalKey(raw: string | null | undefined): string {
  return norm(canonicalizePartDisplayName(raw ?? "") ?? raw ?? "").replace(/[^a-z0-9]/g, "");
}

function ageDays(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 86_400_000;
}

function statusVerifiedAt(row: CentrumPartRow): string | null {
  return row.source === "drive_index"
    ? (row.index_confirmed_at ?? row.updated_at ?? row.last_seen_at ?? null)
    : (row.index_confirmed_at ?? row.last_seen_at ?? row.updated_at ?? null);
}

export function buildDailyPartWorkabilityMatrix(input: BuildMatrixInput): PartWorkabilityMatrix {
  const warnings: string[] = [...(input.centrum?.warnings ?? [])];
  const out: PartWorkabilityMatrix = {
    version: "p33.8",
    date_prague: input.datePrague,
    source: input.centrum?.source ?? "missing",
    selected_primary_part: null,
    overall_decision: "no_primary_part_before_first_contact",
    parts: [],
    warnings,
  };

  if (!input.centrum || input.centrum.read_status === "missing" || input.centrum.rows.length === 0) {
    out.overall_decision = "blocked_centrum_missing";
    return out;
  }

  const externalSet = new Set(
    (input.externalRealityParts ?? []).map((e) => norm(e?.part_name)).filter(Boolean),
  );
  const freshTeamProposalParts = new Set<string>();
  for (const d of input.freshTeamDeliberations ?? []) {
    if (!isFreshTeamProposal(d, input.datePrague)) continue;
    const sp = d?.session_params ?? {};
    const candidate = sp?.selected_part ?? sp?.part_name ?? d?.part_name ?? null;
    if (candidate) freshTeamProposalParts.add(norm(canonicalizePartDisplayName(candidate)));
  }

  const rowsByKey = new Map<string, CentrumPartRow>();
  for (const row of input.centrum.rows) {
    const key = canonicalKey(row.display_name || row.canonical_name);
    if (!key) continue;
    const prev = rowsByKey.get(key);
    if (!prev) {
      rowsByKey.set(key, row);
      continue;
    }
    const rank = (r: CentrumPartRow) => (r.source === "drive_index" ? 3 : 0) + (r.registry_status === "active" ? 2 : r.registry_status === "unknown" ? 1 : 0) + (ageDays(statusVerifiedAt(r)) != null ? 1 : 0);
    if (rank(row) > rank(prev)) rowsByKey.set(key, row);
  }

  for (const row of rowsByKey.values()) {
    const dedupeKey = canonicalKey(row.display_name || row.canonical_name);
    const verifiedAt = statusVerifiedAt(row);
    const staleDbStatus = row.source === "db_mirror" && (ageDays(verifiedAt) == null || (ageDays(verifiedAt) ?? 999) > RECENT_ACTIVITY_WINDOW_DAYS);
    const effectiveRegistryStatus = staleDbStatus && row.registry_status === "active" ? "unknown" : row.registry_status;
    const statusSource = row.source === "drive_index" ? "drive_index" : staleDbStatus ? "db_mirror_stale" : "db_mirror";
    if (NON_PART.has(norm(row.canonical_name)) || NON_PART.has(norm(row.display_name))) {
      out.parts.push({
        id: row.id,
        canonical_name: row.canonical_name,
        display_name: row.display_name,
        registry_status: effectiveRegistryStatus,
        status_source: statusSource,
        status_last_verified_at: verifiedAt,
        fresh_evidence_sources: [],
        dedupe_key: dedupeKey,
        display_allowed_today: false,
        primary_allowed: false,
        workability: "excluded",
        reason: "non_part_excluded",
        recommended_route: "none",
        evidence: zeroEvidence({ excluded_non_part: true }),
      });
      continue;
    }

    const ev: MatrixEvidenceFlags = {
      registry_active: effectiveRegistryStatus === "active",
      in_recent_thread: listHas(input.recentThreadPartNames ?? [], row.display_name)
        || listHas(input.recentThreadPartNames ?? [], row.canonical_name),
      in_today_session: listHas(input.todaysSessionPartNames ?? [], row.display_name)
        || listHas(input.todaysSessionPartNames ?? [], row.canonical_name),
      in_live_progress: listHas(input.livePartNames ?? [], row.display_name)
        || listHas(input.livePartNames ?? [], row.canonical_name),
      in_explicit_mention: listHas(input.explicitTherapistMentions ?? [], row.display_name)
        || listHas(input.explicitTherapistMentions ?? [], row.canonical_name),
      in_today_part_proposal: input.todayPartProposalPart
        ? norm(canonicalizePartDisplayName(input.todayPartProposalPart)) === norm(row.display_name)
        : false,
      has_external_reality_signal: externalSet.has(norm(row.display_name))
        || externalSet.has(norm(row.canonical_name)),
      has_fresh_team_proposal: freshTeamProposalParts.has(norm(row.display_name))
        || freshTeamProposalParts.has(norm(row.canonical_name)),
      registry_dormant_or_sleeping: effectiveRegistryStatus === "dormant" || effectiveRegistryStatus === "sleeping",
      excluded_non_part: false,
    };

    const freshEvidenceSources: MatrixFreshEvidenceSource[] = [];
    if (ev.in_recent_thread) freshEvidenceSources.push({ source: "recent_thread", label: "nedávné pracovní vlákno" });
    if (ev.in_today_session) freshEvidenceSources.push({ source: "today_session_approved", label: "dnes schválený plán" });
    if (ev.in_live_progress) freshEvidenceSources.push({ source: "live_progress", label: "živý kontakt" });
    if (ev.in_explicit_mention) freshEvidenceSources.push({ source: "explicit_therapist_mention", label: "výslovné dnešní potvrzení terapeutky" });
    const hanaReview = listHas(input.hanaPersonalReviewPartNames ?? [], row.display_name) || listHas(input.hanaPersonalReviewPartNames ?? [], row.canonical_name);
    if (hanaReview) freshEvidenceSources.push({ source: "hana_personal_review", label: "bezpečný signál z osobního vlákna Haničky" });

    const hasFreshEvidence = freshEvidenceSources.length > 0;
    const hasPrimaryEvidence = ev.in_live_progress || ev.in_explicit_mention || hanaReview;

    let workability: Workability;
    let reason: string;
    let route: MatrixPart["recommended_route"] = "none";

    if (ev.registry_dormant_or_sleeping) {
      if (hasFreshEvidence) {
        workability = "possible_after_first_contact";
        reason = "dormant_with_fresh_evidence";
        route = "first_contact";
      } else {
        workability = "dormant_not_for_today";
        reason = "dormant_no_fresh_evidence";
        route = "none";
      }
    } else if (ev.registry_active) {
      // Hard rule: registry-active or pending generated plan alone ≠ primary.
      if (hasFreshEvidence && hasPrimaryEvidence) {
        workability = "primary_candidate";
        reason = "active_with_strong_today_evidence";
        route = ev.in_live_progress || ev.in_today_session ? "session" : "first_contact";
      } else if (ev.has_fresh_team_proposal && hasFreshEvidence) {
        workability = "primary_candidate";
        reason = "active_with_fresh_team_proposal_and_evidence";
        route = "session";
      } else if (hasFreshEvidence) {
        workability = "possible_after_first_contact";
        reason = "active_with_recent_thread_only";
        route = "first_contact";
      } else if (ev.has_external_reality_signal) {
        workability = "watch_only";
        reason = "active_external_reality_alone";
        route = "watch_only";
      } else {
        workability = "watch_only";
        reason = "active_without_today_evidence";
        route = "watch_only";
      }
    } else {
      // unknown registry status → treat conservatively
      if (hasFreshEvidence) {
        workability = "possible_after_first_contact";
        reason = "unknown_status_with_fresh_evidence";
        route = "first_contact";
      } else if (ev.has_external_reality_signal) {
        workability = "watch_only";
        reason = "unknown_status_external_only";
        route = "watch_only";
      } else {
        workability = "watch_only";
        reason = "unknown_status_no_evidence";
        route = "watch_only";
      }
    }

    const primaryAllowed = workability === "primary_candidate" && hasPrimaryEvidence;
    const displayAllowedToday = primaryAllowed || workability === "possible_after_first_contact" || (workability === "watch_only" && (ev.has_external_reality_signal || hasFreshEvidence));

    out.parts.push({
      id: row.id,
      canonical_name: row.canonical_name,
      display_name: row.display_name,
      registry_status: effectiveRegistryStatus,
      status_source: statusSource,
      status_last_verified_at: verifiedAt,
      fresh_evidence_sources: freshEvidenceSources,
      dedupe_key: dedupeKey,
      display_allowed_today: displayAllowedToday,
      primary_allowed: primaryAllowed,
      workability,
      reason,
      evidence: ev,
      recommended_route: route,
    });
  }

  // Select primary: first primary_candidate (deterministic by CENTRUM order).
  const primary = out.parts.find((p) => p.workability === "primary_candidate");
  if (primary) {
    out.selected_primary_part = primary.display_name;
    out.overall_decision = "primary_part_selected";
  } else {
    out.selected_primary_part = null;
    out.overall_decision = "no_primary_part_before_first_contact";
  }

  return out;
}

function zeroEvidence(overrides: Partial<MatrixEvidenceFlags> = {}): MatrixEvidenceFlags {
  return {
    registry_active: false,
    in_recent_thread: false,
    in_today_session: false,
    in_live_progress: false,
    in_explicit_mention: false,
    in_today_part_proposal: false,
    has_external_reality_signal: false,
    has_fresh_team_proposal: false,
    registry_dormant_or_sleeping: false,
    excluded_non_part: false,
    ...overrides,
  };
}

/**
 * Derive a today_part_relevance_decision shape from the matrix so that
 * existing consumers (renderer, completeness, AI polish) keep working.
 */
export function deriveRelevanceDecisionFromMatrix(matrix: PartWorkabilityMatrix): {
  ok_for_primary_suggestion: boolean;
  reason: string;
  display_name: string | null;
  confidence: "high" | "medium" | "low";
  derived_from: "p33.8_matrix";
  matrix_overall_decision: PartWorkabilityMatrix["overall_decision"];
  checked_at: string;
} {
  const checked_at = new Date().toISOString();
  if (matrix.overall_decision === "primary_part_selected" && matrix.selected_primary_part) {
    const part = matrix.parts.find((p) => p.display_name === matrix.selected_primary_part);
    return {
      ok_for_primary_suggestion: true,
      reason: part?.reason ?? "primary_selected",
      display_name: matrix.selected_primary_part,
      confidence: part?.evidence?.in_live_progress || part?.evidence?.in_today_session ? "high" : "medium",
      derived_from: "p33.8_matrix",
      matrix_overall_decision: matrix.overall_decision,
      checked_at,
    };
  }
  return {
    ok_for_primary_suggestion: false,
    reason: matrix.overall_decision === "blocked_centrum_missing"
      ? "blocked_centrum_missing"
      : "no_primary_part_before_first_contact",
    display_name: null,
    confidence: "low",
    derived_from: "p33.8_matrix",
    matrix_overall_decision: matrix.overall_decision,
    checked_at,
  };
}
