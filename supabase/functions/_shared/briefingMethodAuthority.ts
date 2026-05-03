// @ts-nocheck
/**
 * P15 — Briefing Method Authority
 * ─────────────────────────────────
 * Single source of truth for distinguishing PRIMARY morning briefing methods
 * from WATCHDOG fallback methods.
 *
 * ARCHITECTURAL RULE (P15_primary_morning_orchestrator_and_watchdog_role_split):
 *
 *   PRIMARY methods are produced by the authoritative morning pipeline
 *   (cron 62: karel-did-daily-briefing method="auto", or future
 *   "primary_orchestrator"). They MAY appear as "Aktuální" in UI and MAY
 *   make P6 morning_karel_briefing = ok.
 *
 *   WATCHDOG methods (sla_watchdog, sla_watchdog_repair, ...) are produced
 *   by fallback monitors. They MUST:
 *     - have payload.limited = true
 *     - have payload.limited_reason
 *     - be reported as "watchdog_limited_repair" generation_method category
 *     - NEVER appear as "Aktuální" in UI (badge = "Náhradní omezený přehled")
 *     - NEVER make P6 morning_karel_briefing = ok (status = degraded)
 *
 *   MANUAL methods (manual, manual_*) are user-initiated and shown as
 *   "Ruční přehled" — never "Aktuální".
 */

export const PRIMARY_BRIEFING_METHODS = new Set([
  "auto",
  "primary_orchestrator",
  "primary_morning_orchestrator",
]);

export const WATCHDOG_BRIEFING_METHODS = new Set([
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

/**
 * For watchdog-produced briefings, enforce the limited contract on the
 * payload. Returns a NEW payload object (does not mutate input).
 */
export function enforceWatchdogLimitedContract(
  payload: Record<string, unknown> | null | undefined,
  reason: string,
): Record<string, unknown> {
  const base = (payload && typeof payload === "object") ? { ...payload } : {};
  base.limited = true;
  base.limited_reason = reason || (base.limited_reason as string) || "produced_by_watchdog_fallback";
  base.produced_by = "watchdog_fallback";
  return base;
}
