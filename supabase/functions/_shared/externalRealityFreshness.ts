/**
 * P30.5B — recency-tiered freshness gate for source-backed external reality events.
 *
 * Replaces the binary P30.5 model. The visible app and briefing must distinguish:
 *   1. fresh_today_event                     — source_published_at is fresh
 *   2. checked_today_unknown_publication_date — source_url checked today, no pub date
 *   3. historical_sensitive_context          — source_url with old publication date
 *   4. not_displayable                       — no source_url / wrong anchor
 *
 * Karel may NEVER claim a tier-2/3 event "happened today"; but tier-2 sources
 * MUST stay visible because Karel really did check the internet today.
 */

export const EXTERNAL_REALITY_PRESENTATION_QUERY_PLAN_VERSION =
  "p30.3_personal_anchor_general_trigger_weekly_matrix";

export type ExternalRealityDisplayTier =
  | "fresh_today_event"
  | "checked_today_unknown_publication_date"
  | "historical_sensitive_context"
  | "not_displayable";

export type FreshnessStatus =
  | "fresh_today"
  | "checked_today_unknown_date"
  | "historical_only"
  | "stale"
  | "unknown_recency"
  | "not_source_backed"
  | "not_today_matrix_linked";

export interface ExternalRealityFreshnessLanguagePolicy {
  may_say_today_event: boolean;
  may_say_checked_today: boolean;
  must_say_publication_date_unknown: boolean;
  must_say_historical_only: boolean;
}

export interface ExternalRealityFreshnessResult {
  ok_for_today_display: boolean;
  ok_for_visible_checked_source: boolean;
  display_tier: ExternalRealityDisplayTier;
  status: FreshnessStatus;
  reason: string;
  language_policy: ExternalRealityFreshnessLanguagePolicy;
  checked_at: string;
}

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

const POLICY_FRESH: ExternalRealityFreshnessLanguagePolicy = {
  may_say_today_event: true,
  may_say_checked_today: true,
  must_say_publication_date_unknown: false,
  must_say_historical_only: false,
};
const POLICY_CHECKED_UNKNOWN: ExternalRealityFreshnessLanguagePolicy = {
  may_say_today_event: false,
  may_say_checked_today: true,
  must_say_publication_date_unknown: true,
  must_say_historical_only: false,
};
const POLICY_HISTORICAL: ExternalRealityFreshnessLanguagePolicy = {
  may_say_today_event: false,
  may_say_checked_today: false,
  must_say_publication_date_unknown: false,
  must_say_historical_only: true,
};
const POLICY_HIDDEN: ExternalRealityFreshnessLanguagePolicy = {
  may_say_today_event: false,
  may_say_checked_today: false,
  must_say_publication_date_unknown: false,
  must_say_historical_only: false,
};

function build(
  tier: ExternalRealityDisplayTier,
  status: FreshnessStatus,
  reason: string,
  policy: ExternalRealityFreshnessLanguagePolicy,
): ExternalRealityFreshnessResult {
  return {
    ok_for_today_display: tier === "fresh_today_event",
    ok_for_visible_checked_source:
      tier === "fresh_today_event" ||
      tier === "checked_today_unknown_publication_date" ||
      tier === "historical_sensitive_context",
    display_tier: tier,
    status,
    reason,
    language_policy: policy,
    checked_at: new Date().toISOString(),
  };
}

export function evaluateExternalRealityFreshness(
  input: ExternalRealityFreshnessInput,
): ExternalRealityFreshnessResult {
  const event = input.event ?? {};
  const raw = event.raw_payload ?? {};
  const sourceUrl = event.source_url ?? raw.source_url ?? null;
  if (!sourceUrl || !/^https?:\/\//i.test(String(sourceUrl))) {
    return build("not_displayable", "not_source_backed", "missing_real_source_url", POLICY_HIDDEN);
  }

  const today = input.datePrague;
  const published = event.source_published_at ?? raw.source_published_at ?? null;
  const publishedDay = pragueDate(published);

  // Anchor (today's matrix/watch/brief) — required for tier1/tier2.
  const qpv = raw.query_plan_version ?? input.watchRun?.query_plan_version ??
    input.activePartBrief?.evidence_summary?.query_plan_version ?? null;
  const briefToday = pragueDate(input.activePartBrief?.brief_date ?? null) === today;
  const matrixOk = !!input.matrixRow?.id && pragueDate(input.matrixRow?.date_prague ?? null) === today;
  const matrixRefOk = !!input.activePartBrief?.evidence_summary?.weekly_matrix_ref;
  const watchToday = pragueDate(input.watchRun?.ran_at ?? null) === today;
  const qpvOk = qpv === EXTERNAL_REALITY_PRESENTATION_QUERY_PLAN_VERSION;
  const hasAnchor = qpvOk && briefToday && matrixOk && matrixRefOk && watchToday;

  // Tier 1 — fresh source published today / within 48h
  let withinFresh = false;
  if (publishedDay === today) {
    withinFresh = true;
  } else if (published) {
    const pubMs = parsedMs(published);
    const anchorMs = parsedMs(today, true);
    if (pubMs != null && anchorMs != null) {
      const ageMs = anchorMs - pubMs;
      if (ageMs >= 0 && ageMs <= 48 * 60 * 60 * 1000) withinFresh = true;
    }
  }

  if (hasAnchor && withinFresh) {
    return build(
      "fresh_today_event",
      "fresh_today",
      publishedDay === today ? "source_published_today_prague" : "source_published_within_48h",
      POLICY_FRESH,
    );
  }

  // Tier 2 — checked today, unknown publication date
  if (hasAnchor && !published) {
    const fetchedToday = pragueDate(event.fetched_at ?? raw.fetched_at ?? null) === today || watchToday;
    if (fetchedToday) {
      return build(
        "checked_today_unknown_publication_date",
        "checked_today_unknown_date",
        "source_checked_today_publication_date_missing",
        POLICY_CHECKED_UNKNOWN,
      );
    }
    return build("not_displayable", "unknown_recency", "no_today_fetch_or_watch_run", POLICY_HIDDEN);
  }

  // Tier 3 — historical (old published_at). Anchor not required.
  if (published && !withinFresh) {
    return build(
      "historical_sensitive_context",
      "historical_only",
      "source_published_older_than_48h",
      POLICY_HISTORICAL,
    );
  }

  // Anchor missing and no published date → not displayable.
  if (!qpvOk) {
    return build("not_displayable", "not_today_matrix_linked", "wrong_or_missing_query_plan_version", POLICY_HIDDEN);
  }
  if (!briefToday) {
    return build("not_displayable", "not_today_matrix_linked", "active_part_brief_not_today", POLICY_HIDDEN);
  }
  if (!matrixRefOk) {
    return build("not_displayable", "not_today_matrix_linked", "missing_weekly_matrix_ref", POLICY_HIDDEN);
  }
  if (!matrixOk) {
    return build("not_displayable", "not_today_matrix_linked", "matrix_row_not_today", POLICY_HIDDEN);
  }
  if (!watchToday) {
    return build("not_displayable", "not_today_matrix_linked", "watch_run_not_today", POLICY_HIDDEN);
  }
  return build("not_displayable", "unknown_recency", "no_published_date_no_today_fetch", POLICY_HIDDEN);
}
