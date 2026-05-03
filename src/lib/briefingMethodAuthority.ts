/**
 * P15 — Briefing Method Authority (frontend mirror)
 * ─────────────────────────────────────────────────
 * Same rules as supabase/functions/_shared/briefingMethodAuthority.ts.
 * Kept as separate file because frontend cannot import from edge functions.
 *
 * Used by:
 *   - src/lib/briefingTruthStatus.ts  (decides Aktuální vs Náhradní)
 *   - src/lib/visibleClinicalTextGuard.ts  (forbids "watchdog" word leakage)
 *   - src/test/p15WatchdogIsNotPrimary.test.ts
 */

export const PRIMARY_BRIEFING_METHODS: ReadonlySet<string> = new Set([
  "auto",
  "primary_orchestrator",
  "primary_morning_orchestrator",
]);

export const WATCHDOG_BRIEFING_METHODS: ReadonlySet<string> = new Set([
  "sla_watchdog",
  "sla_watchdog_repair",
  "auto_repair_after_missed_morning",
  "auto_sla_test",
  "watchdog_limited_repair",
  "synthetic_repair_not_accepted",
]);

export type BriefingMethodCategory = "primary" | "watchdog" | "manual" | "unknown";

export function categorizeBriefingMethod(
  method: string | null | undefined,
): BriefingMethodCategory {
  const m = String(method ?? "").toLowerCase().trim();
  if (!m) return "unknown";
  if (PRIMARY_BRIEFING_METHODS.has(m)) return "primary";
  if (WATCHDOG_BRIEFING_METHODS.has(m)) return "watchdog";
  if (m === "manual" || m.startsWith("manual_") || m.startsWith("manual-")) return "manual";
  return "unknown";
}

export const isPrimaryBriefingMethod = (m: string | null | undefined): boolean =>
  categorizeBriefingMethod(m) === "primary";

export const isWatchdogBriefingMethod = (m: string | null | undefined): boolean =>
  categorizeBriefingMethod(m) === "watchdog";

export const isManualBriefingMethod = (m: string | null | undefined): boolean =>
  categorizeBriefingMethod(m) === "manual";
