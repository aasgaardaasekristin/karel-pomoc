/**
 * P12 + P15: Briefing truth-status — deterministic, frontend-only.
 *
 * The Karlův přehled UI must NEVER display "Aktuální" when the briefing is:
 *  - older than today (stale_previous)
 *  - today but limited (limited_repair / cycle_missing)
 *  - today but generated manually (manual)
 *  - today but produced by a WATCHDOG fallback (P15 — even if not flagged limited)
 *  - missing entirely (missing_today)
 *
 * Single source of truth used by the UI badge + banner. Backed by unit tests
 * in src/test/p12BriefingTruthStatus.test.ts and p15WatchdogIsNotPrimary.test.ts.
 *
 * Rules (no exceptions):
 *  - level "fresh_full" iff
 *      briefing_date == today
 *      && is_stale === false
 *      && payload.limited !== true
 *      && generation_method category === "primary"  (P15: auto / primary_orchestrator)
 *      && (daily_cycle_status === "completed" || daily_cycle_status absent)
 *      && generation_duration_ms > 0
 *  - level "fresh_limited" iff today + limited / cycle missing / WATCHDOG-produced
 *  - level "stale_previous" iff briefing_date < today
 *  - level "missing_today" iff no briefing row at all
 *  - manual today rows → "Ruční přehled" label, never "Aktuální"
 *  - watchdog today rows → "Náhradní omezený přehled", never "Aktuální" (P15)
 */

import { categorizeBriefingMethod } from "./briefingMethodAuthority";

export type BriefingTruthLevel =
  | "fresh_full"
  | "fresh_limited"
  | "stale_previous"
  | "missing_today";

export interface BriefingTruthInputRow {
  briefing_date?: string | null;
  is_stale?: boolean | null;
  generation_method?: string | null;
  generation_duration_ms?: number | null;
  payload?: {
    limited?: boolean | null;
    limited_reason?: string | null;
    daily_cycle_status?: string | null;
    [k: string]: unknown;
  } | null;
}

export interface BriefingTruthStatus {
  level: BriefingTruthLevel;
  badgeLabel: string;
  bannerText: string | null;
  canShowCurrent: boolean;
  /** True when the technical badge "Aktuální (SLA záplata)" / "(auto)" / "(manuální)" is forbidden. */
  technicalLabelForbidden: true;
  detail: {
    isToday: boolean;
    isStale: boolean;
    isLimited: boolean;
    isManual: boolean;
    dailyCycleStatus: string | null;
    daysSince: number;
  };
}

/** Pluralize "den" / "dny" / "dní" in Czech. */
export function pluralizeDays(n: number): string {
  const abs = Math.abs(Math.round(n));
  if (abs === 1) return "1 den";
  if (abs >= 2 && abs <= 4) return `${abs} dny`;
  return `${abs} dní`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateOnlyMs(iso: string): number {
  // Treat YYYY-MM-DD as midnight UTC for diff math.
  return Date.UTC(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10)),
  );
}

function formatCzechDate(iso: string): string {
  if (!DATE_RE.test(iso)) return iso;
  try {
    const d = new Date(`${iso}T12:00:00Z`);
    return new Intl.DateTimeFormat("cs-CZ", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(d);
  } catch {
    return iso;
  }
}

function isManualMethod(method: string | null | undefined): boolean {
  // P15: missing/unknown method is treated as manual (cannot prove auto/primary).
  const cat = categorizeBriefingMethod(method);
  if (cat === "manual" || cat === "unknown") return true;
  return false;
}

function isWatchdogProducedMethod(method: string | null | undefined): boolean {
  return categorizeBriefingMethod(method) === "watchdog";
}

function dailyCycleCompleted(status: string | null | undefined): boolean {
  const s = String(status ?? "").toLowerCase().trim();
  if (!s) return true; // legacy rows (no field) → assume completed
  return s === "completed" || s === "ok" || s === "done";
}

/**
 * Compute truth-status for the panel.
 *
 * @param row              latest briefing row (or null/undefined when nothing exists for any date)
 * @param viewerTodayIso   YYYY-MM-DD in viewer's local (Prague) timezone
 */
export function getBriefingTruthStatus(
  row: BriefingTruthInputRow | null | undefined,
  viewerTodayIso: string,
): BriefingTruthStatus {
  // ---- missing entirely ----------------------------------------------------
  if (!row || !row.briefing_date) {
    return {
      level: "missing_today",
      badgeLabel: "Dnešní přehled chybí",
      bannerText:
        "Dnešní přehled zatím nevznikl. Až ho Karel připraví, objeví se tady.",
      canShowCurrent: false,
      technicalLabelForbidden: true,
      detail: {
        isToday: false,
        isStale: false,
        isLimited: false,
        isManual: false,
        dailyCycleStatus: null,
        daysSince: 0,
      },
    };
  }

  const briefingDate = String(row.briefing_date).slice(0, 10);
  const validDate = DATE_RE.test(briefingDate) && DATE_RE.test(viewerTodayIso);
  const daysSince = validDate
    ? Math.round(
        (dateOnlyMs(viewerTodayIso) - dateOnlyMs(briefingDate)) / 86_400_000,
      )
    : 0;
  const isToday = validDate && briefingDate === viewerTodayIso;
  const isStale = row.is_stale === true;
  const isLimited = row.payload?.limited === true;
  const isManual = isManualMethod(row.generation_method);
  const isWatchdog = isWatchdogProducedMethod(row.generation_method);
  const cycleStatus = row.payload?.daily_cycle_status
    ? String(row.payload.daily_cycle_status)
    : null;
  const cycleCompleted = dailyCycleCompleted(cycleStatus);
  const durationMs = Number(row.generation_duration_ms ?? 0);

  // ---- not today: stale_previous ------------------------------------------
  if (!isToday) {
    return {
      level: "stale_previous",
      badgeLabel: "Poslední dostupný přehled",
      bannerText: `Zobrazuji poslední dostupný přehled ze dne ${formatCzechDate(briefingDate)}. Dnešní plný přehled zatím nevznikl.`,
      canShowCurrent: false,
      technicalLabelForbidden: true,
      detail: {
        isToday: false,
        isStale,
        isLimited,
        isManual,
        dailyCycleStatus: cycleStatus,
        daysSince,
      },
    };
  }

  // From here: row IS for today.

  // ---- today + manual → Ruční přehled (never Aktuální) --------------------
  if (isManual && (isLimited || !cycleCompleted)) {
    return {
      level: "fresh_limited",
      badgeLabel: "Ruční přehled",
      bannerText:
        "Tento přehled vznikl ručně a nemusí obsahovat celý ranní cyklus.",
      canShowCurrent: false,
      technicalLabelForbidden: true,
      detail: {
        isToday: true,
        isStale,
        isLimited,
        isManual: true,
        dailyCycleStatus: cycleStatus,
        daysSince,
      },
    };
  }
  if (isManual) {
    // Manual today, full cycle, not limited → still "Ruční", not "Aktuální".
    return {
      level: "fresh_limited",
      badgeLabel: "Ruční přehled",
      bannerText:
        "Tento přehled vznikl ručně a nemusí obsahovat celý ranní cyklus.",
      canShowCurrent: false,
      technicalLabelForbidden: true,
      detail: {
        isToday: true,
        isStale,
        isLimited,
        isManual: true,
        dailyCycleStatus: cycleStatus,
        daysSince,
      },
    };
  }

  // ---- P15: today + WATCHDOG-produced → Náhradní omezený (architectural rule) ----
  // A watchdog is a fallback monitor — its output is never the primary morning
  // briefing, even if the watchdog forgot to set payload.limited=true.
  if (isWatchdog) {
    return {
      level: "fresh_limited",
      badgeLabel: "Náhradní omezený přehled",
      bannerText:
        "Tento přehled vznikl jen jako náhradní oprava. Plný ranní cyklus dnes nedoběhl, proto Karel pracuje jen s bezpečně dostupnými podklady.",
      canShowCurrent: false,
      technicalLabelForbidden: true,
      detail: {
        isToday: true,
        isStale,
        isLimited: true, // architecturally limited: produced by watchdog fallback
        isManual: false,
        dailyCycleStatus: cycleStatus,
        daysSince,
      },
    };
  }

  // ---- today + limited or cycle not completed → Náhradní omezený ---------
  if (isLimited || !cycleCompleted || isStale || durationMs <= 0) {
    return {
      level: "fresh_limited",
      badgeLabel: "Náhradní omezený přehled",
      bannerText:
        "Tento přehled je náhradní a omezený. Plný ranní cyklus dnes nedoběhl, proto Karel pracuje jen s bezpečně dostupnými podklady.",
      canShowCurrent: false,
      technicalLabelForbidden: true,
      detail: {
        isToday: true,
        isStale,
        isLimited,
        isManual: false,
        dailyCycleStatus: cycleStatus,
        daysSince,
      },
    };
  }

  // ---- everything green: full fresh ----------------------------------------
  return {
    level: "fresh_full",
    badgeLabel: "Aktuální",
    bannerText: "Tento přehled je pro dnešek aktuální.",
    canShowCurrent: true,
    technicalLabelForbidden: true,
    detail: {
      isToday: true,
      isStale: false,
      isLimited: false,
      isManual: false,
      dailyCycleStatus: cycleStatus,
      daysSince: 0,
    },
  };
}

/**
 * Forbidden visible terms specific to briefing truth-status surface.
 * Render-time check; complements visibleClinicalTextGuard.
 */
export const P12_FORBIDDEN_BRIEFING_TERMS: readonly string[] = [
  "SLA záplata",
  "(SLA záplata)",
  "SLA",
  "DB/Pantry",
  "DB/Pantry/Event-ingestion",
  "Event-ingestion",
  "event_ingestion",
  "Pantry",
  "backend",
  "pipeline",
  "source_ref",
  "source_kind",
  "payload",
  "generation_method",
  "daily_cycle_status",
  "Limitovaný ranní přehled",
  "Aktuální (SLA",
  "Aktuální (auto)",
  "Aktuální (manuální)",
  // P15 — watchdog terminology must never appear in user-visible text
  "watchdog",
  "Watchdog",
  "sla_watchdog",
  "sla_watchdog_repair",
  "watchdog_limited_repair",
] as const;

/** Count occurrences of any forbidden term in a string (case-sensitive for codes, case-insensitive for prose). */
export function countForbiddenBriefingTerms(text: string): number {
  let n = 0;
  const lower = text.toLowerCase();
  for (const term of P12_FORBIDDEN_BRIEFING_TERMS) {
    if (term.includes("_") || term === "SLA" || term.includes("/")) {
      // case-sensitive for codes / acronyms / paths
      if (text.includes(term)) n += 1;
    } else if (lower.includes(term.toLowerCase())) {
      n += 1;
    }
  }
  return n;
}

/**
 * Detect logically contradictory phrasings (e.g. "Aktuální" + "starý přehled").
 * Returns the number of contradictions found.
 */
export function countBriefingContradictions(text: string): number {
  const t = text;
  const lower = t.toLowerCase();
  const hasAktualni = /aktuáln[íi]/i.test(t);
  if (!hasAktualni) return 0;
  let n = 0;
  if (/star[ýá]\s+přehled/i.test(t)) n += 1;
  if (/dnešní\s+přehled\s+zatím\s+nevznikl/i.test(t)) n += 1;
  if (/denní\s+cyklus\s+nedoběhl/i.test(t)) n += 1;
  if (/náhradní\s+omezený\s+přehled/i.test(t)) n += 1;
  if (lower.includes("limited")) n += 1;
  return n;
}
