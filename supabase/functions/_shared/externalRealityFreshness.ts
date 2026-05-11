/**
 * P30.5 — strict freshness gate for source-backed external reality events.
 *
 * A refreshed `last_seen_at` is never enough to present an old/unknown source
 * as today's possible external burden. The visible app and briefing may use an
 * event as "today" only when it is source-backed, linked to today's watch run
 * and weekly matrix, and has real publication recency proof.
 */

export const EXTERNAL_REALITY_PRESENTATION_QUERY_PLAN_VERSION =
  "p30.3_personal_anchor_general_trigger_weekly_matrix";

export interface ExternalRealityFreshnessInput {
  datePrague: string;
  event?: {
    source_url?: string | null;
    source_published_at?: string | null;
    fetched_at?: string | null;
    last_seen_at?: string | null;
    created_at?: string | null;
    raw_payload?: any;
  };
  watchRun?: {
    ran_at?: string | null;
    query_plan_version?: string | null;
    provider_status?: string | null;
  };
  matrixRow?: {
    date_prague?: string | null;
    id?: string | null;
  };
  activePartBrief?: {
    brief_date?: string | null;
    generated_at?: string | null;
    evidence_summary?: any;
  };
}

export type FreshnessStatus =
  | "fresh_today"
  | "historical_only"
  | "stale"
  | "unknown_recency"
  | "not_source_backed"
  | "not_today_matrix_linked";

function pragueDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(d);
}

function parsedMs(value: string | null | undefined, endOfDay = false): number | null {
  if (!value) return null;
  const s = String(value).trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s)
    ? new Date(`${s}T${endOfDay ? "23:59:59" : "00:00:00"}Z`)
    : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export function evaluateExternalRealityFreshness(input: ExternalRealityFreshnessInput): {
  ok_for_today_display: boolean;
  status: FreshnessStatus;
  reason: string;
  checked_at: string;
} {
  const checked_at = new Date().toISOString();
  const event = input.event ?? {};
  const raw = event.raw_payload ?? {};
  const sourceUrl = event.source_url ?? raw.source_url ?? null;
  if (!sourceUrl || !/^https?:\/\//i.test(String(sourceUrl))) {
    return { ok_for_today_display: false, status: "not_source_backed", reason: "missing_real_source_url", checked_at };
  }

  const qpv = raw.query_plan_version ?? input.watchRun?.query_plan_version ??
    input.activePartBrief?.evidence_summary?.query_plan_version ?? null;
  if (qpv !== EXTERNAL_REALITY_PRESENTATION_QUERY_PLAN_VERSION) {
    return { ok_for_today_display: false, status: "not_today_matrix_linked", reason: "wrong_or_missing_query_plan_version", checked_at };
  }

  if (pragueDate(input.activePartBrief?.brief_date ?? null) !== input.datePrague) {
    return { ok_for_today_display: false, status: "not_today_matrix_linked", reason: "active_part_brief_not_today", checked_at };
  }
  if (!input.activePartBrief?.evidence_summary?.weekly_matrix_ref) {
    return { ok_for_today_display: false, status: "not_today_matrix_linked", reason: "missing_weekly_matrix_ref", checked_at };
  }
  if (!input.matrixRow?.id || pragueDate(input.matrixRow.date_prague ?? null) !== input.datePrague) {
    return { ok_for_today_display: false, status: "not_today_matrix_linked", reason: "matrix_row_not_today", checked_at };
  }
  if (pragueDate(input.watchRun?.ran_at ?? null) !== input.datePrague) {
    return { ok_for_today_display: false, status: "not_today_matrix_linked", reason: "watch_run_not_today", checked_at };
  }

  const published = event.source_published_at ?? raw.source_published_at ?? null;
  if (!published) {
    return { ok_for_today_display: false, status: "unknown_recency", reason: "missing_source_published_at_fetched_at_or_last_seen_insufficient", checked_at };
  }

  const publishedDay = pragueDate(published);
  if (publishedDay === input.datePrague) {
    return { ok_for_today_display: true, status: "fresh_today", reason: "source_published_today_prague", checked_at };
  }

  const pubMs = parsedMs(published);
  const anchorMs = parsedMs(input.datePrague, true);
  if (pubMs != null && anchorMs != null) {
    const ageMs = anchorMs - pubMs;
    if (ageMs >= 0 && ageMs <= 48 * 60 * 60 * 1000) {
      return { ok_for_today_display: true, status: "fresh_today", reason: "source_published_within_48h", checked_at };
    }
  }

  return { ok_for_today_display: false, status: "stale", reason: "source_published_older_than_48h", checked_at };
}
