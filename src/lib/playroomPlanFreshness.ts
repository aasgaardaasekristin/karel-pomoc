/**
 * HOTFIX 1.6 — freshness gate pro Plán dnešní herny.
 *
 * Hotfix 1.5 kontroloval pouze `briefing.briefing_date === today`. Selhal proto,
 * že briefing byl z dnešního dne, ale `urgency_breakdown.playroom_plan` byl
 * canonical-loadnutý ze včerejšího řádku `did_daily_session_plans`
 * (dnešní řádek měl prázdný therapeutic_program → fallback na nejlepší starší).
 *
 * Tato funkce se proto ptá samotného plánu, ne briefingu:
 *   - `plan.plan_date` MUSÍ být dnešní Europe/Prague datum (YYYY-MM-DD)
 *   - `plan.therapeutic_program` MUSÍ být ne-prázdné pole
 *
 * Pure: žádný React, žádný Supabase, deterministická.
 */
import { pragueTodayISO } from "./dateOnlyTaskHelpers";

export interface PlayroomPlanFreshnessInput {
  plan_date?: string | null;
  therapeutic_program?: unknown;
}

export function isPlayroomPlanFreshForToday(
  plan: PlayroomPlanFreshnessInput | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!plan) return false;
  const today = pragueTodayISO(now);
  const planDate = typeof plan.plan_date === "string" ? plan.plan_date.slice(0, 10) : "";
  if (planDate !== today) return false;
  const program = plan.therapeutic_program;
  return Array.isArray(program) && program.length > 0;
}
